//! Virtual machine abstraction for running the sandbox server.
//!
//! This module provides a platform-agnostic interface for managing VMs:
//! - macOS: Apple Virtualization.framework
//! - Windows: WSL2
//! - Linux: QEMU/KVM

pub mod config;
pub mod error;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "linux")]
pub mod linux;

pub mod image;

pub use config::VMConfig;
pub use error::VMError;

use std::time::Duration;

/// Trait for platform-specific VM implementations.
pub trait VirtualMachine: Send + Sync {
    /// Start the VM with the given configuration.
    fn start(&mut self, config: &VMConfig) -> Result<(), VMError>;

    /// Stop the VM gracefully (with timeout fallback to force kill).
    fn stop(&mut self) -> Result<(), VMError>;

    /// Check if the VM is running.
    fn is_running(&self) -> bool;

    /// Get the PID of the VM process (for PID file tracking).
    fn pid(&self) -> Option<u32>;

    /// Get the host-accessible URL for the sandbox service.
    fn sandbox_url(&self) -> Option<String>;

    /// Wait for the sandbox health endpoint to respond.
    fn wait_for_health(&self, timeout: Duration) -> Result<(), VMError>;
}

/// Create a platform-specific VM instance.
pub fn create_platform_vm() -> Box<dyn VirtualMachine> {
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacOSVM::new())
    }

    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WslVM::new())
    }

    #[cfg(target_os = "linux")]
    {
        Box::new(linux::QemuVM::new())
    }
}

/// Get the name of the current VM backend.
pub fn vm_backend_name() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Virtualization.framework"
    }

    #[cfg(target_os = "windows")]
    {
        "WSL2"
    }

    #[cfg(target_os = "linux")]
    {
        "QEMU/KVM"
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "unsupported"
    }
}
