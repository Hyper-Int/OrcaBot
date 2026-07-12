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

/// The port the guest sandbox always binds (baked into the image default; the
/// guest never receives a per-boot override — `config.env` isn't delivered to
/// it). It's the GUEST side of the host→guest port forward; the host side
/// (`VMConfig.sandbox_port`) may be dynamic when 8080 is busy on the host.
pub const SANDBOX_GUEST_PORT: u16 = 8080;

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

/// URL the guest VM uses to reach a service bound to the host's loopback
/// interface (e.g. the controlplane workerd on `127.0.0.1`).
///
/// `10.0.2.2` is QEMU user-mode networking's (SLIRP) alias for the host; it
/// transparently reaches host loopback services. This is correct for the Linux
/// QEMU backend and the macOS QEMU fallback.
///
/// NOTE: the macOS *native* Virtualization.framework backend does NOT route the
/// guest to host loopback at this address. It uses Apple NAT for guest egress
/// and a host→guest vsock forwarder for inbound; there is no guest→host path to
/// a `127.0.0.1` service. Sandbox→controlplane callbacks (integration gateway,
/// domain approvals, execution callbacks) therefore won't reach the host on the
/// native backend unless the controlplane is bound to a guest-reachable
/// interface and `CONTROLPLANE_URL` is set accordingly. See
/// `macos::MacOSVM::start_native`.
pub fn host_loopback_url(port: &str) -> String {
    format!("http://10.0.2.2:{}", port)
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
