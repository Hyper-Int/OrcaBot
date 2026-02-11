//! Linux VM implementation using QEMU/KVM.
//!
//! This implementation spawns a QEMU process with KVM acceleration.
//! It uses user-mode networking for port forwarding and VirtioFS
//! (via virtiofsd) for shared workspace access.

use super::{VMConfig, VMError, VirtualMachine};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Linux VM using QEMU/KVM.
pub struct QemuVM {
    /// QEMU process handle
    qemu_process: Option<Child>,
    /// virtiofsd process handle (for shared filesystem)
    virtiofsd_process: Option<Child>,
    /// Configuration used to start the VM
    config: Option<VMConfig>,
    /// Whether the VM is currently running
    running: bool,
    /// Host URL for sandbox access
    sandbox_url: String,
    /// Path to virtiofsd socket
    virtiofs_socket: Option<std::path::PathBuf>,
}

impl QemuVM {
    pub fn new() -> Self {
        Self {
            qemu_process: None,
            virtiofsd_process: None,
            config: None,
            running: false,
            sandbox_url: "http://127.0.0.1:8080".to_string(),
            virtiofs_socket: None,
        }
    }

    /// Check if KVM is available.
    fn is_kvm_available() -> bool {
        std::path::Path::new("/dev/kvm").exists()
    }

