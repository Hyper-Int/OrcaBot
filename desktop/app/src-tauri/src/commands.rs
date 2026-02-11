// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: folder-import-v7-safe-dir-win-nofollow
const MODULE_REVISION: &str = "folder-import-v7-safe-dir-win-nofollow";

use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::Emitter;
use walkdir::WalkDir;

/// Managed state holding the workspace directory path.
pub struct WorkspaceState {
    pub workspace_path: PathBuf,
}

#[derive(Serialize, Clone)]
pub struct WorkspaceInfo {
    pub path: String,
    pub exists: bool,
}

#[derive(Serialize, Clone)]
pub struct ImportResult {
    pub import_id: String,
    pub files_copied: u64,
    pub bytes_copied: u64,
    pub dest_path: String,
    pub errors: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ImportProgress {
    pub import_id: String,
    pub processed: u64,
    pub total: u64,
    pub current_file: String,
    pub phase: String, // "scanning" | "copying" | "done" | "error"
}

/// Validate that a subpath is safe to join under a root directory.
/// Rejects absolute paths, `..` components, and anything that would escape the root.
fn validate_subpath(subpath: &str) -> Result<PathBuf, String> {
    let path = Path::new(subpath);

    // Reject absolute paths
    if path.is_absolute() {
        return Err(format!(
            "Destination subpath must be relative, got absolute: {}",
            subpath
        ));
    }

    // Reject any `..` or prefix components
    for component in path.components() {
        match component {
            Component::ParentDir => {
                return Err(format!(
                    "Destination subpath must not contain '..': {}",
                    subpath
                ));
            }
            Component::Prefix(_) => {
                return Err(format!(
                    "Destination subpath must not contain drive prefixes: {}",
                    subpath
                ));
            }
            _ => {}
        }
    }

    Ok(path.to_path_buf())
}

/// Verify that a logical destination path stays within the workspace root
/// WITHOUT creating any directories or following symlinks.
///
/// Walks the existing prefix of the path, canonicalizing each real component
/// to resolve any symlinks already on disk. The remaining (non-existent)
/// components are validated to be plain names (no `..'). This catches:
/// - Existing symlinks inside workspace that point outside
/// - Path traversal via `..` in the non-existent tail
fn ensure_within_workspace(dest: &Path, workspace: &Path) -> Result<(), String> {
    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|e| format!("Cannot resolve workspace path: {}", e))?;

    // Walk from the workspace root down through each component of the relative
    // path. For each component, if it exists on disk, canonicalize to resolve
    // any symlinks; if it doesn't exist yet, just validate the name is safe.
    let rel = dest
        .strip_prefix(workspace)
        .map_err(|_| format!("Path {} is not under workspace {}", dest.display(), workspace.display()))?;

    let mut current = canonical_workspace.clone();
    for component in rel.components() {
        match component {
            Component::Normal(name) => {
                let next = current.join(name);
                if next.exists() {
                    // Resolve symlinks for this existing segment
                    current = next.canonicalize().map_err(|e| {
                        format!("Cannot resolve {}: {}", next.display(), e)
                    })?;
                    // After resolving, verify we're still inside workspace
                    if !current.starts_with(&canonical_workspace) {
                        return Err(format!(
                            "Symlink at {} resolves to {} which is outside workspace",
                            next.display(),
                            current.display()
                        ));
                    }
                } else {
                    // Component doesn't exist yet; just extend the logical path.
                    // It will be created by create_dir_all later (which is safe
                    // because all ancestor components have been verified).
                    current = current.join(name);
                }
            }
            Component::ParentDir => {
                return Err(format!(
                    "Path contains '..' component: {}",
                    dest.display()
                ));
            }
            _ => {
                // RootDir, CurDir, Prefix — shouldn't appear in a relative path
                return Err(format!(
                    "Unexpected path component in: {}",
                    dest.display()
                ));
            }
        }
    }

    Ok(())
}

