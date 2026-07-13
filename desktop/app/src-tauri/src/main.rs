#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// REVISION: main-v12-surface-ws-hardening
const MODULE_REVISION: &str = "main-v12-surface-ws-hardening";

mod commands;
mod vm;

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tauri::Manager;
use tauri::RunEvent;

use commands::WorkspaceState;
use vm::{create_platform_vm, VMConfig, VirtualMachine};

/// Path to the PID file that tracks child processes across app restarts.
/// If the app crashes or is force-killed, the next launch reads this file
/// and kills any orphaned processes before starting new ones.
fn pid_file_path(data_dir: &Path) -> PathBuf {
  data_dir.join("desktop-services.pid")
}

/// Progress of an in-flight auto-update, emitted to the GUI as `update-progress`
/// so the frontend can show a download bar (the native "Update available" dialog
/// otherwise gives no feedback between "Update & restart" and the relaunch).
#[derive(Clone, serde::Serialize)]
struct UpdateProgress {
  /// "starting" | "downloading" | "installing" | "error"
  phase: &'static str,
  downloaded: u64,
  total: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  message: Option<String>,
}

/// File recording the ports the stack actually bound to this boot (some may be
/// dynamic when a default was busy). The `orcabot` CLI reads this so it connects
/// to the right control plane / sandbox / frontend instead of the hardcoded
/// defaults. `key=value` per line; written early (before health) and removed on
/// shutdown alongside the pid file.
fn ports_file_path(data_dir: &Path) -> PathBuf {
  data_dir.join("ports")
}

fn write_ports_file(data_dir: &Path, cp: u16, fe: u16, sandbox: u16, d1: u16) {
  let body = format!(
    "controlplane={}\nfrontend={}\nsandbox={}\nd1={}\n",
    cp, fe, sandbox, d1
  );
  if let Err(e) = std::fs::write(ports_file_path(data_dir), body) {
    eprintln!("[ports] failed to write ports file: {}", e);
  }
}

/// Path to the persisted SECRETS_ENCRYPTION_KEY. Generated on first launch.
/// Losing this file makes all stored user secrets unreadable.
fn secrets_key_path(data_dir: &Path) -> PathBuf {
  data_dir.join("secrets-encryption-key")
}

/// Encode bytes as base64 (RFC 4648, no padding stripped). Inlined to avoid a
/// dep just for one call site.
fn base64_encode(bytes: &[u8]) -> String {
  const ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
  for chunk in bytes.chunks(3) {
    let b0 = chunk[0];
    let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
    let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
    out.push(ALPHABET[(b0 >> 2) as usize] as char);
    out.push(ALPHABET[((b0 & 0x03) << 4 | (b1 >> 4)) as usize] as char);
    if chunk.len() > 1 {
      out.push(ALPHABET[((b1 & 0x0F) << 2 | (b2 >> 6)) as usize] as char);
    } else {
      out.push('=');
    }
    if chunk.len() > 2 {
      out.push(ALPHABET[(b2 & 0x3F) as usize] as char);
    } else {
      out.push('=');
    }
  }
  out
}

/// Load the persisted SECRETS_ENCRYPTION_KEY, or generate + persist a new
/// 32-byte random key on first launch. Returns the base64-encoded key string
/// (the format the controlplane Worker expects in env.SECRETS_ENCRYPTION_KEY).
fn ensure_secrets_encryption_key(data_dir: &Path) -> std::io::Result<String> {
  let key_path = secrets_key_path(data_dir);
  if let Ok(existing) = fs::read_to_string(&key_path) {
    let trimmed = existing.trim();
    if !trimmed.is_empty() {
      return Ok(trimmed.to_string());
    }
  }

  // Generate 32 random bytes — /dev/urandom on Unix, fail loudly on Windows
  // (windows.rs is a stub anyway; revisit when Windows support lands).
  let mut bytes = [0u8; 32];
  #[cfg(unix)]
  {
    let mut f = fs::File::open("/dev/urandom")?;
    f.read_exact(&mut bytes)?;
  }
  #[cfg(not(unix))]
  {
    return Err(std::io::Error::new(
      std::io::ErrorKind::Other,
      "secrets key generation not supported on this platform yet",
    ));
  }

  let encoded = base64_encode(&bytes);
  fs::create_dir_all(data_dir)?;
  // 0600 on Unix so other users on the machine can't read the key.
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new()
      .write(true)
      .create(true)
      .truncate(true)
      .mode(0o600)
      .open(&key_path)?;
    f.write_all(encoded.as_bytes())?;
  }
  #[cfg(not(unix))]
  {
    fs::write(&key_path, encoded.as_bytes())?;
  }
  eprintln!("[secrets] Generated new SECRETS_ENCRYPTION_KEY at {}", key_path.display());
  Ok(encoded)
}

