use std::collections::HashMap;
use std::path::PathBuf;

/// Configuration for starting a virtual machine.
#[derive(Debug, Clone)]
pub struct VMConfig {
    /// Path to the VM image (disk image, rootfs tarball, or kernel depending on platform)
    pub image_path: PathBuf,

    /// Path on host to mount as /workspace in VM
    pub workspace_path: PathBuf,

    /// Number of vCPUs (minimum 2 recommended)
    pub cpus: u32,

    /// Memory in bytes (minimum 2GB recommended)
    pub memory_bytes: u64,

    /// Port to expose from VM to host for sandbox service
    pub sandbox_port: u16,

    /// Environment variables to pass to sandbox process inside VM
    pub env: HashMap<String, String>,

    /// Optional path to kernel image (required for macOS Virtualization.framework)
    pub kernel_path: Option<PathBuf>,

    /// Optional path to initrd image (required for macOS Virtualization.framework)
    pub initrd_path: Option<PathBuf>,

    /// Optional kernel command line arguments
    pub kernel_cmdline: Option<String>,

    /// Optional path to vz-helper binary (macOS Virtualization.framework)
    pub vz_helper_path: Option<PathBuf>,
}

impl VMConfig {
    /// Create a new VMConfig with default values.
    pub fn new(image_path: PathBuf, workspace_path: PathBuf) -> Self {
        Self {
            image_path,
            workspace_path,
            cpus: 2,
            memory_bytes: 2 * 1024 * 1024 * 1024, // 2GB
            sandbox_port: 8080,
            env: HashMap::new(),
            kernel_path: None,
            initrd_path: None,
            kernel_cmdline: None,
            vz_helper_path: None,
        }
    }

    /// Set the number of vCPUs.
    pub fn with_cpus(mut self, cpus: u32) -> Self {
        self.cpus = cpus;
        self
    }

    /// Set memory in bytes.
    pub fn with_memory(mut self, bytes: u64) -> Self {
        self.memory_bytes = bytes;
        self
    }

    /// Set the sandbox port.
    pub fn with_port(mut self, port: u16) -> Self {
        self.sandbox_port = port;
        self
    }

    /// Add an environment variable.
    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    /// Set kernel path (for direct kernel boot on macOS).
    pub fn with_kernel(mut self, path: PathBuf) -> Self {
        self.kernel_path = Some(path);
        self
    }

    /// Set initrd path (for direct kernel boot on macOS).
    pub fn with_initrd(mut self, path: PathBuf) -> Self {
        self.initrd_path = Some(path);
        self
    }

    /// Set kernel command line.
    pub fn with_cmdline(mut self, cmdline: impl Into<String>) -> Self {
        self.kernel_cmdline = Some(cmdline.into());
        self
    }

    /// Set vz-helper binary path (macOS Virtualization.framework).
    pub fn with_vz_helper(mut self, path: PathBuf) -> Self {
        self.vz_helper_path = Some(path);
        self
    }

    /// Memory in megabytes (convenience method).
    pub fn memory_mb(&self) -> u64 {
        self.memory_bytes / (1024 * 1024)
    }
}

impl Default for VMConfig {
    fn default() -> Self {
        Self {
            image_path: PathBuf::new(),
            workspace_path: PathBuf::new(),
            cpus: 2,
            memory_bytes: 2 * 1024 * 1024 * 1024,
            sandbox_port: 8080,
            env: HashMap::new(),
            kernel_path: None,
            initrd_path: None,
            kernel_cmdline: None,
            vz_helper_path: None,
        }
    }
}