/// Create parent directories for a destination file, then verify the created
/// path is still within the workspace. This is the safe sequence: validate
/// first with ensure_within_workspace (no side effects), then create dirs,
/// then re-verify the canonical path hasn't escaped via a TOCTOU race.
fn safe_create_parent_dirs(dest: &Path, workspace: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;

        // Post-creation verification: canonicalize and check containment
        let canonical_workspace = workspace
            .canonicalize()
            .map_err(|e| format!("Cannot resolve workspace: {}", e))?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| format!("Cannot resolve created parent: {}", e))?;

        if !canonical_parent.starts_with(&canonical_workspace) {
            // Clean up the escaped directory
            let _ = std::fs::remove_dir_all(parent);
            return Err(format!(
                "Created directory {} resolves outside workspace to {}",
                parent.display(),
                canonical_parent.display()
            ));
        }
    }
    Ok(())
}

/// Create a directory (and parents) within the workspace, then verify containment.
/// Catches TOCTOU races where a parent is swapped to a symlink between
/// ensure_within_workspace and the actual mkdir.
fn safe_create_dir(dir: &Path, workspace: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create directory {}: {}", dir.display(), e))?;

    let canonical_workspace = workspace
        .canonicalize()
        .map_err(|e| format!("Cannot resolve workspace: {}", e))?;
    let canonical_dir = dir
        .canonicalize()
        .map_err(|e| format!("Cannot resolve created directory {}: {}", dir.display(), e))?;

    if !canonical_dir.starts_with(&canonical_workspace) {
        let _ = std::fs::remove_dir_all(dir);
        return Err(format!(
            "Created directory {} resolves outside workspace to {}",
            dir.display(),
            canonical_dir.display()
        ));
    }

    Ok(())
}

/// Copy a file without following symlinks at the destination.
///
/// On Unix, opens the destination with O_NOFOLLOW so that if an attacker swaps
/// the path to a symlink between validation and write, the open fails with ELOOP
/// instead of writing through the symlink to an arbitrary location.
#[cfg(unix)]
fn safe_copy_file(source: &Path, dest: &Path) -> Result<u64, String> {
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::unix::fs::OpenOptionsExt;

    let mut src = File::open(source)
        .map_err(|e| format!("Cannot open source {}: {}", source.display(), e))?;

    let mut dst = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dest)
        .map_err(|e| format!("Cannot open destination {} (symlink?): {}", dest.display(), e))?;

    io::copy(&mut src, &mut dst)
        .map_err(|e| format!("Copy failed {}: {}", dest.display(), e))
}

/// On Windows, pre/post-check with symlink_metadata to reject junctions and
/// reparse points. Not perfectly race-free but narrows the TOCTOU window
/// significantly combined with the caller's containment checks.
#[cfg(windows)]
fn safe_copy_file(source: &Path, dest: &Path) -> Result<u64, String> {
    // Pre-check: reject if destination is a symlink/junction
    if let Ok(meta) = std::fs::symlink_metadata(dest) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Destination is a symlink/junction: {}",
                dest.display()
            ));
        }
    }

    let bytes = std::fs::copy(source, dest)
        .map_err(|e| format!("Copy failed {}: {}", dest.display(), e))?;

    // Post-check: detect if dest was swapped to a symlink during copy
    if let Ok(meta) = std::fs::symlink_metadata(dest) {
        if meta.file_type().is_symlink() {
            let _ = std::fs::remove_file(dest);
            return Err(format!(
                "Destination became a symlink during copy: {}",
                dest.display()
            ));
        }
    }

    Ok(bytes)
}

#[cfg(not(any(unix, windows)))]
fn safe_copy_file(source: &Path, dest: &Path) -> Result<u64, String> {
    std::fs::copy(source, dest)
        .map_err(|e| format!("Copy failed {}: {}", dest.display(), e))
}