/// Push an optional env var from the host into the workerd env list. No-op if
/// the host env doesn't set it — the controlplane code paths that need it
/// degrade gracefully (e.g. OAuth flow returns "not configured" instead of
/// authenticating).
fn passthrough_env(workerd_env: &mut Vec<(&'static str, String)>, key: &'static str) {
  if let Ok(value) = std::env::var(key) {
    if !value.is_empty() {
      workerd_env.push((key, value));
    }
  }
}

/// First free TCP port at/after `preferred` on loopback, skipping `used`. Falls
/// back to `preferred` if nothing is free in range (the later bind then fails
/// loudly). Used so the app boots even when a default port is occupied (e.g. a
/// stray `wrangler dev` on 8787) instead of silently failing to start.
fn port_is_free(port: u16) -> bool {
  // Probe BOTH the IPv4 wildcard and the IPv6 wildcard, not just IPv4 loopback.
  // Our consumers bind differently: workerd/d1-shim bind 127.0.0.1 (covered by
  // 0.0.0.0, a superset), but the VM forwarder (vz-helper) binds the IPv6/IPv4
  // wildcard `*:port`. A 127.0.0.1-only probe misses a leftover on `*:port`, so
  // the port looked free and the VM then collided on it ("Address already in
  // use"). Require both families bindable so nothing slips past.
  let v4 = std::net::TcpListener::bind(("0.0.0.0", port)).is_ok();
  let v6 = match std::net::TcpListener::bind(("::", port)) {
    Ok(_) => true,
    Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => false,
    // IPv6 unavailable/unsupported — don't treat as "in use" (avoids false skips).
    Err(_) => true,
  };
  v4 && v6
}

fn pick_free_port(preferred: u16, used: &[u16]) -> u16 {
  let mut p = preferred;
  for _ in 0..200 {
    if !used.contains(&p) && port_is_free(p) {
      return p;
    }
    p = match p.checked_add(1) {
      Some(n) => n,
      None => break,
    };
  }
  preferred
}

/// Ensure `var` holds a usable port. If the user set it explicitly, honor it
/// verbatim (their override). Otherwise pick a free port near `preferred`,
/// avoiding `used`, and store it. Returns the chosen port.
fn ensure_port_env(var: &str, preferred: u16, used: &[u16]) -> u16 {
  if let Ok(v) = std::env::var(var) {
    if let Ok(p) = v.trim().parse::<u16>() {
      return p;
    }
  }
  let port = pick_free_port(preferred, used);
  std::env::set_var(var, port.to_string());
  port
}

/// Per-boot token that gates dev-auth to the trusted host frontend. Generated
/// once at startup, passed to the control-plane worker (`SURFACE_TOKEN`) and
/// handed to the GUI webview via the `get_surface_token` command. The sandbox VM
/// can reach the control plane on :8787 but is never given this token — and it
/// can't reach the frontend on :8788 to scrape it — so a process in the VM can't
/// spoof dev-auth to impersonate the user. See desktop/CLAUDE.md (trust boundary).
static SURFACE_TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn surface_token() -> &'static str {
  SURFACE_TOKEN.get_or_init(|| {
    let mut buf = [0u8; 32];
    #[cfg(unix)]
    {
      use std::io::Read;
      if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
      }
    }
    buf.iter().map(|b| format!("{:02x}", b)).collect()
  })
}

/// Persist the surface token to a host-only file (0600) so trusted host clients
/// that use dev-auth — the `orcabot` CLI and scripts — can read it and send the
/// X-Orcabot-Surface header. The app-data dir is NOT shared into the sandbox VM
/// (only /workspace is), so a process in the VM can't read it.
fn write_surface_token_file(data_dir: &std::path::Path) {
  let path = data_dir.join("surface-token");
  if std::fs::write(&path, surface_token()).is_ok() {
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
  }
}

/// Kill any processes listed in a stale PID file from a previous run.
fn cleanup_stale_processes(data_dir: &Path) {
  let pid_path = pid_file_path(data_dir);
  let contents = match std::fs::read_to_string(&pid_path) {
    Ok(c) => c,
    Err(_) => return, // No PID file — nothing to clean up
  };

  for line in contents.lines() {
    if let Ok(pid) = line.trim().parse::<i32>() {
      #[cfg(unix)]
      {
        if unsafe { libc::kill(pid, 0) } != 0 {
          continue; // not alive
        }
        // Verify the PID is actually one of ours before signaling. After a crash
        // the OS may have recycled the PID for an unrelated process, and blindly
        // SIGKILLing it would be a nasty bug.
        match proc_command(pid) {
          Some(cmd) if is_orcabot_process(&cmd, data_dir) => {
            eprintln!("[cleanup] Killing stale Orcabot process {pid}");
            unsafe { libc::kill(pid, libc::SIGTERM) };
            std::thread::sleep(Duration::from_millis(500));
            unsafe { libc::kill(pid, libc::SIGKILL) };
          }
          Some(_) => eprintln!("[cleanup] Skipping PID {pid} — not an Orcabot process (PID reused?)"),
          None => eprintln!("[cleanup] Skipping PID {pid} — could not verify its identity"),
        }
      }
    }
  }

  let _ = std::fs::remove_file(&pid_path);
}

/// The full command line of a running PID (via `ps`), or None if unreadable/gone.
#[cfg(unix)]
fn proc_command(pid: i32) -> Option<String> {
  let out = std::process::Command::new("ps")
    .args(["-p", &pid.to_string(), "-o", "command="])
    .output()
    .ok()?;
  if !out.status.success() {
    return None;
  }
  let cmd = String::from_utf8_lossy(&out.stdout).trim().to_string();
  if cmd.is_empty() {
    None
  } else {
    Some(cmd)
  }
}

/// Whether a command line looks like one of Orcabot's own children. Our workerd,
/// d1-shim, and vz-helper run from the data dir, and the headless backend runs
/// from the com.orcabot bundle — install-specific markers, so a recycled PID
/// running an unrelated program is not matched.
#[cfg(unix)]
fn is_orcabot_process(cmd: &str, data_dir: &Path) -> bool {
  let dd = data_dir.to_string_lossy();
  (!dd.is_empty() && cmd.contains(dd.as_ref()))
    || cmd.contains("com.orcabot")
    || cmd.contains("orcabot-desktop")
    || cmd.contains("d1-shim")
    || cmd.contains("vz-helper")
}