    /// Check if QEMU is installed.
    fn find_qemu_binary() -> Option<String> {
        for binary in ["qemu-system-x86_64", "qemu-system-aarch64"] {
            if Command::new("which")
                .arg(binary)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                return Some(binary.to_string());
            }
        }
        None
    }

    /// Check if virtiofsd is available.
    fn is_virtiofsd_available() -> bool {
        Command::new("which")
            .arg("virtiofsd")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Start virtiofsd for shared filesystem.
    fn start_virtiofsd(&mut self, workspace_path: &std::path::Path) -> Result<(), VMError> {
        let socket_dir = std::env::temp_dir();
        let socket_path = socket_dir.join(format!("orcabot-virtiofs-{}.sock", std::process::id()));

        // Remove stale socket if exists
        let _ = std::fs::remove_file(&socket_path);

        let child = Command::new("virtiofsd")
            .args([
                &format!("--socket-path={}", socket_path.display()),
                &format!("--shared-dir={}", workspace_path.display()),
                "--cache=auto",
                "--sandbox=chroot",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| VMError::MountFailed(format!("Failed to start virtiofsd: {}", e)))?;

        self.virtiofsd_process = Some(child);
        self.virtiofs_socket = Some(socket_path);

        // Give virtiofsd time to create the socket
        std::thread::sleep(Duration::from_millis(500));

        Ok(())
    }

    /// Build QEMU command with all necessary arguments.
    fn build_qemu_command(&self, config: &VMConfig, use_kvm: bool) -> Command {
        let qemu_binary = Self::find_qemu_binary().unwrap_or_else(|| "qemu-system-x86_64".into());
        let mut cmd = Command::new(&qemu_binary);

        // Machine type and acceleration
        if use_kvm {
            cmd.args(["-enable-kvm"]);
        }
        cmd.args(["-machine", "q35"]);
        cmd.args(["-cpu", if use_kvm { "host" } else { "qemu64" }]);

        // CPU and memory
        cmd.args(["-smp", &config.cpus.to_string()]);
        cmd.args(["-m", &format!("{}M", config.memory_mb())]);

        // Kernel boot (if provided)
        if let Some(ref kernel) = config.kernel_path {
            cmd.args(["-kernel", kernel.to_str().unwrap_or_default()]);
        }
        if let Some(ref initrd) = config.initrd_path {
            cmd.args(["-initrd", initrd.to_str().unwrap_or_default()]);
        }
        if let Some(ref cmdline) = config.kernel_cmdline {
            cmd.args(["-append", cmdline]);
        }

        // Root filesystem (QCOW2 or raw)
        let image_format = if config.image_path.extension().map_or(false, |e| e == "qcow2") {
            "qcow2"
        } else {
            "raw"
        };
        cmd.args([
            "-drive",
            &format!(
                "file={},format={},if=virtio",
                config.image_path.display(),
                image_format
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

        // VirtioFS for shared workspace (if virtiofsd is running)
        if let Some(ref socket_path) = self.virtiofs_socket {
            cmd.args([
                "-chardev",
                &format!("socket,id=char0,path={}", socket_path.display()),
            ]);
            cmd.args(["-device", "vhost-user-fs-pci,chardev=char0,tag=workspace"]);
            // Required for vhost-user
            cmd.args(["-object", "memory-backend-memfd,id=mem,size=2G,share=on"]);
            cmd.args(["-numa", "node,memdev=mem"]);
        } else {
            // Fallback to 9p if virtiofsd isn't available
            cmd.args([
                "-fsdev",
                &format!(
                    "local,id=workspace,path={},security_model=mapped-xattr",
                    config.workspace_path.display()
                ),
            ]);
            cmd.args(["-device", "virtio-9p-pci,fsdev=workspace,mount_tag=workspace"]);
        }

        // No graphics
        cmd.args(["-nographic"]);
        cmd.args(["-serial", "stdio"]);

        // Daemonize option could be added here if needed
        // cmd.args(["-daemonize", "-pidfile", "/tmp/qemu.pid"]);

        cmd
    }
}

impl Default for QemuVM {
    fn default() -> Self {
        Self::new()
    }
}

impl VirtualMachine for QemuVM {
    fn start(&mut self, config: &VMConfig) -> Result<(), VMError> {
        if self.running {
            return Err(VMError::StartFailed("VM is already running".into()));
        }

        // Verify QEMU is available
        if Self::find_qemu_binary().is_none() {
            return Err(VMError::UnsupportedPlatform(
                "QEMU is not installed. Please install qemu-system-x86_64.".into(),
            ));
        }

        if !config.image_path.exists() {
            return Err(VMError::ImageNotFound(config.image_path.clone()));
        }

        let use_kvm = Self::is_kvm_available();
        if !use_kvm {
            eprintln!("Warning: KVM not available, using software emulation (slower)");
        }

        // Start virtiofsd for shared filesystem (if available)
        if Self::is_virtiofsd_available() {
            if let Err(e) = self.start_virtiofsd(&config.workspace_path) {
                eprintln!("Warning: virtiofsd failed to start, falling back to 9p: {}", e);
            }
        } else {
            eprintln!("Warning: virtiofsd not found, using 9p for shared filesystem");
        }

        // Build and start QEMU
        let mut cmd = self.build_qemu_command(config, use_kvm);
        cmd.stdout(Stdio::inherit());
        cmd.stderr(Stdio::inherit());

        let child = cmd.spawn().map_err(|e| {
            VMError::StartFailed(format!("Failed to start QEMU: {}", e))
        })?;

        self.qemu_process = Some(child);
        self.config = Some(config.clone());
        self.running = true;
        self.sandbox_url = format!("http://127.0.0.1:{}", config.sandbox_port);

        Ok(())
    }

    fn stop(&mut self) -> Result<(), VMError> {
        // Stop QEMU
        if let Some(ref mut child) = self.qemu_process {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.qemu_process = None;

        // Stop virtiofsd
        if let Some(ref mut child) = self.virtiofsd_process {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.virtiofsd_process = None;

        // Clean up socket
        if let Some(ref socket) = self.virtiofs_socket {
            let _ = std::fs::remove_file(socket);
        }
        self.virtiofs_socket = None;

        self.running = false;
        Ok(())
    }

    fn is_running(&self) -> bool {
        if let Some(ref child) = self.qemu_process {
            // Check if process is still running
            Command::new("kill")
                .args(["-0", &child.id().to_string()])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        } else {
            false
        }
    }

    fn pid(&self) -> Option<u32> {
        self.qemu_process.as_ref().map(|c| c.id())
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
            std::thread::sleep(Duration::from_millis(500));
        }

        Err(VMError::HealthTimeout(timeout))
    }
}

impl Drop for QemuVM {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
