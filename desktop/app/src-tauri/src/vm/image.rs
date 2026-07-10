//! VM image staging, download-on-demand, and decompression utilities.
//!
//! The multi-GB disk image is NOT bundled in the app — it's fetched on demand
//! per image version and verified against a SHA-256 baked into the binary. The
//! small resources (kernel/initrd/vz-helper) are still staged from the bundle.
//
// REVISION: vm-image-ondemand-v1

use super::VMError;
use sha2::{Digest, Sha256};
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

    stage_image_to(src, &dest_path)?;
    Ok(dest_path)
}

/// Stage `src` to a specific destination file (decompressing if `src` is `.gz`).
/// Mtime-cached against the source signature so re-staging an unchanged source is
/// a no-op.
fn stage_image_to(src: &Path, dest_path: &Path) -> Result<(), VMError> {
    let is_gzipped = src.extension().map_or(false, |e| e == "gz");
    if needs_staging(src, dest_path)? {
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }
        if is_gzipped {
            decompress_gzip(src, dest_path)?;
        } else {
            copy_file(src, dest_path)?;
        }
        // Record the source signature so a later runtime mutation of dest (the VM
        // image boots read-write, so the guest bumps its mtime) never makes a
        // genuinely-updated source look stale and skip re-staging.
        if let Ok(sig) = source_signature(src) {
            let _ = fs::write(stamp_path(dest_path), sig);
        }
    }
    Ok(())
}

/// Stable signature of the SOURCE file (modification time + size).
///
/// Uses NANOSECOND mtime, not seconds: a rebuild that lands in the same wall-clock
/// second as the previous one (fast `SKIP_KERNEL` iterations) keeps the same size
/// for the raw `sandbox.img`, so a seconds-resolution stamp would treat it as
/// "unchanged" and silently boot a stale image. A content hash would be more
/// robust still, but hashing a multi-GB image on every launch is too slow.
fn source_signature(src: &Path) -> Result<String, VMError> {
    let meta = fs::metadata(src)?;
    let mtime_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(format!("{}:{}", mtime_nanos, meta.len()))
}

/// Path of the sidecar stamp file recording the source signature at last stage.
fn stamp_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".stamp");
    PathBuf::from(s)
}

