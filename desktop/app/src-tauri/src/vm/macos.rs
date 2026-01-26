//! macOS VM implementation using Apple Virtualization.framework.
//!
//! This implementation uses native macOS Virtualization.framework to boot
//! a Linux VM with direct kernel boot (vmlinuz + initrd) and VirtioFS
//! for shared workspace access.
//!
//! Requirements:
//! - macOS 13.0 (Ventura) or later
//! - com.apple.security.virtualization entitlement
//! - Bootable disk image with kernel and initrd

use super::{VMConfig, VMError, VirtualMachine};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// macOS VM using Virtualization.framework.
///
/// On macOS 13+, uses native Virtualization.framework for optimal performance.
/// Falls back to QEMU with HVF acceleration if VZ is unavailable.
pub struct MacOSVM {
    /// Child process handle (for helper process or QEMU fallback)
    process: Option<Child>,
    /// Configuration used to start the VM
    config: Option<VMConfig>,
    /// Whether the VM is currently running
    running: bool,
    /// Host URL for sandbox access
    sandbox_url: String,
    /// Whether using native VZ or QEMU fallback
    using_native_vz: bool,
}

impl MacOSVM {
    pub fn new() -> Self {
        Self {
            process: None,
            config: None,
            running: false,
            sandbox_url: "http://127.0.0.1:8080".to_string(),
            using_native_vz: false,
        }
    }

    /// Check if Virtualization.framework is available.
    /// Requires macOS 13+ and the virtualization entitlement.
    fn is_vz_available() -> bool {
        // Check macOS version (13.0+)
        if let Ok(output) = Command::new("sw_vers")
            .arg("-productVersion")
            .output()
        {
            let version = String::from_utf8_lossy(&output.stdout);
            if let Some(major) = version.trim().split('.').next() {
                if let Ok(major_num) = major.parse::<u32>() {
                    return major_num >= 13;
                }
            }
        }
        false
    }

    /// Check if QEMU is available (fallback).
    fn is_qemu_available() -> bool {
        let binary = if cfg!(target_arch = "aarch64") {
            "qemu-system-aarch64"
        } else {
            "qemu-system-x86_64"
        };

        Command::new("which")
            .arg(binary)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Start VM using native Virtualization.framework via Swift helper.
    ///
    /// This spawns a small Swift helper process that manages the VZ VM,
    /// since direct Rust bindings to Virtualization.framework are immature.
    fn start_native(&mut self, config: &VMConfig) -> Result<(), VMError> {
        // Use vz_helper_path from config if provided, otherwise try to find it
        let helper_path = if let Some(ref path) = config.vz_helper_path {
            path.clone()
        } else {
            // Fallback: look relative to image path
            let fallback = config
                .image_path
                .parent()
                .unwrap_or(Path::new("."))
                .join("vz-helper");
            fallback
        };

        if !helper_path.exists() {
            return Err(VMError::StartFailed(format!(
                "Virtualization.framework helper not found at {}. Falling back to QEMU.",
                helper_path.display()
            )));
        }

        let kernel_path = config
            .kernel_path
            .as_ref()
            .ok_or_else(|| VMError::StartFailed("Kernel path required for VZ".into()))?;

        let initrd_path = config
            .initrd_path
            .as_ref()
            .ok_or_else(|| VMError::StartFailed("Initrd path required for VZ".into()))?;

        let cmdline = config
            .kernel_cmdline
            .as_ref()
            .map(|s| s.as_str())
            .unwrap_or("console=hvc0 root=/dev/vda rw");

        let mut cmd = Command::new(&helper_path);
        cmd.args([
            "--kernel",
            kernel_path.to_str().unwrap_or_default(),
            "--initrd",
            initrd_path.to_str().unwrap_or_default(),
            "--disk",
            config.image_path.to_str().unwrap_or_default(),
            "--cmdline",
            cmdline,
            "--cpus",
            &config.cpus.to_string(),
            "--memory",
            &config.memory_mb().to_string(),
            "--share",
            &format!(
                "workspace:{}",
                config.workspace_path.display()
            ),
            // Port forward via vsock: host TCP port -> guest vsock port
            // The guest runs socat to bridge vsock:port -> localhost:port
            "--port-forward",
            &format!("{}:{}", config.sandbox_port, config.sandbox_port),
        ]);

        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());

        let child = cmd.spawn().map_err(|e| {
            VMError::StartFailed(format!("Failed to start VZ helper: {}", e))
        })?;

        self.process = Some(child);
        self.config = Some(config.clone());
        self.running = true;
        self.using_native_vz = true;
        self.sandbox_url = format!("http://127.0.0.1:{}", config.sandbox_port);

        Ok(())
    }

