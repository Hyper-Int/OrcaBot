//! VM image staging and decompression utilities.
//!
//! Handles extracting bundled VM images from app resources to
//! the app data directory, with smart caching based on file
//! modification times and sizes.

use super::VMError;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Stage a VM image from resources to the app data directory.
///
/// If the source is gzip-compressed (.gz), it will be decompressed.
/// Uses smart caching: only extracts if source is newer or sizes differ.
pub fn stage_image(src: &Path, dest: &Path) -> Result<PathBuf, VMError> {
    let is_gzipped = src.extension().map_or(false, |e| e == "gz");

    let dest_path = if is_gzipped {
        // Remove .gz extension for destination
        let stem = src.file_stem().unwrap_or_default();
        dest.join(stem)
    } else {
        dest.join(src.file_name().unwrap_or_default())
    };

    if needs_staging(src, &dest_path)? {
        // Ensure destination directory exists
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }

        if is_gzipped {
            decompress_gzip(src, &dest_path)?;
        } else {
            copy_file(src, &dest_path)?;
        }
    }

    Ok(dest_path)
}

/// Check if staging is needed based on modification time and size.
fn needs_staging(src: &Path, dest: &Path) -> Result<bool, VMError> {
    let src_meta = fs::metadata(src)?;

    match fs::metadata(dest) {
        Ok(dest_meta) => {
            let src_modified = src_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let dest_modified = dest_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);

            // Re-stage if source is newer
            if src_modified > dest_modified {
                return Ok(true);
            }

            // For non-gzipped files, also check size
            if !src.extension().map_or(false, |e| e == "gz") && src_meta.len() != dest_meta.len() {
                return Ok(true);
            }

            Ok(false)
        }
        Err(_) => Ok(true), // Destination doesn't exist
    }
}

/// Decompress a gzip file.
fn decompress_gzip(src: &Path, dest: &Path) -> Result<(), VMError> {
    let src_file = File::open(src)?;
    let reader = BufReader::new(src_file);

    // Use flate2 for gzip decompression
    let mut decoder = flate2::read::GzDecoder::new(reader);

    let dest_file = File::create(dest)?;
    let mut writer = BufWriter::new(dest_file);

    let mut buffer = [0u8; 64 * 1024]; // 64KB buffer
    loop {
        let bytes_read = decoder.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        writer.write_all(&buffer[..bytes_read])?;
    }

    writer.flush()?;
    Ok(())
}