/// Check if staging is needed by comparing the source's signature against the
/// stamp recorded at the last successful stage.
///
/// We deliberately do NOT compare the destination's own mtime: the VM disk image
/// is mounted read-write, so the running guest mutates the staged copy and bumps
/// its mtime past a freshly-rebuilt source — which made the old "source newer"
/// check skip re-staging and silently boot a stale image.
fn needs_staging(src: &Path, dest: &Path) -> Result<bool, VMError> {
    if !dest.exists() {
        return Ok(true);
    }
    let sig = source_signature(src)?;
    match fs::read_to_string(stamp_path(dest)) {
        Ok(recorded) => Ok(recorded.trim() != sig),
        Err(_) => Ok(true), // no stamp (e.g. older install) → re-stage and write one
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
    progress: &dyn Fn(u64, u64),
) -> Result<VMResourcePaths, VMError> {
    let vm_dir = data_dir.join("vm");
    fs::create_dir_all(&vm_dir)?;

    // The disk image is NOT bundled in the app (it would bloat every
    // auto-update), so fetch/adopt it on demand instead of staging from a
    // bundled resource.
    let staged_image = ensure_vm_image(&resource_paths.image, data_dir, progress)?;

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

// ---------------------------------------------------------------------------
// VM image: fetched on demand, not bundled.
//
// The multi-GB disk image would bloat every auto-update if bundled in the .app,
// so it's hosted once per image version and downloaded on first use, verified
// against a SHA-256 baked into this (notarized) binary. Installs that already
// have the image staged adopt it with no download. Source of truth for the
// version + hash + URL is `vm-image.json`, embedded at build time.
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct VmImageManifest {
    /// Image version tag (e.g. "v1"); bumps only when the image content changes.
    pub version: String,
    /// SHA-256 (hex) of the gzipped download artifact.
    pub sha256: String,
    /// Download URL for the gzipped image (sandbox.img.gz).
    pub url: String,
}

/// The image manifest baked into the binary. Updated by
/// `desktop/scripts/publish-vm-image.sh` when a new image is published.
pub fn vm_image_manifest() -> VmImageManifest {
    const MANIFEST: &str = include_str!("../../vm-image.json");
    serde_json::from_str(MANIFEST).expect("vm-image.json is valid JSON")
}

fn read_marker(marker: &Path) -> Option<String> {
    fs::read_to_string(marker).ok().map(|s| s.trim().to_string())
}

/// The image version that pre-versioning installs (before this scheme existed)
/// actually shipped. A marker-less staged image can ONLY be that version, so it
/// may be adopted without a download only while it's still the required version.
const LEGACY_IMAGE_VERSION: &str = "v1";

/// Ensure the VM disk image is present in the data dir and return its path.
///
/// The staged image is named by CONTENT (`sandbox-<token>.img`), never a fixed
/// `sandbox.img`: macOS/Virtualization.framework caches a disk image's SIZE keyed
/// on its path, so reusing one path for images of different sizes makes the guest
/// see the OLD size and truncates the disk — everything the filesystem placed past
/// the cap reads back as garbage ("Exec format error"). A fresh name whenever the
/// content changes sidesteps that cache entirely.
///
/// Resolution order:
///  0. `ORCABOT_VM_IMAGE` dev override → stage that file (named by its signature);
///  1. a local resource image (dev build / bundled) → stage it;
///  2. the versioned image already staged for the manifest version → use it;
///  3. migrate a pre-content-naming `sandbox.img` by renaming it (if it's the
///     required version) — a fresh path also clears any stale size cache;
///  4. otherwise download the gz artifact, verify its SHA-256, decompress.
pub fn ensure_vm_image(
    resource_image: &Path,
    data_dir: &Path,
    progress: &dyn Fn(u64, u64),
) -> Result<PathBuf, VMError> {
    let manifest = vm_image_manifest();
    let vm_dir = data_dir.join("vm");
    fs::create_dir_all(&vm_dir)?;

    // 0. Dev override: ORCABOT_VM_IMAGE forces a specific local image (raw .img or
    //    .gz), bypassing the version check + release download. Named by the source
    //    signature so swapping to an image of a different size lands on a fresh path.
    if let Ok(override_path) = std::env::var("ORCABOT_VM_IMAGE") {
        if !override_path.is_empty() {
            let p = Path::new(&override_path);
            if p.exists() {
                let dest = vm_dir.join(format!("sandbox-ovr-{}.img", local_content_token(p)));
                eprintln!(
                    "[vm-image] ORCABOT_VM_IMAGE override: staging {} -> {}",
                    p.display(),
                    dest.display()
                );
                stage_image_to(p, &dest)?;
                cleanup_stale_images(&vm_dir, &dest);
                return Ok(dest);
            }
            eprintln!(
                "[vm-image] ORCABOT_VM_IMAGE set but file not found: {override_path} — ignoring"
            );
        }
    }

    // 1. Dev / bundled: a local resource image is the source of truth.
    if resource_image.exists() {
        let dest = vm_dir.join(format!("sandbox-res-{}.img", local_content_token(resource_image)));
        stage_image_to(resource_image, &dest)?;
        cleanup_stale_images(&vm_dir, &dest);
        return Ok(dest);
    }

    // Packaged: the image is identified by the manifest version.
    let dest = vm_dir.join(format!("sandbox-{}.img", manifest.version));

    // 2. Already staged for this version.
    if dest.exists() {
        return Ok(dest);
    }

    // 3. Migration: adopt a pre-content-naming `sandbox.img` by renaming it to the
    //    content path (a fresh path clears any stale size cache), if it is the
    //    required version. Avoids a needless re-download on upgrade.
    let legacy = vm_dir.join("sandbox.img");
    if legacy.exists() {
        let marker_ver = read_marker(&vm_dir.join("sandbox.img.version"));
        let is_required = marker_ver.as_deref() == Some(manifest.version.as_str())
            || (marker_ver.is_none() && manifest.version == LEGACY_IMAGE_VERSION);
        if is_required && fs::rename(&legacy, &dest).is_ok() {
            cleanup_stale_images(&vm_dir, &dest);
            return Ok(dest);
        }
    }

    // 4. Download + verify + decompress.
    eprintln!(
        "[vm-image] fetching sandbox image {} from {}",
        manifest.version, manifest.url
    );
    download_and_stage_image(&manifest, &vm_dir, &dest, progress)?;
    cleanup_stale_images(&vm_dir, &dest);
    Ok(dest)
}

/// Short, stable token for a local source image's content: nanosecond mtime + size
/// (via `source_signature`), hashed. Changes whenever the source changes — including
/// its SIZE, the property the stale VZ/macOS disk-size cache keys on. `DefaultHasher`
/// uses fixed keys, so this is deterministic across runs.
fn local_content_token(src: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let sig = source_signature(src).unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    sig.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Remove staged sandbox images + sidecars other than `keep`, so old versions
/// don't accumulate in the data dir. Best-effort.
fn cleanup_stale_images(vm_dir: &Path, keep: &Path) {
    let keep_stamp = stamp_path(keep);
    let Ok(entries) = fs::read_dir(vm_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == *keep || path == keep_stamp {
            continue;
        }
        let name = entry.file_name();
        let n = name.to_string_lossy();
        let stale = n == "sandbox.img"
            || n == "sandbox.img.stamp"
            || n == "sandbox.img.version"
            || n.ends_with(".img.gz.part")
            || (n.starts_with("sandbox-") && (n.ends_with(".img") || n.ends_with(".img.stamp")));
        if stale {
            let _ = fs::remove_file(&path);
        }
    }
}

fn download_and_stage_image(
    manifest: &VmImageManifest,
    vm_dir: &Path,
    target: &Path,
    progress: &dyn Fn(u64, u64),
) -> Result<(), VMError> {
    let tmp_gz = vm_dir.join("sandbox.img.gz.part");

    let resp = ureq::get(&manifest.url)
        .call()
        .map_err(|e| VMError::Download(format!("request failed: {e}")))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Stream to disk, hashing as we go.
    let mut reader = resp.into_reader();
    let mut writer = BufWriter::new(File::create(&tmp_gz)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut downloaded: u64 = 0;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        writer.write_all(&buf[..n])?;
        downloaded += n as u64;
        progress(downloaded, total);
    }
    writer.flush()?;

    let digest = hasher.finalize();
    let got = hex_encode(digest.as_slice());
    if got.to_lowercase() != manifest.sha256.to_lowercase() {
        let _ = fs::remove_file(&tmp_gz);
        return Err(VMError::Download(format!(
            "checksum mismatch: expected {}, got {}",
            manifest.sha256, got
        )));
    }

    // Verified — decompress to a temp file, then atomically rename into place.
    // A crash / disk-full mid-decompress must NOT leave a partial sandbox.img,
    // or a later launch could mistake it for a complete (adoptable) image.
    let tmp_img = vm_dir.join("sandbox.img.part");
    if let Err(e) = decompress_gzip(&tmp_gz, &tmp_img) {
        let _ = fs::remove_file(&tmp_img);
        let _ = fs::remove_file(&tmp_gz);
        return Err(e);
    }
    fs::rename(&tmp_img, target)?;
    let _ = fs::remove_file(&tmp_gz);
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
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
