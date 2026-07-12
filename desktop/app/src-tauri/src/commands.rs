// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: folder-import-v9-shell-quote-cli
const MODULE_REVISION: &str = "folder-import-v9-shell-quote-cli";

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
#[tauri::command]
pub fn verify_orcabot_account(token: String) -> Result<OrcabotAccount, String> {
    let token = token.trim();
    if !token.starts_with("orca_pat_") {
        return Err("That doesn't look like an Orcabot token (starts with orca_pat_).".into());
    }
    // Fixed to the public cloud control plane on purpose (token exfil guard).
    let url = "https://orcabot-controlplane.orcabot.workers.dev/users/me";
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
