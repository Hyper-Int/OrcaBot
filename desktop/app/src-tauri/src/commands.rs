// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: folder-import-v10-cloud-workspace-walk
const MODULE_REVISION: &str = "folder-import-v10-cloud-workspace-walk";

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

/// Switch the desktop GUI back to the CLI surface: open Terminal.app running the
/// sibling `orcabot cli` (which attaches to this same running session and opens
/// the TUI), then hide the GUI window. macOS-only (the desktop app is macOS-only
/// today); other platforms return an error.
/// Quit the app — used by the loading screen's stuck/error state. `app.exit`
/// fires RunEvent::Exit, which runs the service-shutdown handler in main.rs.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// The running app's version (from tauri.conf.json / Cargo.toml), e.g. "0.5.0".
/// Shown in the desktop header so users can see what they're running — the
/// version is otherwise invisible in a packaged build.
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[derive(Serialize, Clone)]
pub struct OrcabotAccount {
    pub email: String,
    pub name: String,
}

/// Verify an orcabot.com personal access token and return its account identity.
/// Runs from the native layer (not the webview) so it isn't subject to browser
/// CORS, and the token is only ever sent to the FIXED cloud control-plane URL —
/// a compromised webview can't redirect it elsewhere. The desktop app keeps
/// running on the LOCAL control plane; this only confirms the account and reads
/// the email/name to use as the local identity.
///
/// Async: the blocking HTTP call (up to 15s on a slow/offline network) runs on a
/// blocking thread so it never freezes the native UI/IPC event loop during sign-in.
#[tauri::command]
pub async fn verify_orcabot_account(token: String) -> Result<OrcabotAccount, String> {
    tauri::async_runtime::spawn_blocking(move || verify_orcabot_account_blocking(&token))
        .await
        .map_err(|e| format!("sign-in task failed: {e}"))?
}

fn verify_orcabot_account_blocking(token: &str) -> Result<OrcabotAccount, String> {
    let token = token.trim();
    if !token.starts_with("orca_pat_") {
        return Err("That doesn't look like an Orcabot token (starts with orca_pat_).".into());
    }
    // Fixed to the public cloud control plane on purpose (token exfil guard).
    let url = "https://api.orcabot.com/users/me";
    match ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(15))
        .call()
    {
        Ok(resp) => {
            let body: serde_json::Value = resp
                .into_json()
                .map_err(|e| format!("unexpected response from orcabot.com: {e}"))?;
            let email = body["user"]["email"].as_str().unwrap_or("").trim().to_string();
            if email.is_empty() {
                return Err("That account has no email — can't sign in.".into());
            }
            let name = body["user"]["name"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&email)
                .to_string();
            Ok(OrcabotAccount { email, name })
        }
        Err(ureq::Error::Status(401, _)) => {
            Err("That token was rejected. Create a fresh one on orcabot.com and try again.".into())
        }
        Err(ureq::Error::Status(code, _)) => {
            Err(format!("orcabot.com returned an error ({code})."))
        }
        Err(e) => Err(format!("Couldn't reach orcabot.com: {e}")),
    }
}

// ---- Cloud account credential (for dashboard sync) -------------------------
// The signed-in cloud PAT + email, stored host-only (0600) so the app can list
// and download the user's cloud dashboards. A PAT is full account access, so it
// NEVER enters the sandbox VM or the webview beyond the initial sign-in. All
// cloud calls go through the native layer (no browser CORS, token stays in Rust).

const CLOUD_API_BASE: &str = "https://api.orcabot.com";

fn cloud_credential_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join("cloud-credential"))
}

/// (token, email, origin). `origin` is "google" for a desktop-minted cloud PAT,
/// "pat" for a user-pasted token, or "" for legacy files. Only "google" tokens are
/// safe to revoke on logout (a pasted PAT may be shared with the CLI/automation).
fn read_cloud_credential_full(app: &tauri::AppHandle) -> Option<(String, String, String)> {
    let path = cloud_credential_path(app)?;
    let contents = std::fs::read_to_string(path).ok()?;
    let mut lines = contents.lines();
    let token = lines.next()?.trim().to_string();
    let email = lines.next().unwrap_or("").trim().to_string();
    let origin = lines.next().unwrap_or("").trim().to_string();
    if token.is_empty() {
        return None;
    }
    Some((token, email, origin))
}

fn read_cloud_credential(app: &tauri::AppHandle) -> Option<(String, String)> {
    read_cloud_credential_full(app).map(|(t, e, _)| (t, e))
}