/// Sign vz-helper with virtualization entitlement on macOS.
#[cfg(target_os = "macos")]
fn sign_vz_helper(path: &Path) {
    use std::process::Command;

    // Create temporary entitlements file
    let entitlements_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.virtualization</key>
    <true/>
</dict>
</plist>"#;

    let entitlements_path = path.parent()
        .unwrap_or(Path::new("."))
        .join("vz-helper.entitlements");

    if let Err(e) = fs::write(&entitlements_path, entitlements_content) {
        eprintln!("Warning: Failed to write vz-helper entitlements: {}", e);
        return;
    }

    // Sign the binary with entitlements (ad-hoc signing with -)
    let result = Command::new("codesign")
        .args([
            "--force",
            "--sign", "-",
            "--entitlements", entitlements_path.to_str().unwrap_or_default(),
            path.to_str().unwrap_or_default(),
        ])
        .output();

    match result {
        Ok(output) => {
            if !output.status.success() {
                eprintln!(
                    "Warning: Failed to sign vz-helper: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        Err(e) => {
            eprintln!("Warning: Failed to run codesign: {}", e);
        }
    }

    // Clean up entitlements file
    let _ = fs::remove_file(&entitlements_path);
}

/// Copy a file with progress (for large VM images).
fn copy_file(src: &Path, dest: &Path) -> Result<(), VMError> {
    let src_file = File::open(src)?;
    let mut reader = BufReader::new(src_file);

    let dest_file = File::create(dest)?;
    let mut writer = BufWriter::new(dest_file);

    io::copy(&mut reader, &mut writer)?;
    writer.flush()?;

    // Preserve modification time
    if let Ok(src_meta) = fs::metadata(src) {
        if let Ok(mtime) = src_meta.modified() {
            let _ = filetime::set_file_mtime(dest, filetime::FileTime::from_system_time(mtime));
        }
    }

    Ok(())
}

/// Paths for VM resources based on platform.
pub struct VMResourcePaths {
    /// Path to the main VM image
    pub image: PathBuf,
    /// Path to kernel (macOS only)
    pub kernel: Option<PathBuf>,
    /// Path to initrd (macOS only)
    pub initrd: Option<PathBuf>,
    /// Path to vz-helper binary (macOS only)
    pub vz_helper: Option<PathBuf>,
}

impl VMResourcePaths {
    /// Resolve VM resource paths from the given resource root.
    /// Tries multiple image formats in order of preference.
    pub fn from_resource_root(root: &Path) -> Self {
        #[cfg(target_os = "macos")]
        {
            // macOS: prefer raw disk image for QEMU/VZ boot
            Self {
                image: root.join("vm/sandbox.img"),
                kernel: Some(root.join("vm/vmlinuz")),
                initrd: Some(root.join("vm/initrd.img")),
                vz_helper: Some(root.join("vm/vz-helper")),
            }
        }

        #[cfg(target_os = "windows")]
        {
            // Windows: use rootfs tarball for WSL2 import
            Self {
                image: root.join("vm/sandbox-rootfs.tar.gz"),
                kernel: None,
                initrd: None,
                vz_helper: None,
            }
        }

        #[cfg(target_os = "linux")]
        {
            // Linux: prefer qcow2 for QEMU, fall back to raw image
            let image = if root.join("vm/sandbox.qcow2").exists() {
                root.join("vm/sandbox.qcow2")
            } else {
                root.join("vm/sandbox.img")
            };

            Self {
                image,
                kernel: Some(root.join("vm/vmlinuz")),
                initrd: Some(root.join("vm/initrd.img")),
                vz_helper: None,
            }
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            Self {
                image: root.join("vm/sandbox.img"),
                kernel: None,
                initrd: None,
                vz_helper: None,
            }
        }
    }

}

/// Stage all VM resources to the app data directory.
pub fn stage_vm_resources(
    resource_paths: &VMResourcePaths,
    data_dir: &Path,
) -> Result<VMResourcePaths, VMError> {
    let vm_dir = data_dir.join("vm");
    fs::create_dir_all(&vm_dir)?;

    let staged_image = stage_image(&resource_paths.image, &vm_dir)?;

    let staged_kernel = if let Some(ref kernel) = resource_paths.kernel {
        Some(stage_image(kernel, &vm_dir)?)
    } else {
        None
    };

    let staged_initrd = if let Some(ref initrd) = resource_paths.initrd {
        Some(stage_image(initrd, &vm_dir)?)
    } else {
        None
    };

    let staged_vz_helper = if let Some(ref vz_helper) = resource_paths.vz_helper {
        if vz_helper.exists() {
            let staged = stage_image(vz_helper, &vm_dir)?;
            // Ensure vz-helper is executable and properly signed
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(mut perms) = fs::metadata(&staged).map(|m| m.permissions()) {
                    perms.set_mode(0o755);
                    let _ = fs::set_permissions(&staged, perms);
                }
            }
            // On macOS, re-sign vz-helper with virtualization entitlement
            #[cfg(target_os = "macos")]
            {
                sign_vz_helper(&staged);
            }
            Some(staged)
        } else {
            None
        }
    } else {
        None
    };

    Ok(VMResourcePaths {
        image: staged_image,
        kernel: staged_kernel,
        initrd: staged_initrd,
        vz_helper: staged_vz_helper,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn test_needs_staging_missing_dest() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("test.img");
        std::fs::write(&src, b"test").unwrap();
        let dest = dir.path().join("nonexistent.img");

        assert!(needs_staging(&src, &dest).unwrap());
    }

    #[test]
    fn test_copy_file() {
        let dir = tempdir().unwrap();
        let src = dir.path().join("source.img");
        let dest = dir.path().join("dest.img");

        std::fs::write(&src, b"test content").unwrap();
        copy_file(&src, &dest).unwrap();

        let content = std::fs::read_to_string(&dest).unwrap();
        assert_eq!(content, "test content");
    }
}