/// Returns the workspace directory path and whether it exists.
#[tauri::command]
pub async fn get_workspace_path(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<WorkspaceInfo, String> {
    Ok(WorkspaceInfo {
        path: state.workspace_path.display().to_string(),
        exists: state.workspace_path.exists(),
    })
}

/// Import a folder (or file) from source_path into the workspace.
///
/// - If source is a directory, recursively copies all contents into
///   `{workspace}/{dest_subpath}/{folder_name}/`.
/// - If source is a file, copies it into `{workspace}/{dest_subpath}/`.
/// - Conflicts: merge with overwrite (existing files replaced, others untouched).
/// - Emits "folder-import-progress" events for UI progress tracking.
///
/// Security: dest_subpath is validated to prevent workspace escape.
/// Symlinks in the source tree are NOT followed to prevent importing
/// files outside the user's chosen folder.
#[tauri::command]
pub async fn import_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, WorkspaceState>,
    source_path: String,
    dest_subpath: Option<String>,
) -> Result<ImportResult, String> {
    // Fail closed: reject if workspace path is empty or doesn't exist
    if state.workspace_path.as_os_str().is_empty() {
        return Err("Workspace path not configured".to_string());
    }
    if !state.workspace_path.exists() {
        return Err(format!(
            "Workspace directory does not exist: {}",
            state.workspace_path.display()
        ));
    }

    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err(format!("Source not found: {}", source_path));
    }

    // Validate dest_subpath before proceeding
    if let Some(ref sub) = dest_subpath {
        validate_subpath(sub)?;
    }

    // Generate a unique import ID for correlating progress events
    let import_id = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    let workspace = state.workspace_path.clone();
    let app_handle = app.clone();

    // Run the heavy copy work on a blocking thread
    tauri::async_runtime::spawn_blocking(move || {
        do_import(&app_handle, &source, &workspace, dest_subpath.as_deref(), &import_id)
    })
    .await
    .map_err(|e| format!("Import task failed: {}", e))?
}

fn emit_error(app: &tauri::AppHandle, import_id: &str, message: &str) {
    let _ = app.emit(
        "folder-import-progress",
        ImportProgress {
            import_id: import_id.to_string(),
            processed: 0,
            total: 0,
            current_file: message.to_string(),
            phase: "error".to_string(),
        },
    );
}

