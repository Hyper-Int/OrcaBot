//! Windows VM implementation using WSL2.
//!
//! This implementation manages a custom WSL2 distribution containing
//! the sandbox server. WSL2 automatically handles port forwarding
//! from the guest to localhost on the host.

use super::{VMConfig, VMError, VirtualMachine};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const DISTRO_NAME: &str = "orcabot-sandbox";

/// Windows VM using WSL2.
pub struct WslVM {
    /// Child process handle for the sandbox server
    process: Option<Child>,
    /// Configuration used to start the VM
    config: Option<VMConfig>,
    /// Whether the VM is currently running
    running: bool,
    /// Host URL for sandbox access
    sandbox_url: String,
}

impl WslVM {
    pub fn new() -> Self {
        Self {
            process: None,
            config: None,
            running: false,
            sandbox_url: "http://127.0.0.1:8080".to_string(),
        }
    }

    /// Check if WSL2 is available on this system.
    fn is_wsl_available() -> bool {
        Command::new("wsl")
            .arg("--status")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Check if our distro is already installed.
    fn is_distro_installed() -> bool {
        if let Ok(output) = Command::new("wsl").args(["--list", "--quiet"]).output() {
            let list = String::from_utf8_lossy(&output.stdout);
            list.lines().any(|line| line.trim() == DISTRO_NAME)
        } else {
            false
        }
    }

    /// Import a rootfs tarball as a WSL2 distro.
    fn import_distro(tarball_path: &Path, install_dir: &Path) -> Result<(), VMError> {
        // Create install directory
        std::fs::create_dir_all(install_dir)?;

        let output = Command::new("wsl")
            .args([
                "--import",
                DISTRO_NAME,
                install_dir.to_str().unwrap_or_default(),
                tarball_path.to_str().unwrap_or_default(),
                "--version",
                "2",
            ])
            .output()
            .map_err(|e| VMError::StartFailed(format!("Failed to run wsl --import: {}", e)))?;

        if !output.status.success() {
            return Err(VMError::StartFailed(format!(
                "WSL import failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        Ok(())
    }

    /// Convert a Windows path to a WSL path.
    /// e.g., C:\Users\foo\workspace -> /mnt/c/Users/foo/workspace
    fn windows_to_wsl_path(windows_path: &Path) -> String {
        let path_str = windows_path.to_string_lossy();

        // Handle UNC paths (\\?\C:\...)
        let path_str = path_str
            .strip_prefix(r"\\?\")
            .unwrap_or(&path_str)
            .to_string();

        // Convert drive letter and backslashes
        if let Some(rest) = path_str.strip_prefix(|c: char| c.is_ascii_alphabetic()) {
            if let Some(rest) = rest.strip_prefix(':') {
                let drive = path_str.chars().next().unwrap().to_ascii_lowercase();
                let unix_path = rest.replace('\\', "/");
                return format!("/mnt/{}{}", drive, unix_path);
            }
        }

        // Fallback: just replace backslashes
        path_str.replace('\\', "/")
    }

    /// Start the sandbox server inside WSL.
    fn start_sandbox(&mut self, config: &VMConfig) -> Result<(), VMError> {
        let wsl_workspace = Self::windows_to_wsl_path(&config.workspace_path);

        // Build environment string
        let mut env_args = Vec::new();
        env_args.push(format!("PORT={}", config.sandbox_port));
        env_args.push(format!("WORKSPACE_BASE={}", wsl_workspace));

        for (key, value) in &config.env {
            env_args.push(format!("{}={}", key, value));
        }

        let env_string = env_args.join(" ");

        // Start sandbox server
        let child = Command::new("wsl")
            .args([
                "-d",
                DISTRO_NAME,
                "--",
                "sh",
                "-c",
                &format!(
                    "export {} && /usr/local/bin/orcabot-server",
                    env_string
                ),
            ])
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| VMError::StartFailed(format!("Failed to start sandbox in WSL: {}", e)))?;

        self.process = Some(child);
        self.config = Some(config.clone());
        self.running = true;
        self.sandbox_url = format!("http://127.0.0.1:{}", config.sandbox_port);

        Ok(())
    }
}

impl Default for WslVM {
    fn default() -> Self {
        Self::new()
    }
}

impl VirtualMachine for WslVM {
    fn start(&mut self, config: &VMConfig) -> Result<(), VMError> {
        if self.running {
            return Err(VMError::StartFailed("VM is already running".into()));
        }

        // Check WSL availability
        if !Self::is_wsl_available() {
            return Err(VMError::UnsupportedPlatform(
                "WSL2 is not available. Please install WSL2 first: https://aka.ms/wsl2".into(),
            ));
        }

        // Check if distro needs to be installed
        if !Self::is_distro_installed() {
            if !config.image_path.exists() {
                return Err(VMError::ImageNotFound(config.image_path.clone()));
            }

            // Install directory in user's local app data
            let install_dir = std::env::var("LOCALAPPDATA")
                .map(|p| std::path::PathBuf::from(p).join("OrcabotDesktop").join("wsl"))
                .map_err(|_| {
                    VMError::StartFailed("Could not determine LOCALAPPDATA path".into())
                })?;

            eprintln!("Installing WSL2 distro '{}'...", DISTRO_NAME);
            Self::import_distro(&config.image_path, &install_dir)?;
        }

        self.start_sandbox(config)
    }

    fn stop(&mut self) -> Result<(), VMError> {
        // Kill the sandbox process
        if let Some(ref mut child) = self.process {
            let _ = child.kill();
            let _ = child.wait();
        }

        // Optionally terminate the WSL distro to free resources
        let _ = Command::new("wsl")
            .args(["--terminate", DISTRO_NAME])
            .output();

        self.process = None;
        self.running = false;
        Ok(())
    }

    fn is_running(&self) -> bool {
        if let Some(ref child) = self.process {
            // Check if process is still running via tasklist
            Command::new("tasklist")
                .args(["/FI", &format!("PID eq {}", child.id())])
                .output()
                .map(|o| {
                    let output = String::from_utf8_lossy(&o.stdout);
                    output.contains(&child.id().to_string())
                })
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

impl Drop for WslVM {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