/// Remove the credential file, retrying a transient lock. Ok on success or NotFound;
/// Err otherwise — callers must NOT clear ownership state (COMMITTED_GEN) on Err, so
/// a later attempt can retry rather than losing track of a still-present credential.
fn remove_credential_file(app: &tauri::AppHandle) -> Result<(), String> {
    let path = match cloud_credential_path(app) {
        Some(p) => p,
        None => return Ok(()),
    };
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..3 {
        match std::fs::remove_file(&path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }
    }
    Err(format!(
        "failed to remove stored credential: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

#[derive(Serialize, Clone)]
pub struct CloudAccount {
    pub email: String,
}

/// Persist the cloud credential (PAT + email) host-only (0600), atomically.
/// Write to a temp file created 0600, then rename over the target — so the token is
/// never briefly world-readable (umask race) and any pre-existing loose-permission
/// file is replaced by a 0600 one. Permission failures are fatal.
fn write_cloud_credential(
    app: &tauri::AppHandle,
    token: &str,
    email: &str,
    origin: &str,
) -> Result<(), String> {
    let path = cloud_credential_path(app).ok_or("no app data dir")?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let contents = format!("{}\n{}\n{}\n", token, email.trim(), origin);
    let tmp = path.with_extension("tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("failed to store credential: {e}"))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("failed to store credential: {e}"))?;
        let _ = f.sync_all();
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&tmp, &contents)
            .map_err(|e| format!("failed to store credential: {e}"))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("failed to store credential: {e}")
    })?;
    Ok(())
}

/// Persist the cloud credential (PAT + email) host-only (0600) for dashboard sync.
#[tauri::command]
pub fn set_cloud_credential(app: tauri::AppHandle, token: String, email: String) -> Result<(), String> {
    let token = token.trim();
    if !token.starts_with("orca_pat_") {
        return Err("Not an Orcabot token.".into());
    }
    // Under the lock: claim a generation, write, and record it as the committing
    // generation — so an in-flight Google flow (between its own check and write)
    // can't overwrite this pasted token, and a stale Google rollback won't delete it.
    {
        let _guard = cred_lock();
        let g = SIGN_IN_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        // "pat" origin — a user-pasted token, possibly shared with the CLI/automation,
        // so logout must NOT revoke it server-side (only forget it locally).
        write_cloud_credential(&app, token, &email, "pat")?;
        COMMITTED_GEN.store(g, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct CloudSignIn {
    pub email: String,
    pub name: String,
    /// The attempt id (generation) that wrote this credential — the frontend passes
    /// it back to rollback_sign_in if this attempt turns out to be stale/cancelled.
    pub attempt: u64,
}

/// Monotonic "current sign-in attempt" generation. Bumped when the user cancels,
/// starts another sign-in, or pastes a PAT — so an in-flight loopback sign-in can
/// tell it's been superseded and must NOT exchange or overwrite the credential.
static SIGN_IN_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Serializes every credential mutation (write / gen-check+write / clear) so the
/// generation check and the file write happen atomically — otherwise a cancel,
/// logout, or PAT paste could interleave between the check and the write and a
/// stale sign-in could restore or clobber a credential. No await is held across it.
static CRED_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn cred_lock() -> std::sync::MutexGuard<'static, ()> {
    CRED_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// The generation (attempt id) that wrote the CURRENT stored credential, or 0 if
/// none / it was cleared. Lets a superseded sign-in roll back ONLY its own write:
/// if a newer sign-in or a pasted PAT has since written, this won't match and the
/// rollback is a no-op (so it can't delete someone else's credential).
static COMMITTED_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn sign_in_current(my_gen: u64) -> bool {
    SIGN_IN_GEN.load(std::sync::atomic::Ordering::SeqCst) == my_gen
}

/// base64url (no padding) — matches the control plane's PKCE challenge encoding.
fn b64url(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(T[((n >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(T[(n & 63) as usize] as char);
        }
    }
    out
}

/// PKCE S256 challenge: base64url(SHA-256(verifier)).
fn pkce_challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// Cryptographically-random hex token (OS RNG via /dev/urandom; the OS-seeded
/// RandomState as a fallback). Used as the loopback CSRF `state`.
fn random_hex(n: usize) -> String {
    #[cfg(unix)]
    {
        use std::io::Read;
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            let mut buf = vec![0u8; n];
            if f.read_exact(&mut buf).is_ok() {
                return buf.iter().map(|b| format!("{b:02x}")).collect();
            }
        }
    }
    use std::hash::{BuildHasher, Hasher};
    let mut s = String::new();
    while s.len() < n * 2 {
        let h = std::collections::hash_map::RandomState::new()
            .build_hasher()
            .finish();
        s.push_str(&format!("{h:016x}"));
    }
    s.truncate(n * 2);
    s
}

/// Percent-encode a URL query value (unreserved chars pass through).
fn pct(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    cmd.arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open browser: {e}"))
}

fn parse_query(path: &str) -> (Option<String>, Option<String>) {
    let q = path.splitn(2, '?').nth(1).unwrap_or("");
    let mut code = None;
    let mut state = None;
    for kv in q.split('&') {
        let mut it = kv.splitn(2, '=');
        match (it.next(), it.next()) {
            (Some("code"), Some(v)) => code = Some(v.to_string()),
            (Some("state"), Some(v)) => state = Some(v.to_string()),
            _ => {}
        }
    }
    (code, state)
}

/// Wait (bounded) for the OAuth callback on the loopback listener; return the
/// one-time `code` once a `/cb?code=…&state=…` request arrives with our state.
fn await_loopback_code(
    listener: std::net::TcpListener,
    expect_state: &str,
    my_gen: u64,
) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::time::{Duration, Instant};
    listener.set_nonblocking(true).ok();
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if !sign_in_current(my_gen) {
            return Err("sign-in cancelled".into());
        }
        if Instant::now() > deadline {
            return Err("timed out waiting for the browser sign-in".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("");
                let (code, state) = parse_query(path);
                if !path.starts_with("/cb") || code.is_none() {
                    // Stray request (favicon, etc.) — brush it off and keep waiting.
                    let _ =
                        stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
                    continue;
                }
                let ok = state.as_deref() == Some(expect_state);
                let page = if ok {
                    "<!doctype html><meta charset=utf-8><title>Signed in</title><body style=\"font-family:system-ui;background:#0d1117;color:#eef2f8;text-align:center;padding:48px\"><h2>Signed in to Orcabot</h2><p>You can close this tab and return to the app.</p></body>"
                } else {
                    "<!doctype html><meta charset=utf-8><title>Sign-in failed</title><body style=\"font-family:system-ui;background:#0d1117;color:#eef2f8;text-align:center;padding:48px\"><h2>Sign-in couldn't be verified</h2><p>Please try again from the app.</p></body>"
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                    page.len(),
                    page
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
                if !ok {
                    return Err("sign-in verification failed (state mismatch)".into());
                }
                return Ok(code.unwrap());
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("loopback listener error: {e}")),
        }
    }
}

fn exchange_desktop_code(code: &str, verifier: &str) -> Result<(String, String, String), String> {
    let url = format!("{CLOUD_API_BASE}/auth/desktop/exchange");
    match ureq::post(&url)
        .timeout(std::time::Duration::from_secs(30))
        .send_json(serde_json::json!({ "code": code, "verifier": verifier }))
    {
        Ok(rp) => {
            let v: serde_json::Value = rp.into_json().map_err(|e| e.to_string())?;
            let token = v
                .get("token")
                .and_then(|x| x.as_str())
                .ok_or("sign-in response had no token")?
                .to_string();
            let email = v.get("email").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            Ok((token, email, name))
        }
        Err(ureq::Error::Status(c, rp)) => Err(format!(
            "sign-in exchange failed ({c}): {}",
            rp.into_string().unwrap_or_default().trim()
        )),
        Err(e) => Err(format!("couldn't reach orcabot.com: {e}")),
    }
}

/// Sign in to the cloud with Google via a LOOPBACK redirect (RFC 8252): run a
/// temporary 127.0.0.1 listener, open the browser to the cloud login pointing back
/// at it, receive a one-time code there, exchange it for a PAT, and store the PAT
/// host-only. The token never enters the webview. Returns {email,name} for the UI.
#[tauri::command]
pub async fn sign_in_google_loopback(app: tauri::AppHandle) -> Result<CloudSignIn, String> {
    // Claim a fresh attempt generation (under the lock, so it's part of the same
    // serialized state machine as cancel/write). Any later cancel / sign-in / PAT
    // paste bumps it, so this flow refuses to exchange or store once superseded.
    let my_gen = {
        let _guard = cred_lock();
        SIGN_IN_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    };

    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not start local sign-in listener: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let state = random_hex(16);
    // PKCE: keep the verifier in-process; send only its S256 challenge in the URL.
    let verifier = random_hex(32);
    let challenge = pkce_challenge(&verifier);
    let redirect = format!("http://127.0.0.1:{port}/cb");
    let login_url = format!(
        "{CLOUD_API_BASE}/auth/google/login?mode=desktop&redirect_uri={}&state={}&challenge={}",
        pct(&redirect),
        pct(&state),
        pct(&challenge)
    );
    open_in_browser(&login_url)?;

    let (token, email, name) = tauri::async_runtime::spawn_blocking(
        move || -> Result<(String, String, String), String> {
            let code = await_loopback_code(listener, &state, my_gen)?;
            if !sign_in_current(my_gen) {
                return Err("sign-in cancelled".into());
            }
            exchange_desktop_code(&code, &verifier)
        },
    )
    .await
    .map_err(|e| format!("sign-in task failed: {e}"))??;

    // Final guard: don't overwrite the credential if the attempt was cancelled or
    // superseded (e.g. the user pasted a PAT for a different account meanwhile).
    // Atomic gen-check + write: hold the lock across both so a cancel / PAT paste
    // can't slip between them (it would bump the gen or write a different account).
    {
        let _guard = cred_lock();
        if !sign_in_current(my_gen) {
            return Err("sign-in cancelled".into());
        }
        // "google" origin — desktop-minted, so logout revokes it server-side.
        write_cloud_credential(&app, &token, &email, "google")?;
        COMMITTED_GEN.store(my_gen, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(CloudSignIn { email, name, attempt: my_gen })
}

/// Roll back a specific sign-in attempt's credential (called by the frontend when a
/// resolved sign-in turns out to have been superseded/cancelled). Deletes + revokes
/// ONLY if that attempt still owns the stored credential; if a newer sign-in or a
/// pasted PAT wrote since, this is a no-op (can't clobber the current one).
#[tauri::command]
pub async fn rollback_sign_in(app: tauri::AppHandle, attempt: u64) -> Result<(), String> {
    let creds = {
        let _guard = cred_lock();
        if attempt == 0 || COMMITTED_GEN.load(std::sync::atomic::Ordering::SeqCst) != attempt {
            return Ok(()); // a newer write owns the credential — leave it
        }
        let creds = read_cloud_credential_full(&app);
        // Delete FIRST; only relinquish ownership (COMMITTED_GEN) on success, so a
        // failed delete keeps the mapping and a retry can still clean it up.
        remove_credential_file(&app)?;
        COMMITTED_GEN.store(0, std::sync::atomic::Ordering::SeqCst);
        creds
    };
    if let Some((token, _email, origin)) = creds {
        if origin == "google" {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _ = ureq::post(&format!("{CLOUD_API_BASE}/auth/api-token/revoke-self"))
                    .set("Authorization", &format!("Bearer {token}"))
                    .timeout(std::time::Duration::from_secs(10))
                    .call();
            })
            .await;
        }
    }
    Ok(())
}

/// Cancel an in-flight loopback sign-in: bumps the attempt generation so the native
/// flow stops before exchanging the code or writing the credential.
#[tauri::command]
pub fn cancel_google_sign_in() {
    // Under the lock so it's serialized with the sign-in's check+write. A cancel that
    // still races an already-committed write is cleaned up by the frontend (it calls
    // clear_cloud_credential when the resolved sign-in was cancelled).
    let _guard = cred_lock();
    SIGN_IN_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// The signed-in cloud account (email), or null if not signed in to the cloud.
#[tauri::command]
pub fn get_cloud_account(app: tauri::AppHandle) -> Option<CloudAccount> {
    read_cloud_credential(&app).map(|(_, email)| CloudAccount { email })
}

/// Forget the stored cloud credential (sign out of cloud sync). Deletes the local
/// file FIRST (before any await) so a concurrent re-sign-in that writes a new
/// credential can't be clobbered by this logout's late deletion. Then, only for a
/// desktop-minted ("google") token, revokes it server-side (best-effort; the TTL is
/// the offline backstop). A user-pasted PAT is only forgotten locally — it may be
/// shared with the CLI/automation, so we must not revoke it globally.
#[tauri::command]
pub async fn clear_cloud_credential(app: tauri::AppHandle) -> Result<(), String> {
    // Under the lock: supersede in-flight sign-ins, capture the token, and delete the
    // file — all before any await, so a concurrent re-sign-in can't be clobbered.
    let creds = {
        let _guard = cred_lock();
        SIGN_IN_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let creds = read_cloud_credential_full(&app);
        // Only NotFound is fine; any other failure means the credential may still be
        // on disk (it would sign the user back in on restart). Report it so the UI
        // can surface it, and keep ownership state until the delete actually succeeds.
        remove_credential_file(&app)?;
        COMMITTED_GEN.store(0, std::sync::atomic::Ordering::SeqCst);
        creds
    };
    if let Some((token, _email, origin)) = creds {
        if origin == "google" {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _ = ureq::post(&format!("{CLOUD_API_BASE}/auth/api-token/revoke-self"))
                    .set("Authorization", &format!("Bearer {token}"))
                    .timeout(std::time::Duration::from_secs(10))
                    .call();
            })
            .await;
        }
    }
    Ok(())
}

/// List the signed-in user's CLOUD dashboards from api.orcabot.com using the
/// stored PAT. Native (no browser CORS; token never leaves Rust). Returns the raw
/// JSON so the frontend can render the list + mark which are downloaded locally.
#[tauri::command]
pub async fn list_cloud_dashboards(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let (token, _email) = read_cloud_credential(&app).ok_or("Not signed in to the cloud.")?;
    tauri::async_runtime::spawn_blocking(move || {
        match ureq::get(&format!("{CLOUD_API_BASE}/dashboards"))
            .set("Authorization", &format!("Bearer {token}"))
            .timeout(std::time::Duration::from_secs(20))
            .call()
        {
            Ok(resp) => resp
                .into_json::<serde_json::Value>()
                .map_err(|e| format!("unexpected response from orcabot.com: {e}")),
            Err(ureq::Error::Status(401, _)) => {
                Err("Cloud session expired — sign in again.".into())
            }
            Err(ureq::Error::Status(code, _)) => Err(format!("orcabot.com returned {code}.")),
            Err(e) => Err(format!("Couldn't reach orcabot.com: {e}")),
        }
    })
    .await
    .map_err(|e| format!("list task failed: {e}"))?
}

/// Fetch one cloud dashboard's full data (dashboard + items + edges) from
/// api.orcabot.com using the stored PAT, so the frontend can materialize it into
/// the local DB (the download). Native — no CORS, token stays in Rust.
#[tauri::command]
pub async fn get_cloud_dashboard(
    app: tauri::AppHandle,
    dashboard_id: String,
) -> Result<serde_json::Value, String> {
    let (token, _email) = read_cloud_credential(&app).ok_or("Not signed in to the cloud.")?;
    tauri::async_runtime::spawn_blocking(move || {
        match ureq::get(&format!("{CLOUD_API_BASE}/dashboards/{dashboard_id}"))
            .set("Authorization", &format!("Bearer {token}"))
            .timeout(std::time::Duration::from_secs(30))
            .call()
        {
            Ok(resp) => resp
                .into_json::<serde_json::Value>()
                .map_err(|e| format!("unexpected response from orcabot.com: {e}")),
            Err(ureq::Error::Status(401, _)) => {
                Err("Cloud session expired — sign in again.".into())
            }
            Err(ureq::Error::Status(code, _)) => Err(format!("orcabot.com returned {code}.")),
            Err(e) => Err(format!("Couldn't reach orcabot.com: {e}")),
        }
    })
    .await
    .map_err(|e| format!("fetch task failed: {e}"))?
}

// ===== Cloud workspace download (per-dashboard file copy) =====
//
// Downloading a cloud dashboard copies its canvas (frontend) AND its workspace
// files (this command). The desktop has ONE shared /workspace, so to keep two
// downloaded dashboards from colliding we write each dashboard's files into a
// per-dashboard subfolder `<app_data>/workspace/<subdir>` (subdir = the new local
// dashboard id); the recreated terminals get `workingDir=<subdir>` so they open
// there. Mirrors the CLI `pull`: start/reuse a cloud session, list the workspace
// recursively, GET each file, write it locally with an O_NOFOLLOW-guarded walk.
// Secret values are redacted server-side on read, so secrets never transfer.

#[derive(Serialize, Clone)]
pub struct WorkspaceDownloadResult {
    pub written: u64,
    pub skipped: u64,
    /// false when the cloud dashboard has no terminal/session — nothing to pull
    /// (not an error; a notes-only dashboard has no workspace files).
    pub had_workspace: bool,
}

/// Progress for a workspace download, emitted as `cloud-workspace-progress` so the
/// UI can show what's happening during a slow cold cloud-VM boot (otherwise a
/// legitimately slow pull looks like a hang). Keyed by `cloud_id`.
#[derive(Serialize, Clone)]
pub struct CloudWorkspaceProgress {
    pub cloud_id: String,
    /// "starting" | "booting" | "copying"
    pub phase: String,
    pub written: u64,
}

/// GET a JSON body from the cloud with the PAT. Maps the paywall to a sentinel.
fn cloud_get_json(token: &str, url: &str) -> Result<serde_json::Value, String> {
    match ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(30))
        .call()
    {
        Ok(rp) => Ok(rp.into_json().unwrap_or(serde_json::Value::Null)),
        Err(ureq::Error::Status(401, _)) => Err("Cloud session expired — sign in again.".into()),
        Err(ureq::Error::Status(c, rp)) => {
            let b = rp.into_string().unwrap_or_default();
            if c == 403 && b.contains("SUBSCRIPTION_REQUIRED") {
                return Err("SUBSCRIPTION_REQUIRED".into());
            }
            Err(format!("orcabot.com returned {c}."))
        }
        Err(e) => Err(format!("Couldn't reach orcabot.com: {e}")),
    }
}

fn cloud_post_json(
    token: &str,
    url: &str,
    body: serde_json::Value,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    match ureq::post(url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .send_json(body)
    {
        Ok(rp) => Ok(rp.into_json().unwrap_or(serde_json::Value::Null)),
        Err(ureq::Error::Status(401, _)) => Err("Cloud session expired — sign in again.".into()),
        Err(ureq::Error::Status(c, rp)) => {
            let b = rp.into_string().unwrap_or_default();
            if c == 403 && b.contains("SUBSCRIPTION_REQUIRED") {
                return Err("SUBSCRIPTION_REQUIRED".into());
            }
            Err(format!("orcabot.com returned {c}."))
        }
        Err(e) => Err(format!("Couldn't reach orcabot.com: {e}")),
    }
}

/// List ONE directory's immediate children (non-recursive). We walk the tree
/// ourselves so we can prune excluded dirs (node_modules/.git/…) instead of a
/// server-side recursive walk that enumerates every file first — that blew the
/// request timeout (and the 100k-entry cap) on real projects. `dir` is a
/// workspace path like "/" or "/src".
fn cloud_dir_list(token: &str, sid: &str, dir: &str) -> Result<Vec<serde_json::Value>, String> {
    let url = format!("{CLOUD_API_BASE}/sessions/{sid}/files");
    match ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .query("path", dir)
        .timeout(std::time::Duration::from_secs(30))
        .call()
    {
        Ok(rp) => {
            let v: serde_json::Value = rp.into_json().unwrap_or(serde_json::Value::Null);
            Ok(v.get("files").and_then(|x| x.as_array()).cloned().unwrap_or_default())
        }
        Err(ureq::Error::Status(401, _)) => Err("Cloud session expired — sign in again.".into()),
        Err(ureq::Error::Status(c, rp)) => {
            Err(format!("HTTP {c}: {}", rp.into_string().unwrap_or_default().trim()))
        }
        Err(e) => Err(format!("Couldn't reach orcabot.com: {e}")),
    }
}

/// Cap on a single downloaded file held in memory. The control plane already 413s
/// file reads over 50 MB; this is a defensive client-side bound so one huge
/// artifact can't exhaust desktop memory even if that cap changes.
const MAX_DOWNLOAD_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn cloud_file_get(token: &str, sid: &str, rel: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let url = format!("{CLOUD_API_BASE}/sessions/{sid}/file");
    match ureq::get(&url)
        .set("Authorization", &format!("Bearer {token}"))
        .query("path", rel)
        .timeout(std::time::Duration::from_secs(120))
        .call()
    {
        Ok(rp) => {
            let mut buf = Vec::new();
            rp.into_reader()
                .take(MAX_DOWNLOAD_FILE_BYTES + 1)
                .read_to_end(&mut buf)
                .map_err(|e| e.to_string())?;
            if buf.len() as u64 > MAX_DOWNLOAD_FILE_BYTES {
                return Err("file exceeds size limit".into());
            }
            Ok(buf)
        }
        Err(ureq::Error::Status(c, rp)) => {
            Err(format!("HTTP {c}: {}", rp.into_string().unwrap_or_default().trim()))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// A transient/retryable failure: the cloud sandbox is provisioning (proxy 503/
/// 502/504) or a connection blipped. The session can read "active" before the
/// sandbox HTTP is actually serving, so the first file calls need to be retried.
fn is_transient_err(e: &str) -> bool {
    e.contains("HTTP 503")
        || e.contains("HTTP 502")
        || e.contains("HTTP 504")
        || e.contains("Network Error")
        || e.contains("reset")
        || e.contains("timed out")
}

/// List a directory, retrying transient failures (sandbox warming up) with a 3s
/// backoff. Use a large `attempts` for the first (root) list — that's the window
/// where the just-started sandbox may still be booting its HTTP server.
fn cloud_dir_list_ready(
    token: &str,
    sid: &str,
    dir: &str,
    attempts: u32,
) -> Result<Vec<serde_json::Value>, String> {
    let mut last = String::new();
    for i in 0..attempts.max(1) {
        match cloud_dir_list(token, sid, dir) {
            Ok(v) => return Ok(v),
            Err(e) if is_transient_err(&e) => {
                last = e;
                if i + 1 < attempts {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                }
            }
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

/// GET a file, retrying transient failures a few times (2s backoff).
fn cloud_file_get_ready(token: &str, sid: &str, rel: &str) -> Result<Vec<u8>, String> {
    let mut last = String::new();
    for i in 0..4 {
        match cloud_file_get(token, sid, rel) {
            Ok(v) => return Ok(v),
            Err(e) if is_transient_err(&e) => {
                last = e;
                if i < 3 {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            }
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

/// Get a live cloud session id for `dash` whose sandbox is actually running, so
/// the file API works. We do NOT trust a bare "active" DB status — that can point
/// at a reaped VM, and the file proxy then hangs forever trying to reach a dead
/// machine. Instead we always POST /session, which runs ensureDashboardSandbox on
/// the control plane: it restarts a stopped machine and reprovisions a dead
/// session. We never CREATE a terminal item (no phantom blocks); returns None when
/// the dashboard has no terminal item at all. `on_boot` fires each poll (progress).
fn cloud_ensure_session(
    token: &str,
    dash: &str,
    on_boot: &dyn Fn(),
) -> Result<Option<String>, String> {
    let dash_url = format!("{CLOUD_API_BASE}/dashboards/{dash}");
    let v = cloud_get_json(token, &dash_url)?;

    let item_id = v
        .get("items")
        .and_then(|x| x.as_array())
        .and_then(|items| {
            items
                .iter()
                .find(|it| it.get("type").and_then(|x| x.as_str()) == Some("terminal"))
                .and_then(|it| it.get("id").and_then(|x| x.as_str()).map(String::from))
        });
    let item_id = match item_id {
        Some(i) => i,
        None => return Ok(None),
    };

    // Always POST — ensureDashboardSandbox restarts a stopped machine / reprovisions
    // a dead session. It cold-boots a Fly VM and may hold the request open until
    // provisioned, so allow well past a cold boot (not 30s). Idempotent when the
    // sandbox is already healthy.
    eprintln!("[cloud-dl] ensuring sandbox for terminal {item_id}");
    cloud_post_json(
        token,
        &format!("{CLOUD_API_BASE}/dashboards/{dash}/items/{item_id}/session"),
        serde_json::json!({}),
        180,
    )?;

    // Poll for the session to go active (cloud spins up a VM — allow generous time).
    for _ in 0..120 {
        on_boot();
        std::thread::sleep(std::time::Duration::from_secs(2));
        let v = cloud_get_json(token, &dash_url)?;
        if let Some(sessions) = v.get("sessions").and_then(|x| x.as_array()) {
            for s in sessions {
                if s.get("itemId").and_then(|x| x.as_str()) == Some(item_id.as_str())
                    && s.get("status").and_then(|x| x.as_str()) == Some("active")
                {
                    if let Some(id) = s.get("id").and_then(|x| x.as_str()) {
                        return Ok(Some(id.to_string()));
                    }
                }
            }
        }
    }
    Err("timed out waiting for your cloud workspace to start".into())
}

/// Regenerable caches / transients / runtime state we never transfer (mirrors the
/// CLI's `ws_excluded`).
fn ws_excluded(rel: &str) -> bool {
    let rel = rel.trim_start_matches('/');
    rel.starts_with(".browser")
        || rel.starts_with(".npm")
        || rel == ".orcabot"
        || rel.starts_with(".orcabot/")
        || rel.starts_with(".claude/cache")
        || rel == ".git"
        || rel.starts_with(".git/")
        || rel.split('/').any(|seg| seg == "node_modules")
}

/// Lexical/ancestor pre-filter for a remote-supplied workspace-relative path.
/// Rejects `..`, absolute paths, and writes through an in-workspace symlink whose
/// nearest existing ancestor escapes the root. The authoritative guard is the
/// O_NOFOLLOW walk in `safe_workspace_write`. (Mirrors the CLI helper.)
fn safe_workspace_dest(ws_canon: &Path, rel: &str) -> Option<PathBuf> {
    let rel_path = Path::new(rel);
    for c in rel_path.components() {
        if !matches!(c, Component::Normal(_) | Component::CurDir) {
            return None;
        }
    }
    let dest = ws_canon.join(rel_path);
    let mut anc = dest.parent();
    while let Some(a) = anc {
        if a.exists() {
            match a.canonicalize() {
                Ok(real) if real.starts_with(ws_canon) => break,
                _ => return None,
            }
        }
        anc = a.parent();
    }
    Some(dest)
}

/// Write `data` to `rel` under `ws_root`, walking every path component with
/// openat + O_NOFOLLOW so no component can be a symlink (race-safe against a
/// workspace-sharing process). (Mirrors the CLI helper.)
#[cfg(unix)]
fn safe_workspace_write(ws_root: &Path, rel: &str, data: &[u8]) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::io::{Error, ErrorKind, Write};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::FromRawFd;

    fn cstr(bytes: &[u8]) -> std::io::Result<CString> {
        CString::new(bytes).map_err(|_| Error::new(ErrorKind::InvalidInput, "NUL in path"))
    }

    let root_c = cstr(ws_root.as_os_str().as_bytes())?;
    let mut dirfd = unsafe { libc::open(root_c.as_ptr(), libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if dirfd < 0 {
        return Err(Error::last_os_error());
    }

    let comps: Vec<&str> = rel.split('/').filter(|c| !c.is_empty() && *c != ".").collect();
    let (file_name, dirs) = match comps.split_last() {
        Some(x) => x,
        None => {
            unsafe { libc::close(dirfd) };
            return Err(Error::new(ErrorKind::InvalidInput, "empty path"));
        }
    };

    for comp in dirs {
        if *comp == ".." {
            unsafe { libc::close(dirfd) };
            return Err(Error::new(ErrorKind::InvalidInput, "'..' in path"));
        }
        let c = cstr(comp.as_bytes())?;
        let mk = unsafe { libc::mkdirat(dirfd, c.as_ptr(), 0o755) };
        if mk < 0 {
            let err = Error::last_os_error();
            if err.raw_os_error() != Some(libc::EEXIST) {
                unsafe { libc::close(dirfd) };
                return Err(err);
            }
        }
        let next = unsafe {
            libc::openat(
                dirfd,
                c.as_ptr(),
                libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        unsafe { libc::close(dirfd) };
        if next < 0 {
            return Err(Error::last_os_error());
        }
        dirfd = next;
    }

    if *file_name == ".." {
        unsafe { libc::close(dirfd) };
        return Err(Error::new(ErrorKind::InvalidInput, "'..' in path"));
    }
    let fc = cstr(file_name.as_bytes())?;
    let filefd = unsafe {
        libc::openat(
            dirfd,
            fc.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o644,
        )
    };
    unsafe { libc::close(dirfd) };
    if filefd < 0 {
        return Err(Error::last_os_error());
    }
    let mut f = unsafe { std::fs::File::from_raw_fd(filefd) };
    f.write_all(data)
}

#[cfg(not(unix))]
fn safe_workspace_write(ws_root: &Path, rel: &str, data: &[u8]) -> std::io::Result<()> {
    let dest = ws_root.join(rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&dest, data)
}

/// Copy a cloud dashboard's workspace files into the local per-dashboard subfolder
/// `<app_data>/workspace/<subdir>`. Best-effort per file; returns counts. Runs on a
/// blocking thread (ureq + a session-start poll that can take a minute+).
#[tauri::command]
pub async fn download_cloud_workspace(
    app: tauri::AppHandle,
    cloud_id: String,
    subdir: String,
) -> Result<WorkspaceDownloadResult, String> {
    use tauri::Manager;
    let (token, _email) = read_cloud_credential(&app).ok_or("Not signed in to the cloud.")?;

    // subdir is the local dashboard id — must be a single safe path component.
    let subdir = subdir.trim().trim_matches('/').to_string();
    if subdir.is_empty() || subdir.contains('/') || subdir.contains("..") {
        return Err("invalid workspace subdir".into());
    }
    let ws_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workspace")
        .join(&subdir);
    std::fs::create_dir_all(&ws_root).map_err(|e| format!("create workspace dir: {e}"))?;
    let ws_canon = ws_root
        .canonicalize()
        .map_err(|e| format!("resolve workspace dir: {e}"))?;

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Emit progress so a slow cold cloud-VM boot doesn't look like a hang.
        let emit = |phase: &str, written: u64| {
            let _ = app2.emit(
                "cloud-workspace-progress",
                CloudWorkspaceProgress {
                    cloud_id: cloud_id.clone(),
                    phase: phase.to_string(),
                    written,
                },
            );
        };

        emit("starting", 0);
        let sid = match cloud_ensure_session(&token, &cloud_id, &|| emit("booting", 0)) {
            Ok(Some(s)) => s,
            Ok(None) => {
                return Ok(WorkspaceDownloadResult { written: 0, skipped: 0, had_workspace: false })
            }
            Err(e) if e == "SUBSCRIPTION_REQUIRED" => {
                return Err(
                    "Starting your cloud workspace needs an active OrcaBot subscription.".into(),
                )
            }
            Err(e) => return Err(e),
        };

        eprintln!("[cloud-dl] session ready ({sid}); listing workspace");
        emit("copying", 0);
        // Walk the workspace directory-by-directory, pruning excluded dirs so we
        // never descend into node_modules/.git. Each list is one (bounded) dir.
        let mut written = 0u64;
        let mut skipped = 0u64;
        let mut queue: Vec<String> = vec![String::new()]; // "" = workspace root
        let mut listed = 0u32;
        while let Some(dir_rel) = queue.pop() {
            listed += 1;
            if listed > 50_000 {
                // Pathological tree — stop, but count the unvisited dirs as skipped
                // so the result reports the workspace as incomplete (not complete).
                eprintln!("[cloud-dl] dir limit hit; {} dirs left unvisited", queue.len() + 1);
                skipped += queue.len() as u64 + 1;
                break;
            }
            let is_root = dir_rel.is_empty();
            let query_path = if is_root {
                "/".to_string()
            } else {
                format!("/{dir_rel}")
            };
            // The root list is the readiness gate — the just-started sandbox may
            // still be booting its HTTP server (proxy 503s), so retry it for up to
            // ~90s. Deeper dirs only need a light retry once it's serving.
            let entries = match cloud_dir_list_ready(&token, &sid, &query_path, if is_root { 10 } else { 4 }) {
                Ok(v) => v,
                Err(e) if is_root => {
                    eprintln!("[cloud-dl] root list failed: {e}");
                    return Err(format!(
                        "cloud workspace didn't become reachable ({}). Try again in a moment.",
                        e.trim()
                    ))
                }
                Err(e) => {
                    eprintln!("[cloud-dl] skip dir {query_path}: {e}");
                    skipped += 1; // count it so the result reports incompleteness
                    continue; // a deeper dir stayed unreachable — skip it
                }
            };
            eprintln!("[cloud-dl] {} -> {} entries", query_path, entries.len());
            for e in &entries {
                let rel = match e.get("path").and_then(|x| x.as_str()) {
                    Some(p) => p.trim_start_matches('/').to_string(),
                    None => continue,
                };
                if rel.is_empty() || ws_excluded(&rel) {
                    continue;
                }
                if e.get("is_dir").and_then(|x| x.as_bool()).unwrap_or(false) {
                    queue.push(rel); // descend into non-excluded subdir
                    continue;
                }
                if safe_workspace_dest(&ws_canon, &rel).is_none() {
                    skipped += 1;
                    continue;
                }
                eprintln!("[cloud-dl] get {rel}");
                let data = match cloud_file_get_ready(&token, &sid, &rel) {
                    Ok(d) => d,
                    Err(e) => {
                        eprintln!("[cloud-dl] skip {rel}: {e}");
                        skipped += 1;
                        continue;
                    }
                };
                match safe_workspace_write(&ws_canon, &rel, &data) {
                    Ok(()) => {
                        written += 1;
                        if written % 5 == 0 {
                            emit("copying", written);
                        }
                    }
                    Err(e) => {
                        eprintln!("[cloud-dl] write {rel} failed: {e}");
                        skipped += 1;
                    }
                }
            }
        }
        eprintln!("[cloud-dl] done: written={written} skipped={skipped}");
        Ok(WorkspaceDownloadResult { written, skipped, had_workspace: true })
    })
    .await
    .map_err(|e| format!("workspace download task failed: {e}"))?
}

/// Return the per-boot surface token. The host frontend sends it as the
/// `X-Orcabot-Surface` header so the control plane knows the request is from the
/// trusted GUI (not a process inside the sandbox VM spoofing dev-auth).
#[tauri::command]
pub fn get_surface_token() -> String {
    // DIAGNOSTIC (surface-ws-diag): prove whether the webview actually invokes this
    // IPC command. If this line never appears in headless.log after the GUI loads,
    // the token isn't being delivered (IPC unreachable at the remote origin) and the
    // WS-auth failure is a delivery bug, not a missing-await bug.
    let t = crate::surface_token();
    eprintln!(
        "[surface-ws-diag] get_surface_token invoked by webview -> returning token len={}",
        t.len()
    );
    t.to_string()
}

#[derive(Serialize, Clone)]
pub struct ServicePorts {
    pub controlplane: u16,
    pub frontend: u16,
    pub sandbox: u16,
    pub d1: u16,
}

fn port_from_env(var: &str, default: u16) -> u16 {
    std::env::var(var)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

/// Return the ports the stack actually bound to this boot. The defaults (8787 /
/// 8788 / …) may have been busy, in which case `main.rs` picked free ports and
/// exported them via env. The loading screen reads this to build the redirect
/// (and to hand the control-plane port to the frontend via `?cp=`, since the
/// frontend bakes `:8787` at build time and can't otherwise learn it).
#[tauri::command]
pub fn get_ports() -> ServicePorts {
    ServicePorts {
        controlplane: port_from_env("CONTROLPLANE_PORT", 8787),
        frontend: port_from_env("FRONTEND_PORT", 8788),
        sandbox: port_from_env("SANDBOX_PORT", 8080),
        // D1_SHIM_ADDR is a host:port; extract the port.
        d1: std::env::var("D1_SHIM_ADDR")
            .ok()
            .and_then(|a| a.rsplit(':').next().and_then(|s| s.trim().parse().ok()))
            .unwrap_or(9001),
    }
}

/// Open an http(s) URL in the OS default browser. OAuth connect flows use this
/// on desktop because `window.open` is a no-op inside the Tauri webview.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    cmd.arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open URL: {e}"))
}

/// Reveal the host workspace directory in the OS file manager (Finder/Explorer).
/// Desktop-only convenience so users can find where the app stores their files.
/// Takes no path from the frontend — it opens the app's own workspace dir only.
#[tauri::command]
pub async fn reveal_workspace(
    state: tauri::State<'_, WorkspaceState>,
) -> Result<(), String> {
    let path = state.workspace_path.clone();
    if path.as_os_str().is_empty() || !path.exists() {
        return Err("workspace directory is not available".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    cmd.arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open workspace: {e}"))
}

#[tauri::command]
pub fn switch_to_cli(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let orcabot = exe
            .parent()
            .ok_or("could not resolve exe directory")?
            .join("orcabot");
        if !orcabot.exists() {
            return Err(format!("orcabot CLI not found next to the app at {}", orcabot.display()));
        }
        // Escape the path for the AppleScript string literal, then wrap it in
        // `quoted form of` so it's also SHELL-safe — `do script` runs its argument
        // as a shell command, and the packaged bundle path ("Orcabot Desktop.app")
        // contains a space that would otherwise word-split.
        let esc = orcabot
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        // `--owns`: the CLI becomes the active surface and stops the session when
        // it is closed (desktop→CLI ownership hand-off).
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script ((quoted form of \"{}\") & \" cli --owns\")\nend tell",
            esc
        );
        std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .spawn()
            .map_err(|e| format!("could not open Terminal: {e}"))?;
        // Hide the GUI — same end state as the SIGUSR2 'switch to cli' path.
        for (_, w) in app.webview_windows() {
            let _ = w.hide();
        }
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("switch_to_cli is only supported on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_reference() {
        // Must equal base64url(SHA-256("test")) exactly, or the control plane's PKCE
        // check (sha256Base64Url in google.ts) rejects every desktop sign-in.
        assert_eq!(
            pkce_challenge("test"),
            "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg"
        );
    }

    #[test]
    fn b64url_is_unpadded() {
        assert_eq!(b64url(&[0x00]), "AA");
        assert_eq!(b64url(&[0xff, 0xff]), "__8");
    }
}