/// Write all tracked child PIDs to the PID file.
fn write_pid_file(data_dir: &Path, children: &[Child], vm_pid: Option<u32>) {
  let pid_path = pid_file_path(data_dir);
  let mut pids = Vec::new();
  for child in children {
    pids.push(child.id().to_string());
  }
  if let Some(pid) = vm_pid {
    pids.push(pid.to_string());
  }
  let _ = std::fs::write(&pid_path, pids.join("\n"));
}

struct DesktopServices {
  children: Mutex<Vec<Child>>,
  sandbox_vm: Mutex<Option<Box<dyn VirtualMachine>>>,
  data_dir: Mutex<Option<PathBuf>>,
}

impl DesktopServices {
  fn new() -> Self {
    Self {
      children: Mutex::new(Vec::new()),
      sandbox_vm: Mutex::new(None),
      data_dir: Mutex::new(None),
    }
  }

  fn start(&self, app: &tauri::App) {
    if std::env::var("ORCABOT_DESKTOP_AUTOSTART")
      .map(|value| value == "0")
      .unwrap_or(false)
    {
      eprintln!("Desktop autostart disabled (ORCABOT_DESKTOP_AUTOSTART=0).");
      return;
    }

    if cfg!(windows) {
      eprintln!("Desktop services autostart not wired for Windows yet.");
      return;
    }

    let resource_root = match resolve_resource_root(app) {
      Some(path) => path,
      None => {
        eprintln!("Desktop resources not found; skipping service autostart.");
        return;
      }
    };

    let d1_shim_src = resource_root.join("d1-shim/d1-shim");
    let workerd_src = resource_root.join("workerd/workerd");
    let workerd_config = resource_root.join("workerd/config/workerd.desktop.capnp");
    let workerd_frontend_config = resource_root.join("workerd/config/workerd.frontend.capnp");
    // Use both workerd resources and the root so the assets worker can read frontend assets.
    let workerd_import = resource_root.join("workerd");
    let workerd_import_root = resource_root.clone();
    let frontend_assets_dir = resource_root.join("frontend/assets");

    let data_dir = match app.path().app_data_dir() {
      Ok(path) => path,
      Err(err) => {
        eprintln!("Failed to resolve app data dir: {}", err);
        return;
      }
    };

    // Kill any orphaned processes from a previous crash/force-quit
    cleanup_stale_processes(&data_dir);

    // Store data_dir for PID file writes
    if let Ok(mut dd) = self.data_dir.lock() {
      *dd = Some(data_dir.clone());
    }

    let bin_dir = data_dir.join("bin");
    if let Err(err) = std::fs::create_dir_all(&bin_dir) {
      eprintln!("Failed to create bin dir: {}", err);
      return;
    }

    let d1_shim_bin = match stage_executable(&d1_shim_src, &bin_dir.join("d1-shim")) {
      Ok(path) => path,
      Err(err) => {
        eprintln!(
          "Failed to stage d1-shim binary: {} (src: {})",
          err,
          d1_shim_src.display()
        );
        return;
      }
    };

    let workerd_bin = match stage_executable(&workerd_src, &bin_dir.join("workerd")) {
      Ok(path) => path,
      Err(err) => {
        eprintln!(
          "Failed to stage workerd binary: {} (src: {})",
          err,
          workerd_src.display()
        );
        return;
      }
    };

    if !workerd_config.exists() {
      eprintln!("workerd config not found: {}", workerd_config.display());
      return;
    }

    let d1_dir = data_dir.join("d1");
    if let Err(err) = std::fs::create_dir_all(&d1_dir) {
      eprintln!("Failed to create D1 data dir: {}", err);
      return;
    }

    let do_storage_dir = data_dir.join("durable_objects");
    if let Err(err) = std::fs::create_dir_all(&do_storage_dir) {
      eprintln!("Failed to create durable objects dir: {}", err);
      return;
    }

    let d1_db = d1_dir.join("controlplane.sqlite");

    // Pick free ports BEFORE anything binds, so a stray process on a default
    // port (e.g. `wrangler dev` on 8787) doesn't stop the app from starting.
    // An explicit CONTROLPLANE_PORT / FRONTEND_PORT / D1_SHIM_ADDR override is
    // honored verbatim. The chosen control-plane port is handed to the frontend
    // at runtime via the loading screen (?cp=), since it bakes :8787 at build.
    let cp_port = ensure_port_env("CONTROLPLANE_PORT", 8787, &[]);
    let fe_port = ensure_port_env("FRONTEND_PORT", 8788, &[cp_port]);
    let d1_port = match std::env::var("D1_SHIM_ADDR") {
      Ok(addr) => addr
        .rsplit(':')
        .next()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(9001),
      Err(_) => {
        let p = pick_free_port(9001, &[cp_port, fe_port]);
        std::env::set_var("D1_SHIM_ADDR", format!("127.0.0.1:{}", p));
        p
      }
    };
    // Sandbox HOST port for the host→guest forward. The GUEST side stays baked at
    // 8080 (config.env isn't delivered to the guest — it uses image defaults), so
    // only this host TCP port follows a free port. Honors an explicit SANDBOX_PORT.
    let sandbox_host_port = ensure_port_env("SANDBOX_PORT", 8080, &[cp_port, fe_port, d1_port]);
    // The control plane reaches the sandbox at this host port; point SANDBOX_URL at
    // it unless the user pinned one explicitly.
    if std::env::var("SANDBOX_URL").is_err() {
      std::env::set_var(
        "SANDBOX_URL",
        format!("http://127.0.0.1:{}", sandbox_host_port),
      );
    }

    if cp_port != 8787 || fe_port != 8788 || d1_port != 9001 || sandbox_host_port != 8080 {
      eprintln!(
        "[ports] a default port was busy — using control-plane={} frontend={} d1-shim={} sandbox={}",
        cp_port, fe_port, d1_port, sandbox_host_port
      );
    }

    // Persist the bound ports so the `orcabot` CLI (which would otherwise assume
    // the hardcoded defaults) connects to this stack correctly.
    write_ports_file(&data_dir, cp_port, fe_port, sandbox_host_port, d1_port);

    let d1_addr = std::env::var("D1_SHIM_ADDR").unwrap_or_else(|_| "127.0.0.1:9001".to_string());
    let d1_shim_debug = std::env::var("D1_SHIM_DEBUG").ok();

    self.spawn_binary(
      &d1_shim_bin,
      "d1-shim",
      &[],
      &[
        ("D1_SQLITE_PATH", d1_db.display().to_string()),
        ("D1_SHIM_ADDR", d1_addr.clone()),
        ("D1_SHIM_DEBUG", d1_shim_debug.clone().unwrap_or_default()),
      ],
    );

    // Start frontend workerd (serves the Next.js app)
    let frontend_port =
      std::env::var("FRONTEND_PORT").unwrap_or_else(|_| "8788".to_string());

    if workerd_frontend_config.exists() && frontend_assets_dir.exists() {
      eprintln!(
        "Frontend assets dir: {}",
        frontend_assets_dir.display()
      );
      eprintln!(
        "Frontend config: {}",
        workerd_frontend_config.display()
      );
      eprintln!("Starting frontend workerd on port {}...", frontend_port);
      self.spawn_binary(
        &workerd_bin,
        "workerd-frontend",
        &[
          "serve",
          "--experimental",
          "--import-path",
          workerd_import.to_str().unwrap_or_default(),
          "--import-path",
          workerd_import_root.to_str().unwrap_or_default(),
          "--directory-path",
          &format!("assets-dir={}", frontend_assets_dir.display()),
          "--socket-addr",
          &format!("http=127.0.0.1:{}", frontend_port),
          workerd_frontend_config.to_str().unwrap_or_default(),
        ],
        &[
          ("NEXT_PUBLIC_API_URL", format!("http://localhost:{}", std::env::var("CONTROLPLANE_PORT").unwrap_or_else(|_| "8787".to_string()))),
          ("NEXT_PUBLIC_SITE_URL", format!("http://localhost:{}", frontend_port)),
          ("NEXT_PUBLIC_DEV_MODE_ENABLED", "true".to_string()),
          ("NEXT_PUBLIC_DESKTOP_MODE", "true".to_string()),
        ],
      );

      wait_for_health(&frontend_port);
      eprintln!("Frontend workerd running at http://localhost:{}", frontend_port);
    } else {
      eprintln!(
        "Frontend resources not found; frontend workerd disabled. (config: {}, assets: {})",
        workerd_frontend_config.display(),
        frontend_assets_dir.display()
      );
    }

    let controlplane_port =
      std::env::var("CONTROLPLANE_PORT").unwrap_or_else(|_| "8787".to_string());
    let sandbox_url =
      std::env::var("SANDBOX_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string());
    let sandbox_internal_token =
      std::env::var("SANDBOX_INTERNAL_TOKEN").unwrap_or_else(|_| "dev-sandbox-token".to_string());
    let internal_api_token =
      std::env::var("INTERNAL_API_TOKEN").unwrap_or_else(|_| "dev-internal-token".to_string());
    let dev_auth_enabled =
      std::env::var("DEV_AUTH_ENABLED").unwrap_or_else(|_| "true".to_string());

    // Encryption key for stored user_secrets. Generated on first launch and
    // persisted in data_dir; losing the file makes existing stored secrets
    // unreadable, which is by design (same property as cloud deployments).
    let secrets_key = match ensure_secrets_encryption_key(&data_dir) {
      Ok(k) => k,
      Err(err) => {
        eprintln!("[secrets] FATAL: could not load/generate encryption key: {err}");
        // Continue with empty key — secrets routes will return 500, but app loads.
        String::new()
      }
    };

    // Host-only token file for trusted dev-auth clients (the CLI / scripts).
    write_surface_token_file(&data_dir);

    let mut workerd_env = vec![
      ("D1_HTTP_URL", "http://d1-shim".to_string()),
      ("SANDBOX_URL", sandbox_url),
      ("SANDBOX_INTERNAL_TOKEN", sandbox_internal_token),
      ("INTERNAL_API_TOKEN", internal_api_token.clone()),
      ("DEV_AUTH_ENABLED", dev_auth_enabled),
      // Gates dev-auth to the host frontend (which sends X-Orcabot-Surface with
      // this value); the sandbox VM never gets it, so it can't spoof user auth.
      ("SURFACE_TOKEN", surface_token().to_string()),
      ("SECRETS_ENCRYPTION_KEY", secrets_key),
      ("OAUTH_REDIRECT_BASE", std::env::var("OAUTH_REDIRECT_BASE")
        .unwrap_or_else(|_| format!("http://localhost:{}", controlplane_port))),
      ("EMAIL_FROM", std::env::var("EMAIL_FROM")
        .unwrap_or_else(|_| "OrcaBot Desktop <noreply@localhost>".to_string())),
    ];

    if let Ok(value) = std::env::var("ALLOWED_ORIGINS") {
      workerd_env.push(("ALLOWED_ORIGINS", value));
    } else {
      // Default allowed origins includes the local frontend
      workerd_env.push(("ALLOWED_ORIGINS", format!("http://localhost:{}", frontend_port)));
    }
    if let Ok(value) = std::env::var("FRONTEND_URL") {
      workerd_env.push(("FRONTEND_URL", value));
    } else {
      // Default frontend URL is the local frontend
      workerd_env.push(("FRONTEND_URL", format!("http://localhost:{}", frontend_port)));
    }
    if let Some(value) = d1_shim_debug {
      workerd_env.push(("D1_SHIM_DEBUG", value));
    }

    // Optional pass-through for OAuth client IDs/secrets, Resend, etc. Users
    // who want these features set the env vars before launching the app;
    // unset = feature degrades gracefully. Adding a new optional var here
    // should be paired with a binding in workerd.desktop.capnp.
    // Drift check: `node desktop/scripts/check-drift.mjs`.
    for key in &[
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_API_KEY",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "MICROSOFT_CLIENT_ID",
      "MICROSOFT_CLIENT_SECRET",
      "ONEDRIVE_CLIENT_ID",
      "ONEDRIVE_CLIENT_SECRET",
      "BOX_CLIENT_ID",
      "BOX_CLIENT_SECRET",
      "TWITTER_CLIENT_ID",
      "TWITTER_CLIENT_SECRET",
      "DISCORD_CLIENT_ID",
      "DISCORD_CLIENT_SECRET",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "RESEND_API_KEY",
      "EGRESS_PROXY_ENABLED",
    ] {
      passthrough_env(&mut workerd_env, *key);
    }

    self.spawn_binary(
      &workerd_bin,
      "workerd",
      &[
        "serve",
        "--experimental",
        "--import-path",
        workerd_import.to_str().unwrap_or_default(),
        "--import-path",
        workerd_import_root.to_str().unwrap_or_default(),
        "--socket-addr",
        &format!("http=127.0.0.1:{}", controlplane_port),
        // The d1-shim external service is hardcoded to 127.0.0.1:9001 in the
        // capnp; override it at launch so a dynamically-chosen shim port works.
        "--external-addr",
        &format!("d1-shim={}", d1_addr),
        "--directory-path",
        &format!("do-storage={}", do_storage_dir.display()),
        workerd_config.to_str().unwrap_or_default(),
      ],
      &workerd_env,
    );

    wait_for_health(&controlplane_port);

    // Apply the D1 schema on every launch (idempotent CREATE TABLE IF NOT EXISTS).
    // Without this, schema changes shipped in an app update never reach an existing
    // user's DB — the worker only runs init on a brand-new DB's first /health.
    apply_schema(&controlplane_port, &internal_api_token);

    // Write PID file so next launch can clean up orphans if we crash
    if let Ok(children) = self.children.lock() {
      write_pid_file(&data_dir, &children, None);
    }

    // VM startup is handled separately in a background thread (see main())
    // to avoid blocking the window from appearing.
  }

  fn start_sandbox_vm(
    &self,
    data_dir: &Path,
    resource_root: &Path,
  ) -> Result<(), vm::VMError> {
    // Check if VM resources exist
    let vm_resource_paths = vm::image::VMResourcePaths::from_resource_root(resource_root);

    eprintln!("Starting sandbox VM ({})...", vm::vm_backend_name());

    // Stage VM resources. The disk image isn't bundled (it would bloat every
    // auto-update); ensure_vm_image downloads + verifies it on first use, or
    // adopts an image an earlier install already staged. Log download progress.
    let last_pct = std::cell::Cell::new(-1i64);
    let progress = |done: u64, total: u64| {
      if total > 0 {
        let pct = (done.saturating_mul(100) / total) as i64;
        if pct != last_pct.get() && pct % 5 == 0 {
          last_pct.set(pct);
          eprintln!(
            "[vm-image] downloading sandbox image… {}% ({}/{} bytes)",
            pct, done, total
          );
        }
      }
    };
    let staged_paths = vm::image::stage_vm_resources(&vm_resource_paths, data_dir, &progress)?;

    // Create workspace directory
    let workspace_dir = data_dir.join("workspace");
    std::fs::create_dir_all(&workspace_dir)?;

    // Build VM configuration. This is the HOST-side sandbox port (the host→guest
    // forward listens here); it may be dynamic. The guest sandbox always binds
    // 8080 (baked default), which is the guest side of the forward.
    let sandbox_host_port: u16 = std::env::var("SANDBOX_PORT")
      .ok()
      .and_then(|s| s.parse().ok())
      .unwrap_or(8080);

    let sandbox_internal_token =
      std::env::var("SANDBOX_INTERNAL_TOKEN").unwrap_or_else(|_| "dev-sandbox-token".to_string());

    let allowed_origins =
      std::env::var("ALLOWED_ORIGINS").unwrap_or_else(|_| "http://localhost:8788".to_string());

    let controlplane_url = std::env::var("CONTROLPLANE_URL")
      .unwrap_or_else(|_| {
        let port = std::env::var("CONTROLPLANE_PORT").unwrap_or_else(|_| "8787".to_string());
        // The sandbox calls back to the controlplane for integration-policy
        // gateway requests, domain approvals, and execution callbacks.
        // host_loopback_url returns the QEMU/SLIRP host alias (correct for the
        // Linux QEMU backend and the macOS QEMU fallback). See its doc comment
        // for the macOS native Virtualization.framework caveat; set
        // CONTROLPLANE_URL explicitly when the controlplane lives elsewhere.
        vm::host_loopback_url(&port)
      });
    let internal_api_token =
      std::env::var("INTERNAL_API_TOKEN").unwrap_or_else(|_| "dev-internal-token".to_string());

    // Host-side control-plane port for the guest→host reverse bridge. Matches the
    // port the control-plane workerd actually bound to (possibly dynamic). The
    // guest side of the bridge stays baked at 8787.
    let controlplane_host_port: u16 = std::env::var("CONTROLPLANE_PORT")
      .ok()
      .and_then(|s| s.parse().ok())
      .unwrap_or(8787);

    let mut config = VMConfig::new(staged_paths.image.clone(), workspace_dir)
      .with_cpus(2)
      .with_memory(2 * 1024 * 1024 * 1024) // 2GB
      .with_port(sandbox_host_port)
      .with_controlplane_host_port(controlplane_host_port)
      // Guest binds 8080 (image default); the host→guest forward maps the dynamic
      // host port to that. PORT here is the guest bind, not the host listen.
      .with_env("PORT", vm::SANDBOX_GUEST_PORT.to_string())
      .with_env("SANDBOX_INTERNAL_TOKEN", sandbox_internal_token)
      .with_env("ALLOWED_ORIGINS", allowed_origins)
      .with_env("WORKSPACE_BASE", "/workspace")
      .with_env("CONTROLPLANE_URL", controlplane_url)
      .with_env("INTERNAL_API_TOKEN", internal_api_token);

    // Opt-in: enable the network egress proxy inside the VM. Off by default
    // because it requires iptables setup at boot; users who want it set the
    // env var before launching.
    if let Ok(value) = std::env::var("EGRESS_PROXY_ENABLED") {
      if !value.is_empty() {
        config = config.with_env("EGRESS_PROXY_ENABLED", value);
      }
    }

    // Add kernel/initrd/vz-helper for macOS direct boot
    if let Some(kernel) = staged_paths.kernel {
      config = config.with_kernel(kernel);
    }
    if let Some(initrd) = staged_paths.initrd {
      config = config.with_initrd(initrd);
    }
    if let Some(vz_helper) = staged_paths.vz_helper {
      config = config.with_vz_helper(vz_helper);
    }

    // Default kernel command line; VZ virtio console shows up as hvc0 on macOS.
    // net.ifnames=0 biosdevname=0: force legacy interface naming so the virtio NIC
    // is `eth0` instead of `enp0s1`. This is paired with the DHCP bring-up in the
    // VM's minimal init (vm/scripts/build-images.sh MININIT): the macOS direct-boot
    // path runs that init, NOT OpenRC, so it leases an address on eth0 itself.
    // Without both halves the guest has no IP/DNS/route → no internet (npm hangs).
    let cmdline = if cfg!(target_os = "macos") {
      "console=hvc0 earlycon=virtio_console keep_bootcon root=/dev/vda rw net.ifnames=0 biosdevname=0 loglevel=7 ignore_loglevel rdinit=/init"
    } else {
      "console=ttyS0 root=/dev/vda rw net.ifnames=0 biosdevname=0 quiet"
    };
    config = config.with_cmdline(cmdline);

    // Create and start VM
    let mut vm = create_platform_vm();
    vm.start(&config)?;

    // Wait for sandbox to be healthy
    eprintln!("Waiting for sandbox VM to become healthy...");
    vm.wait_for_health(Duration::from_secs(120))?;

    if let Some(url) = vm.sandbox_url() {
      eprintln!("Sandbox VM running at {}", url);
    }

    let vm_pid = vm.pid();

    // Store VM instance
    if let Ok(mut vm_lock) = self.sandbox_vm.lock() {
      *vm_lock = Some(vm);
    }

    // Re-write PID file with VM process included
    if let Ok(dd) = self.data_dir.lock() {
      if let Some(ref data_dir) = *dd {
        if let Ok(children) = self.children.lock() {
          write_pid_file(data_dir, &children, vm_pid);
        }
      }
    }

    Ok(())
  }

  fn spawn_binary(&self, binary_path: &Path, label: &str, args: &[&str], envs: &[(&str, String)]) {
    if !binary_path.exists() {
      eprintln!(
        "Desktop service binary not found for {}: {}",
        label,
        binary_path.display()
      );
      return;
    }

    let mut command = Command::new(binary_path);
    command.args(args);
    command.stdout(Stdio::inherit());
    command.stderr(Stdio::inherit());
    for (key, value) in envs {
      command.env(key, value);
    }

    match command.spawn() {
      Ok(child) => {
        if let Ok(mut children) = self.children.lock() {
          children.push(child);
        }
      }
      Err(err) => {
        eprintln!("Failed to start {}: {}", label, err);
      }
    }
  }

  fn shutdown(&self) {
    // Stop sandbox VM first
    if let Ok(mut vm_lock) = self.sandbox_vm.lock() {
      if let Some(ref mut vm) = *vm_lock {
        eprintln!("Stopping sandbox VM...");
        let _ = vm.stop();
      }
    }

    // Stop child processes: SIGTERM first for graceful shutdown, then SIGKILL
    if let Ok(mut children) = self.children.lock() {
      // Send SIGTERM to all children
      for child in children.iter() {
        #[cfg(unix)]
        unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
      }
      // Wait briefly for graceful exit
      std::thread::sleep(Duration::from_secs(2));
      // Force kill any survivors
      for child in children.iter_mut() {
        let _ = child.kill();
        let _ = child.wait();
      }
    }

    // Remove PID + ports files since we've cleaned up
    if let Ok(dd) = self.data_dir.lock() {
      if let Some(ref data_dir) = *dd {
        let _ = std::fs::remove_file(pid_file_path(data_dir));
        let _ = std::fs::remove_file(ports_file_path(data_dir));
      }
    }
  }
}

impl Drop for DesktopServices {
  fn drop(&mut self) {
    self.shutdown();
  }
}

fn resolve_resource_root(app: &tauri::App) -> Option<PathBuf> {
  if let Ok(root) = std::env::var("ORCABOT_DESKTOP_ROOT") {
    let root_path = PathBuf::from(root);
    if resource_layout_valid(&root_path) {
      return Some(root_path);
    }
  }

  // Installed .app: bundled resources live at Contents/Resources/resources/
  // (the tauri.conf resource paths are prefixed with "resources/"), while
  // resource_dir() points at Contents/Resources. Check that `resources` subdir
  // first, then the dir itself. Without this, an installed app only resolved via
  // the compile-time dev path below, so it worked on the build machine but had
  // no resources (and skipped autostart) on any other Mac.
  if let Ok(resource_dir) = app.path().resource_dir() {
    for candidate in [resource_dir.join("resources"), resource_dir] {
      if resource_layout_valid(&candidate) {
        return Some(candidate);
      }
    }
  }

  let dev_resource_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
  if resource_layout_valid(&dev_resource_dir) {
    return Some(dev_resource_dir);
  }

  None
}

fn resource_layout_valid(root: &Path) -> bool {
  root.join("workerd/workerd").exists() && root.join("d1-shim/d1-shim").exists()
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> std::io::Result<()> {
  use std::os::unix::fs::PermissionsExt;

  let mut perms = std::fs::metadata(path)?.permissions();
  perms.set_mode(0o755);
  std::fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> std::io::Result<()> {
  Ok(())
}

fn stage_executable(src: &Path, dest: &Path) -> std::io::Result<PathBuf> {
  let needs_copy = match (std::fs::metadata(src), std::fs::metadata(dest)) {
    (Ok(src_meta), Ok(dest_meta)) => {
      let src_modified = src_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
      let dest_modified = dest_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
      src_modified > dest_modified || src_meta.len() != dest_meta.len()
    }
    (Ok(_), Err(_)) => true,
    (Err(err), _) => return Err(err),
  };

  if needs_copy {
    std::fs::copy(src, dest)?;
  }

  ensure_executable(dest)?;
  Ok(dest.to_path_buf())
}

fn wait_for_health(port: &str) {
  let addr = format!("127.0.0.1:{}", port);
  for _ in 0..10 {
    if let Ok(mut stream) = std::net::TcpStream::connect(&addr) {
      let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
      let _ = stream.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
      let mut buf = [0u8; 128];
      let n = stream.read(&mut buf).unwrap_or(0);
      // Ready only on a real HTTP response. We accept ANY status (the d1-shim and
      // frontend workerd legitimately 404 on /health) but require the "HTTP/"
      // status line, so a stray non-HTTP listener on the port isn't mistaken for
      // a healthy service.
      if String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/") {
        return;
      }
    }
    std::thread::sleep(Duration::from_millis(500));
  }
}

/// POST /init-db to apply the D1 schema (idempotent). Best-effort: logs and
/// continues on failure so a transient hiccup never blocks app startup.
fn apply_schema(port: &str, internal_token: &str) {
  let addr = format!("127.0.0.1:{}", port);
  match std::net::TcpStream::connect(&addr) {
    Ok(mut stream) => {
      let req = format!(
        "POST /init-db HTTP/1.1\r\nHost: localhost\r\nX-Internal-Token: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        internal_token
      );
      let _ = stream.write_all(req.as_bytes());
      let mut buf = [0u8; 256];
      let n = stream.read(&mut buf).unwrap_or(0);
      let head = String::from_utf8_lossy(&buf[..n]);
      let status = head.lines().next().unwrap_or("");
      if status.contains(" 200") {
        eprintln!("[schema] applied via /init-db");
      } else {
        eprintln!("[schema] /init-db unexpected response: {status}");
      }
    }
    Err(err) => eprintln!("[schema] could not reach control plane for /init-db: {err}"),
  }
}

fn main() {
  eprintln!(
    "[main] REVISION: {} loaded at {}",
    MODULE_REVISION,
    SystemTime::now()
      .duration_since(SystemTime::UNIX_EPOCH)
      .map(|d| format!("{}s", d.as_secs()))
      .unwrap_or_default()
  );

  let app = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![
      commands::get_workspace_path,
      commands::import_folder,
      commands::switch_to_cli,
      commands::quit_app,
      commands::get_surface_token,
      commands::open_url,
      commands::reveal_workspace,
      commands::get_ports,
      commands::get_app_version,
      commands::verify_orcabot_account,
      commands::set_cloud_credential,
      commands::get_cloud_account,
      commands::clear_cloud_credential,
      commands::list_cloud_dashboards,
      commands::get_cloud_dashboard,
      commands::poll_cloud_google_result,
    ])
    .setup(|app| {
      let services = Arc::new(DesktopServices::new());
      let handler_services = Arc::clone(&services);
      let _ = ctrlc::set_handler(move || {
        handler_services.shutdown();
        std::process::exit(0);
      });

      // Start core services (d1-shim, workerd) — blocks until healthy (~5-10s)
      services.start(app);

      // Register workspace state for Tauri commands
      let data_dir = app.path().app_data_dir().ok();
      if let Some(ref dd) = data_dir {
        let workspace_path = dd.join("workspace");
        let _ = std::fs::create_dir_all(&workspace_path);
        app.manage(WorkspaceState { workspace_path });
      } else {
        // Fallback: manage with empty path (commands will return errors)
        app.manage(WorkspaceState {
          workspace_path: PathBuf::new(),
        });
      }

      // Start sandbox VM in a background thread so the window appears immediately
      // instead of blocking for up to 120s waiting for the VM health check.
      let resource_root = resolve_resource_root(app);
      if let (Some(rr), Some(dd)) = (resource_root, data_dir) {
        let vm_services = Arc::clone(&services);
        std::thread::spawn(move || {
          if let Err(err) = vm_services.start_sandbox_vm(&dd, &rr) {
            eprintln!("Failed to start sandbox VM: {}", err);
            eprintln!("Sandbox features will be unavailable.");
          }
        });
      }

      app.manage(Arc::clone(&services));

      // Headless mode (used by the `orcabot` CLI): run all services in the
      // background with no GUI. The window is created hidden (tauri.conf.json
      // visible=false); in GUI mode we show it, in headless we leave it hidden and
      // drop the macOS dock icon so this behaves like a daemon.
      let headless = std::env::var("ORCABOT_DESKTOP_HEADLESS")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
      if headless {
        eprintln!("[main] HEADLESS: services running in background, no GUI window");
        #[cfg(target_os = "macos")]
        {
          let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
        }
      } else {
        for (_, w) in app.webview_windows() {
          let _ = w.show();
          let _ = w.set_focus();
        }
      }

      // Surface toggle: SIGUSR1 -> show the GUI (switch to "desktop"), SIGUSR2 ->
      // hide it (switch to "cli"/headless). Lets `orcabot desktop` / `orcabot cli`
      // flip the surface of the already-running backend without a restart.
      {
        use signal_hook::consts::{SIGUSR1, SIGUSR2};
        let handle = app.handle().clone();
        if let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGUSR1, SIGUSR2]) {
          std::thread::spawn(move || {
            for sig in signals.forever() {
              let show = sig == SIGUSR1;
              let h = handle.clone();
              let _ = handle.run_on_main_thread(move || {
                for (_, w) in h.webview_windows() {
                  if show {
                    let _ = w.show();
                    let _ = w.set_focus();
                  } else {
                    let _ = w.hide();
                  }
                }
                #[cfg(target_os = "macos")]
                {
                  let _ = h.set_activation_policy(if show {
                    tauri::ActivationPolicy::Regular
                  } else {
                    tauri::ActivationPolicy::Accessory
                  });
                }
              });
              eprintln!(
                "[surface] signal {} -> {}",
                sig,
                if show { "desktop (show window)" } else { "cli (hide window)" }
              );
            }
          });
        }
      }
      // Update check (GUI only — skip in the headless CLI backend so `orcabot`
      // sessions don't trigger updates). We only *check* automatically; the heavy
      // part (a ~1GB download + install + restart) is gated behind an explicit
      // prompt, because restarting tears down any running VM/terminal/agent
      // session (RunEvent::Exit shuts the services down).
      if !headless {
        use tauri::Emitter;
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        use tauri_plugin_updater::UpdaterExt;
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
          let updater = match handle.updater() {
            Ok(u) => u,
            Err(e) => { eprintln!("[updater] unavailable: {e}"); return; }
          };
          let update = match updater.check().await {
            Ok(Some(u)) => u,
            Ok(None) => { eprintln!("[updater] up to date"); return; }
            Err(e) => { eprintln!("[updater] check failed: {e}"); return; }
          };
          eprintln!("[updater] update {} available", update.version);
          let proceed = handle
            .dialog()
            .message(format!(
              "Orcabot {} is available.\n\nInstalling it will download the update and restart the app — any running terminals, agents, or VM session will stop.",
              update.version
            ))
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom(
              "Update & restart".to_string(),
              "Later".to_string(),
            ))
            .blocking_show();
          if !proceed {
            eprintln!("[updater] update deferred by user");
            return;
          }

          // Tell the GUI a download is starting so it can show a progress bar,
          // then stream progress from the download closure. Emits are throttled
          // to once per MB so a ~190MB download doesn't flood IPC.
          let _ = handle.emit(
            "update-progress",
            UpdateProgress { phase: "starting", downloaded: 0, total: None, message: None },
          );
          let h_chunk = handle.clone();
          let h_done = handle.clone();
          let got = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
          let last_mb = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
          let got_c = got.clone();
          let result = update
            .download_and_install(
              move |chunk, total| {
                use std::sync::atomic::Ordering::Relaxed;
                let so_far = got_c.fetch_add(chunk as u64, Relaxed) + chunk as u64;
                let mb = so_far / (1024 * 1024);
                if mb != last_mb.swap(mb, Relaxed) {
                  let _ = h_chunk.emit(
                    "update-progress",
                    UpdateProgress { phase: "downloading", downloaded: so_far, total, message: None },
                  );
                }
              },
              move || {
                let _ = h_done.emit(
                  "update-progress",
                  UpdateProgress { phase: "installing", downloaded: 0, total: None, message: None },
                );
              },
            )
            .await;
          match result {
            Ok(_) => { eprintln!("[updater] installed; relaunching"); handle.restart(); }
            Err(e) => {
              eprintln!("[updater] install failed: {e}");
              let _ = handle.emit(
                "update-progress",
                UpdateProgress { phase: "error", downloaded: 0, total: None, message: Some(e.to_string()) },
              );
            }
          }
        });
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    match event {
      RunEvent::ExitRequested { .. } | RunEvent::Exit => {
        if let Some(services) = app_handle.try_state::<Arc<DesktopServices>>() {
          services.shutdown();
        }
      }
      _ => {}
    }
  });
}