    /// Start VM using QEMU with HVF acceleration (fallback).
    fn start_qemu(&mut self, config: &VMConfig) -> Result<(), VMError> {
        let qemu_binary = if cfg!(target_arch = "aarch64") {
            "qemu-system-aarch64"
        } else {
            "qemu-system-x86_64"
        };

        let mut cmd = Command::new(qemu_binary);

        // Machine type with HVF acceleration
        if cfg!(target_arch = "aarch64") {
            cmd.args(["-machine", "virt,accel=hvf,highmem=on"]);
            cmd.args(["-cpu", "host"]);
        } else {
            cmd.args(["-machine", "q35,accel=hvf"]);
            cmd.args(["-cpu", "host"]);
        }

        // CPU and memory
        cmd.args(["-smp", &config.cpus.to_string()]);
        cmd.args(["-m", &format!("{}M", config.memory_mb())]);

        // Kernel boot (direct boot without bootloader)
        if let Some(ref kernel) = config.kernel_path {
            cmd.args(["-kernel", kernel.to_str().unwrap_or_default()]);
        }
        if let Some(ref initrd) = config.initrd_path {
            cmd.args(["-initrd", initrd.to_str().unwrap_or_default()]);
        }
        if let Some(ref cmdline) = config.kernel_cmdline {
            cmd.args(["-append", cmdline]);
        }

        // Root filesystem
        cmd.args([
            "-drive",
            &format!(
                "file={},format=raw,if=virtio",
                config.image_path.display()
            ),
        ]);

        // Network with port forwarding
        cmd.args([
            "-netdev",
            &format!(
                "user,id=net0,hostfwd=tcp::{}-:{}",
                config.sandbox_port, config.sandbox_port
            ),
        ]);
        cmd.args(["-device", "virtio-net-pci,netdev=net0"]);

        // 9p shared filesystem (VirtioFS requires virtiofsd which is complex on macOS)
        cmd.args([
            "-fsdev",
            &format!(
                "local,id=workspace,path={},security_model=mapped-xattr",
                config.workspace_path.display()
            ),
        ]);
        cmd.args(["-device", "virtio-9p-pci,fsdev=workspace,mount_tag=workspace"]);

        // No graphics, serial console
        cmd.args(["-nographic"]);
        cmd.args(["-serial", "stdio"]);

        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());

        let child = cmd.spawn().map_err(|e| {
            VMError::StartFailed(format!("Failed to start QEMU: {}", e))
        })?;

        self.process = Some(child);
        self.config = Some(config.clone());
        self.running = true;
        self.using_native_vz = false;
        self.sandbox_url = format!("http://127.0.0.1:{}", config.sandbox_port);

        Ok(())
    }
}

impl Default for MacOSVM {
    fn default() -> Self {
        Self::new()
    }
}

impl VirtualMachine for MacOSVM {
    fn start(&mut self, config: &VMConfig) -> Result<(), VMError> {
        if self.running {
            return Err(VMError::StartFailed("VM is already running".into()));
        }

        // Validate disk image exists
        if !config.image_path.exists() {
            return Err(VMError::ImageNotFound(config.image_path.clone()));
        }

        // Prefer Virtualization.framework with vsock port forwarding (no QEMU needed)
        if Self::is_vz_available() {
            eprintln!("Starting sandbox VM using Virtualization.framework with vsock...");
            match self.start_native(config) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    eprintln!("VZ failed: {}", e);
                }
            }
        }

        // Fall back to QEMU if VZ is not available
        if Self::is_qemu_available() {
            eprintln!("Starting sandbox VM using QEMU with HVF (fallback)...");
            return self.start_qemu(config);
        }

        Err(VMError::UnsupportedPlatform(
            "No VM backend available. macOS 13+ required for Virtualization.framework.".into(),
        ))
    }

    fn stop(&mut self) -> Result<(), VMError> {
        if let Some(ref mut child) = self.process {
            let _ = child.kill();
            let _ = child.wait();
        }

        self.process = None;
        self.running = false;
        Ok(())
    }

    fn is_running(&self) -> bool {
        if let Some(ref child) = self.process {
            Command::new("kill")
                .args(["-0", &child.id().to_string()])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        } else {
            false
        }
    }

    fn sandbox_url(&self) -> Option<String> {
        if self.running {
            Some(self.sandbox_url.clone())
        } else {
            None
        }
    }

    fn wait_for_health(&self, timeout: Duration) -> Result<(), VMError> {
        let start = Instant::now();
        let addr = format!(
            "127.0.0.1:{}",
            self.config
                .as_ref()
                .map(|c| c.sandbox_port)
                .unwrap_or(8080)
        );

        let mut delay = Duration::from_millis(500);
        let max_delay = Duration::from_secs(5);
        while start.elapsed() < timeout {
            if let Ok(mut stream) = TcpStream::connect(&addr) {
                let _ = stream.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n");
                let mut buf = [0u8; 256];
                if stream.read(&mut buf).is_ok() {
                    let response = String::from_utf8_lossy(&buf);
                    if response.contains("200 OK") || response.contains("ok") {
                        return Ok(());
                    }
                }
            }
            std::thread::sleep(delay);
            delay = std::cmp::min(delay * 2, max_delay);
        }

        Err(VMError::HealthTimeout(timeout))
    }
}

impl Drop for MacOSVM {
    fn drop(&mut self) {
        if let Some(ref mut child) = self.process {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