fn do_import(
    app: &tauri::AppHandle,
    source: &Path,
    workspace: &Path,
    dest_subpath: Option<&str>,
    import_id: &str,
) -> Result<ImportResult, String> {
    eprintln!(
        "[commands] REVISION: {} - import_folder called at {}",
        MODULE_REVISION,
        chrono_now()
    );

    // Build destination base with path safety check
    let dest_base = if let Some(sub) = dest_subpath {
        // validate_subpath already called in import_folder, but belt-and-suspenders
        let safe_sub = validate_subpath(sub).map_err(|e| {
            emit_error(app, import_id, &e);
            e
        })?;
        workspace.join(safe_sub)
    } else {
        workspace.to_path_buf()
    };

    // Handle single file import
    if source.is_file() {
        let file_name = source
            .file_name()
            .ok_or_else(|| "Cannot determine file name".to_string())?;
        let dest = dest_base.join(file_name);

        // Verify destination stays within workspace (no side effects)
        ensure_within_workspace(&dest, workspace).map_err(|e| {
            emit_error(app, import_id, &e);
            e
        })?;

        // Now safe to create dirs and re-verify
        safe_create_parent_dirs(&dest, workspace).map_err(|e| {
            emit_error(app, import_id, &e);
            e
        })?;

        let bytes = safe_copy_file(source, &dest).map_err(|e| {
            emit_error(app, import_id, &e);
            e
        })?;

        let _ = app.emit(
            "folder-import-progress",
            ImportProgress {
                import_id: import_id.to_string(),
                processed: 1,
                total: 1,
                current_file: file_name.to_string_lossy().to_string(),
                phase: "done".to_string(),
            },
        );

        return Ok(ImportResult {
            import_id: import_id.to_string(),
            files_copied: 1,
            bytes_copied: bytes,
            dest_path: dest.display().to_string(),
            errors: vec![],
        });
    }

    // Directory import
    if !source.is_dir() {
        let msg = format!(
            "Source is neither a file nor a directory: {}",
            source.display()
        );
        emit_error(app, import_id, &msg);
        return Err(msg);
    }

    let folder_name = source
        .file_name()
        .ok_or_else(|| "Cannot determine folder name".to_string())?;
    let dest_root = dest_base.join(folder_name);

    // Verify destination root stays within workspace (no side effects)
    ensure_within_workspace(&dest_root, workspace).map_err(|e| {
        emit_error(app, import_id, &e);
        e
    })?;

    // Always create dest_root so even empty folders appear in the workspace.
    // Post-creation containment check guards against TOCTOU parent swap.
    safe_create_dir(&dest_root, workspace).map_err(|e| {
        emit_error(app, import_id, &e);
        e
    })?;

    // Phase 1: Scan - count files
    // follow_links(false) to prevent importing files outside the chosen source folder
    // via symlinks. Symlinks are skipped silently.
    let _ = app.emit(
        "folder-import-progress",
        ImportProgress {
            import_id: import_id.to_string(),
            processed: 0,
            total: 0,
            current_file: String::new(),
            phase: "scanning".to_string(),
        },
    );

    let mut total_files: u64 = 0;
    let mut entries: Vec<(PathBuf, PathBuf)> = Vec::new(); // (source_abs, relative_path)
    let mut dir_entries: Vec<PathBuf> = Vec::new(); // relative paths of directories

    for entry in WalkDir::new(source).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[commands] Skipping unreadable entry: {}", e);
                continue;
            }
        };

        let relative = entry
            .path()
            .strip_prefix(source)
            .unwrap_or(entry.path())
            .to_path_buf();

        if entry.file_type().is_file() {
            let abs = entry.path().to_path_buf();
            entries.push((abs, relative));
            total_files += 1;
        } else if entry.file_type().is_dir() && entry.path() != source {
            // Collect subdirectories (skip the root source dir itself).
            // WalkDir yields parents before children, preserving creation order.
            dir_entries.push(relative);
        }
        // Symlinks (entry.file_type().is_symlink()) are silently skipped
    }

    eprintln!(
        "[commands] Scanned {} files to import into {}",
        total_files,
        dest_root.display()
    );

    // Phase 2: Copy files
    // files_copied counts only successful copies; files_processed drives progress
    let mut files_copied: u64 = 0;
    let mut files_processed: u64 = 0;
    let mut bytes_copied: u64 = 0;
    let mut errors: Vec<String> = Vec::new();

    // Batch progress: emit every N files to avoid flooding IPC
    let emit_interval = if total_files > 1000 { 10 } else { 1 };

    for (source_file, relative) in &entries {
        let dest_file = dest_root.join(relative);

        // Verify each file's destination stays within workspace before creating dirs
        if let Err(e) = ensure_within_workspace(&dest_file, workspace) {
            errors.push(format!("{}: {}", relative.display(), e));
            files_processed += 1;
            continue;
        }

        // Create parent directories with post-creation containment check
        if let Err(e) = safe_create_parent_dirs(&dest_file, workspace) {
            errors.push(format!("{}: {}", relative.display(), e));
            files_processed += 1;
            continue;
        }

        // Copy file (O_NOFOLLOW prevents writing through symlinks)
        match safe_copy_file(source_file, &dest_file) {
            Ok(bytes) => {
                files_copied += 1;
                bytes_copied += bytes;
            }
            Err(e) => {
                errors.push(format!("{}: {}", relative.display(), e));
            }
        }
        files_processed += 1;

        // Emit progress (batched)
        if files_processed % emit_interval == 0 || files_processed == total_files {
            let _ = app.emit(
                "folder-import-progress",
                ImportProgress {
                    import_id: import_id.to_string(),
                    processed: files_processed,
                    total: total_files,
                    current_file: relative.display().to_string(),
                    phase: "copying".to_string(),
                },
            );
        }
    }

    // Create empty directories that weren't already created as file parents.
    // Non-empty dirs were created by safe_create_parent_dirs during file copy.
    for rel_dir in &dir_entries {
        let dest_dir = dest_root.join(rel_dir);
        if dest_dir.exists() {
            continue; // Already created as a file parent
        }
        if let Err(e) = ensure_within_workspace(&dest_dir, workspace) {
            errors.push(format!("dir {}: {}", rel_dir.display(), e));
            continue;
        }
        if let Err(e) = safe_create_dir(&dest_dir, workspace) {
            errors.push(format!("dir {}: {}", rel_dir.display(), e));
        }
    }

    // Phase 3: Done
    if !errors.is_empty() {
        eprintln!(
            "[commands] Import completed with {} errors out of {} files",
            errors.len(),
            total_files
        );
    }

    let _ = app.emit(
        "folder-import-progress",
        ImportProgress {
            import_id: import_id.to_string(),
            processed: files_processed,
            total: total_files,
            current_file: String::new(),
            phase: "done".to_string(),
        },
    );

    Ok(ImportResult {
        import_id: import_id.to_string(),
        files_copied,
        bytes_copied,
        dest_path: dest_root.display().to_string(),
        errors,
    })
}

/// Simple timestamp without pulling in chrono crate.
fn chrono_now() -> String {
    use std::time::SystemTime;
    let d = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}s", d.as_secs())
}
