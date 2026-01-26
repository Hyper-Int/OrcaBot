use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug)]
pub enum VMError {
    ImageNotFound(PathBuf),
    StartFailed(String),
    StopFailed(String),
    HealthTimeout(Duration),
    MountFailed(String),
    UnsupportedPlatform(String),
    Io(std::io::Error),
}

impl std::fmt::Display for VMError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VMError::ImageNotFound(path) => write!(f, "VM image not found: {}", path.display()),
            VMError::StartFailed(msg) => write!(f, "Failed to start VM: {}", msg),
            VMError::StopFailed(msg) => write!(f, "Failed to stop VM: {}", msg),
            VMError::HealthTimeout(duration) => {
                write!(f, "VM health check failed after {:?}", duration)
            }
            VMError::MountFailed(msg) => write!(f, "Shared filesystem mount failed: {}", msg),
            VMError::UnsupportedPlatform(platform) => {
                write!(f, "Platform not supported: {}", platform)
            }
            VMError::Io(err) => write!(f, "IO error: {}", err),
        }
    }
}

impl std::error::Error for VMError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            VMError::Io(err) => Some(err),
            _ => None,
        }
    }
}

impl From<std::io::Error> for VMError {
    fn from(err: std::io::Error) -> Self {
        VMError::Io(err)
    }
}
