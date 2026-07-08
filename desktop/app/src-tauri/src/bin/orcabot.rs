// REVISION: orcabot-cli-v19-pull-path-guard
//
// `orcabot` — command-line control for the Orcabot desktop stack.
//
// It launches the desktop services *headlessly* (no GUI window) as a background
// process, then drives them from the terminal: run commands in the sandbox VM,
// check status, and (incrementally) initiate agents and connections — i.e. the
// same things the in-app chat does, from the outside.
//
// Transport: the desktop app exposes the control plane on 127.0.0.1:8787 and the
// sandbox on 127.0.0.1:8080 (host loopback). `exec` uses the sandbox /debug/exec
// endpoint, authenticated with the per-boot token the VM writes to its console.
//
// PLATFORM: this CLI is inherently unix (POSIX signals, setsid/pre_exec, vsock,
// PTYs). It's gated to unix so the desktop crate still compiles on Windows (where
// the desktop app itself is only a stub today). Non-unix builds get the stub main
// below; the real implementation lives in the `unix_cli` module.

#[cfg(not(unix))]
fn main() {
    eprintln!("orcabot: the CLI is supported on macOS and Linux only.");
    std::process::exit(1);
}

#[cfg(unix)]
fn main() {
    unix_cli::run();
}

#[cfg(unix)]
mod unix_cli {

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, List, ListItem, Paragraph};
use ratatui::{DefaultTerminal, Frame};

use tungstenite::Message;

const CONTROLPLANE_PORT: u16 = 8787;
const SANDBOX_PORT: u16 = 8080;
const FRONTEND_PORT: u16 = 8788;
const VZ_CONSOLE_LOG: &str = "/tmp/vz-console.log";
const REVISION: &str = "orcabot-cli-v19-pull-path-guard";

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    // Bare `orcabot` opens the interactive TUI — the primary interface.
    let cmd = args.get(1).map(String::as_str).unwrap_or("tui");
    let rest = &args[args.len().min(2)..];

    let code = match cmd {
        "tui" | "ui" => cmd_tui(),
        "desktop" | "gui" => cmd_desktop(),
        "cli" => cmd_cli(rest),
        "web" => cmd_web(rest),
        "export" => cmd_export(rest),
        "import" => cmd_import(rest),
        "push" => cmd_push(rest),
        "pull" => cmd_pull(rest),
        "token" => cmd_token(rest),
        "ls" | "components" => cmd_ls(rest),
        "tail" => cmd_tail(rest),
        "new" | "create" => cmd_new(rest),
        "connect" => cmd_connect(rest),
        "attach" => cmd_attach(rest),
        "detach" => cmd_detach(rest),
        "up" | "start" => cmd_up(rest),
        "down" | "stop" => cmd_down(),
        "status" => cmd_status(),
        "exec" => cmd_exec(rest),
        "help" | "-h" | "--help" => {
            print_help();
            0
        }
        "version" | "--version" => {
            println!("orcabot {}", REVISION);
            0
        }
        other => {
            eprintln!("orcabot: unknown command '{}'\n", other);
            print_help();
            2
        }
    };
    std::process::exit(code);
}

fn print_help() {
    println!(
        "orcabot — control the Orcabot desktop stack from the terminal\n\n\
         USAGE:\n  orcabot <command> [args]\n\n\
         COMMANDS:\n\
         \x20 (no args) / tui    Open the interactive TUI (starts the stack if needed; stops it on quit)\n\
         \x20 desktop            Switch the running stack to the desktop GUI (show window)\n\
         \x20 cli                Switch to the CLI surface (hide the GUI) and open the TUI\n\
         \x20 web                Open the web surface (requires transferring the session)\n\
         \x20 export [--out f]   Package a dashboard + workspace into a .orcabot bundle\n\
         \x20 import <file>      Recreate a dashboard + workspace from a .orcabot bundle\n\
         \x20 push [id] --remote URL [--token T]   Copy a local dashboard to a remote control plane\n\
         \x20 pull <id> --remote URL [--token T]   Copy a remote dashboard to the local stack\n\
         \x20 token [list|revoke <id>] [--remote URL]   Mint/list/revoke a personal access token for push/pull\n\
         \x20 ls                 Print the dashboard's components + status (non-interactive)\n\
         \x20 up [--timeout N]   Keep the stack running across commands (explicit; survives until `down`)\n\
         \x20 down               Stop a stack started by `up`\n\
         \x20 status             Show service health (control plane, sandbox, frontend)\n\
         \x20 exec <cmd...>      Run a shell command inside the sandbox VM\n\
         \x20 version            Print CLI revision\n\n\
         EXAMPLES:\n\
         \x20 orcabot                        # open the TUI (starts the stack if it isn't up)\n\
         \x20 orcabot ls\n\
         \x20 orcabot exec 'ip -4 addr show eth0'"
    );
}

// ---- paths / state -------------------------------------------------------

fn data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let p = if cfg!(target_os = "macos") {
        PathBuf::from(home).join("Library/Application Support/com.orcabot.desktop")
    } else {
        PathBuf::from(home).join(".local/share/com.orcabot.desktop")
    };
    let _ = fs::create_dir_all(&p);
    p
}

fn pid_file() -> PathBuf {
    data_dir().join("orcabot-cli.pid")
}

fn headless_log() -> PathBuf {
    data_dir().join("headless.log")
}

/// Resolve the desktop binary, which sits next to this CLI binary.
fn desktop_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let cand = dir.join("orcabot-desktop");
    if cand.exists() {
        Some(cand)
    } else {
        None
    }
}

// ---- http helpers --------------------------------------------------------

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).build()
}

/// GET, returning (status, body) for any HTTP response, None on connection error.
fn http_get(url: &str, timeout: Duration) -> Option<(u16, String)> {
    match agent(timeout).get(url).call() {
        Ok(resp) => Some((resp.status(), resp.into_string().unwrap_or_default())),
        Err(ureq::Error::Status(code, resp)) => {
            Some((code, resp.into_string().unwrap_or_default()))
        }
        Err(_) => None,
    }
}

fn controlplane_healthy() -> bool {
    matches!(
        http_get(
            &format!("http://127.0.0.1:{}/health", CONTROLPLANE_PORT),
            Duration::from_secs(2)
        ),
        Some((200, _))
    )
}

fn sandbox_health() -> Option<String> {
    match http_get(
        &format!("http://127.0.0.1:{}/health", SANDBOX_PORT),
        Duration::from_secs(2),
    ) {
        Some((200, body)) => Some(body),
        _ => None,
    }
}

// ---- commands ------------------------------------------------------------

fn cmd_up(rest: &[String]) -> i32 {
    let mut timeout_secs = 150u64;
    let mut i = 0;
    while i < rest.len() {
        if rest[i] == "--timeout" {
            if let Some(v) = rest.get(i + 1).and_then(|s| s.parse::<u64>().ok()) {
                timeout_secs = v;
            }
            i += 2;
        } else {
            i += 1;
        }
    }

    if controlplane_healthy() {
        println!("orcabot: stack already running (control plane healthy on :{CONTROLPLANE_PORT})");
        if sandbox_health().is_some() {
            println!("orcabot: sandbox healthy on :{SANDBOX_PORT}");
        } else {
            println!("orcabot: sandbox still starting…");
        }
        return 0;
    }

    let bin = match desktop_binary() {
        Some(b) => b,
        None => {
            eprintln!("orcabot: could not find the orcabot-desktop binary next to this CLI");
            return 1;
        }
    };

    let log_path = headless_log();
    let log = match File::create(&log_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("orcabot: cannot open log {}: {e}", log_path.display());
            return 1;
        }
    };
    let log_err = match log.try_clone() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("orcabot: log clone failed: {e}");
            return 1;
        }
    };

    println!("orcabot: launching headless stack ({})…", bin.display());
    let mut command = Command::new(&bin);
    command
        .env("ORCABOT_DESKTOP_HEADLESS", "1")
        .env("VZ_CONSOLE_DIRECT", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    // Detach into its own session so it survives this CLI process exiting.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("orcabot: failed to launch desktop binary: {e}");
            return 1;
        }
    };
    let pid = child.id();
    let _ = fs::write(pid_file(), pid.to_string());
    println!("orcabot: started (pid {pid}), logs at {}", log_path.display());

    // Wait for readiness.
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut cp_ready = false;
    print!("orcabot: waiting for services");
    let _ = std::io::stdout().flush();
    while Instant::now() < deadline {
        if !cp_ready && controlplane_healthy() {
            cp_ready = true;
            println!("\norcabot: control plane ready (:{CONTROLPLANE_PORT})");
            print!("orcabot: waiting for sandbox VM");
            let _ = std::io::stdout().flush();
        }
        if cp_ready {
            if let Some(h) = sandbox_health() {
                println!("\norcabot: sandbox ready — {}", h.trim());
                println!("orcabot: stack up. Try: orcabot exec 'ip -4 addr show eth0'");
                return 0;
            }
        }
        print!(".");
        let _ = std::io::stdout().flush();
        std::thread::sleep(Duration::from_secs(2));
    }
    eprintln!("\norcabot: timed out after {timeout_secs}s. Check {}", headless_log().display());
    1
}

fn cmd_down() -> i32 {
    // Find the backend via the pid file, else by process name — so a desktop app
    // launched directly (no pid file) can still be stopped.
    let Some(pid) = app_pid().map(|p| p as i32) else {
        eprintln!("orcabot: no running stack found (nothing to stop)");
        let _ = fs::remove_file(pid_file());
        return 1;
    };
    // SIGINT triggers the desktop app's ctrlc/Exit handler → clean shutdown (stops VM).
    let rc = unsafe { libc::kill(pid, libc::SIGINT) };
    if rc != 0 {
        eprintln!("orcabot: process {pid} not running (already stopped?)");
        let _ = fs::remove_file(pid_file());
        return 1;
    }
    print!("orcabot: stopping (pid {pid})");
    let _ = std::io::stdout().flush();
    for _ in 0..20 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            println!("\norcabot: stopped.");
            let _ = fs::remove_file(pid_file());
            return 0;
        }
        print!(".");
        let _ = std::io::stdout().flush();
        std::thread::sleep(Duration::from_millis(500));
    }
    eprintln!("\norcabot: still running after 10s; sending SIGKILL");
    unsafe { libc::kill(pid, libc::SIGKILL) };
    let _ = fs::remove_file(pid_file());
    0
}

// ---- session packaging (export / import a .orcabot bundle) -----------------
//
// A bundle is a .tar.gz: manifest.json (dashboard + items + edges = the canvas) +
// workspace/ (the files). Both ops speak the control-plane API, which is identical
// locally and in the cloud — so `push`/`pull` will reuse this, just retargeted.
// Secrets/integrations are intentionally NOT included (re-add on the destination).

fn workspace_dir() -> PathBuf {
    data_dir().join("workspace")
}

fn cmd_export(rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: run `orcabot up` first");
        return 1;
    }
    let (pos, dash) = split_dash_flag(rest);
    let mut out: Option<String> = None;
    if let Some(i) = pos.iter().position(|a| a == "--out") {
        out = pos.get(i + 1).cloned();
    }
    let did = match first_or_named_dash(dash) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("orcabot: {e}");
            return 1;
        }
    };
    let v = match cp_call("GET", &format!("/dashboards/{}", did), None) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("orcabot: {e}");
            return 1;
        }
    };
    let name = v
        .get("dashboard")
        .and_then(|d| d.get("name"))
        .and_then(|x| x.as_str())
        .unwrap_or("dashboard")
        .to_string();
    let manifest = serde_json::json!({
        "version": 1,
        "name": name,
        "items": v.get("items").cloned().unwrap_or(serde_json::json!([])),
        "edges": v.get("edges").cloned().unwrap_or(serde_json::json!([])),
    });

    let stage = std::env::temp_dir().join(format!("orcabot-export-{}", std::process::id()));
    let _ = fs::remove_dir_all(&stage);
    if let Err(e) = fs::create_dir_all(&stage) {
        eprintln!("orcabot: {e}");
        return 1;
    }
    if let Err(e) = fs::write(
        stage.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default(),
    ) {
        eprintln!("orcabot: {e}");
        return 1;
    }

    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let out_path = out.unwrap_or_else(|| format!("{}.orcabot", safe.trim_matches('-')));
    let ws = workspace_dir();
    let mut args: Vec<String> = vec!["-czf".into(), out_path.clone()];
    // Exclude regenerable caches/transients + live sandbox runtime state (.orcabot)
    // — not user content, and re-importing .orcabot would clobber/stall the target.
    for pat in ["workspace/.browser", "workspace/.npm", "workspace/.orcabot", "workspace/.claude/cache", "*/node_modules", "workspace/node_modules"] {
        args.push("--exclude".into());
        args.push(pat.into());
    }
    args.push("-C".into());
    args.push(stage.to_string_lossy().into());
    args.push("manifest.json".into());
    if ws.exists() {
        args.push("-C".into());
        args.push(data_dir().to_string_lossy().into());
        args.push("workspace".into());
    }
    let status = Command::new("tar").args(&args).status();
    let _ = fs::remove_dir_all(&stage);
    match status {
        Ok(s) if s.success() => {
            let n_items = manifest["items"].as_array().map(|a| a.len()).unwrap_or(0);
            let sz = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
            println!(
                "orcabot: exported '{name}' ({n_items} components, {} KB) -> {out_path}",
                sz / 1024
            );
            0
        }
        _ => {
            eprintln!("orcabot: tar failed creating {out_path}");
            1
        }
    }
}

fn cmd_import(rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: run `orcabot up` first");
        return 1;
    }
    let (pos, _) = split_dash_flag(rest);
    let mut name_override: Option<String> = None;
    if let Some(i) = pos.iter().position(|a| a == "--name") {
        name_override = pos.get(i + 1).cloned();
    }
    let Some(bundle) = pos.first() else {
        eprintln!("usage: orcabot import <file.orcabot> [--name <name>]");
        return 2;
    };
    if !PathBuf::from(bundle).exists() {
        eprintln!("orcabot: bundle not found: {bundle}");
        return 1;
    }

    let stage = std::env::temp_dir().join(format!("orcabot-import-{}", std::process::id()));
    let _ = fs::remove_dir_all(&stage);
    let _ = fs::create_dir_all(&stage);
    let untar = Command::new("tar")
        .args(["-xzf", bundle, "-C", &stage.to_string_lossy()])
        .status();
    if !matches!(untar, Ok(s) if s.success()) {
        eprintln!("orcabot: failed to extract bundle");
        let _ = fs::remove_dir_all(&stage);
        return 1;
    }
    let manifest: serde_json::Value = match fs::read_to_string(stage.join("manifest.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(m) => m,
        None => {
            eprintln!("orcabot: bundle has no valid manifest.json");
            let _ = fs::remove_dir_all(&stage);
            return 1;
        }
    };

    let name = name_override.unwrap_or_else(|| {
        format!(
            "{} (imported)",
            manifest.get("name").and_then(|x| x.as_str()).unwrap_or("dashboard")
        )
    });
    let nd = match cp_call("POST", "/dashboards", Some(serde_json::json!({ "name": name }))) {
        Ok(v) => v
            .get("dashboard")
            .and_then(|d| d.get("id"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        Err(e) => {
            eprintln!("orcabot: create dashboard: {e}");
            let _ = fs::remove_dir_all(&stage);
            return 1;
        }
    };

    // Recreate items, mapping old id -> new id (for edges).
    let mut idmap: HashMap<String, String> = HashMap::new();
    let empty = vec![];
    for it in manifest.get("items").and_then(|x| x.as_array()).unwrap_or(&empty) {
        let body = serde_json::json!({
            "type": it.get("type"),
            "content": it.get("content").cloned().unwrap_or(serde_json::json!("")),
            "position": it.get("position"),
            "size": it.get("size"),
            "metadata": it.get("metadata"),
        });
        match cp_call("POST", &format!("/dashboards/{}/items", nd), Some(body)) {
            Ok(r) => {
                if let (Some(old), Some(new)) = (
                    it.get("id").and_then(|x| x.as_str()),
                    r.get("item").and_then(|i| i.get("id")).and_then(|x| x.as_str()),
                ) {
                    idmap.insert(old.to_string(), new.to_string());
                }
            }
            Err(e) => eprintln!("orcabot: skip item: {e}"),
        }
    }
    // Recreate edges with mapped ids.
    let mut edge_n = 0;
    for e in manifest.get("edges").and_then(|x| x.as_array()).unwrap_or(&empty) {
        let s = e.get("sourceItemId").and_then(|x| x.as_str()).and_then(|o| idmap.get(o));
        let t = e.get("targetItemId").and_then(|x| x.as_str()).and_then(|o| idmap.get(o));
        if let (Some(s), Some(t)) = (s, t) {
            let body = serde_json::json!({
                "sourceItemId": s, "targetItemId": t,
                "sourceHandle": e.get("sourceHandle"), "targetHandle": e.get("targetHandle"),
            });
            if cp_call("POST", &format!("/dashboards/{}/edges", nd), Some(body)).is_ok() {
                edge_n += 1;
            }
        }
    }

    // Restore workspace files (merge into the shared workspace).
    let src_ws = stage.join("workspace");
    if src_ws.exists() {
        let dest = workspace_dir();
        let _ = fs::create_dir_all(&dest);
        // cp -R <src>/. <dest>/   (merge, preserve)
        let _ = Command::new("cp")
            .args(["-R", &format!("{}/.", src_ws.to_string_lossy()), &dest.to_string_lossy()])
            .status();
    }
    let _ = fs::remove_dir_all(&stage);

    println!(
        "orcabot: imported '{name}' -> dashboard {} ({} components, {edge_n} edges, workspace restored)",
        nd,
        idmap.len()
    );
    0
}

// ---- push / pull (export/import retargeted at a remote control plane) ------
//
// `push` copies a LOCAL dashboard to a remote control plane; `pull` copies a
// REMOTE dashboard down to the local stack. Both reuse the manifest logic from
// export/import (items + edges, old->new id remap) but move the workspace over
// the file API (GET/PUT /sessions/:id/file) instead of a host cp -R, since a
// remote sandbox lives in its own VM and isn't host-mounted.
//
// The remote is just another control plane, addressed by base URL + auth:
//   --remote <url>            (or env ORCABOT_REMOTE_URL)
//   --token <t>               (or env ORCABOT_REMOTE_TOKEN)  -> Authorization: Bearer
//   --user <id>               -> dev auth X-User-ID (for local/dev targets)
// With no --remote it targets the local stack — useful for verifying the path.
//
// Secrets/integrations are intentionally NOT transferred (re-add on the dest).
// PRODUCTION NOTE: the public cloud uses Cloudflare Access (browser-only) and a
// subscription paywall, so a real `--token` flow needs a CLI token endpoint +
// paywall handling on the server first; the client path here is complete.

/// How the CLI authenticates to a control plane.
enum RemoteAuth {
    /// Local/dev control plane: the full dev-auth identity. Email + name are
    /// REQUIRED, not optional — the control plane only auto-creates a user on a
    /// clean DB when an email is present, and it resolves an existing user by
    /// email, so sending the desktop email is what makes the CLI converge with the
    /// GUI's user (both end up on desktop@localhost). Sending only X-User-ID 401s
    /// on a clean DB.
    Dev { user: String },
    /// Cloud control plane: a personal access token.
    Bearer { token: String },
}

/// A target control plane for push/pull/token: base URL + how to authenticate.
struct Remote {
    base: String,
    auth: RemoteAuth,
}

/// Read the per-boot surface token written by orcabot-desktop to a host-only
/// file. The local control plane gates dev-auth behind it; the CLI is a trusted
/// host client, so it reads the file and sends the matching header.
fn read_surface_token() -> Option<String> {
    std::fs::read_to_string(data_dir().join("surface-token"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

impl Remote {
    fn local() -> Remote {
        Remote {
            base: format!("http://127.0.0.1:{}", CONTROLPLANE_PORT),
            auth: RemoteAuth::Dev { user: DEV_USER.into() },
        }
    }
    fn is_local(&self) -> bool {
        self.base.contains("127.0.0.1") || self.base.contains("localhost")
    }
    /// Apply the auth headers for this remote to a ureq request builder.
    fn apply_auth(&self, req: ureq::Request) -> ureq::Request {
        match &self.auth {
            RemoteAuth::Dev { user } => {
                let req = req
                    .set("X-User-ID", user)
                    .set("X-User-Email", DEV_EMAIL)
                    .set("X-User-Name", DEV_NAME);
                // The local desktop control plane may gate dev-auth behind the
                // per-boot surface token; include it for local targets so the CLI
                // (a trusted host client) isn't rejected. Remote targets don't
                // have this token and don't enforce it.
                match (self.is_local(), read_surface_token()) {
                    (true, Some(t)) => req.set("X-Orcabot-Surface", &t),
                    _ => req,
                }
            }
            RemoteAuth::Bearer { token } => req.set("Authorization", &format!("Bearer {token}")),
        }
    }
}

/// Build a Remote from `--remote/--token/--user` flags (env fallbacks).
fn remote_from(rest: &[String]) -> Remote {
    let mut base = std::env::var("ORCABOT_REMOTE_URL").ok();
    let mut token = std::env::var("ORCABOT_REMOTE_TOKEN").ok();
    let mut user: Option<String> = None;
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--remote" => {
                base = rest.get(i + 1).cloned();
                i += 1;
            }
            "--token" => {
                token = rest.get(i + 1).cloned();
                i += 1;
            }
            "--user" => {
                user = rest.get(i + 1).cloned();
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    let base = base
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", CONTROLPLANE_PORT))
        .trim_end_matches('/')
        .to_string();
    match token {
        Some(t) => Remote { base, auth: RemoteAuth::Bearer { token: t } },
        None => Remote {
            base,
            auth: RemoteAuth::Dev { user: user.unwrap_or_else(|| DEV_USER.into()) },
        },
    }
}

/// First positional (non-flag) token after the subcommand, treated as a dashboard id.
fn first_positional(rest: &[String]) -> Option<String> {
    let flags_with_val = ["--remote", "--token", "--user", "--dash"];
    let mut i = 0;
    while i < rest.len() {
        let a = &rest[i];
        if flags_with_val.contains(&a.as_str()) {
            i += 2;
            continue;
        }
        if a.starts_with("--") {
            i += 1;
            continue;
        }
        return Some(a.clone());
    }
    None
}

fn has_flag(rest: &[String], flag: &str) -> bool {
    rest.iter().any(|a| a == flag)
}

// JSON API call against an arbitrary remote (mirror of cp_call).
fn api_json(
    r: &Remote,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", r.base, path);
    let req = r
        .apply_auth(agent(Duration::from_secs(30)).request(method, &url))
        .set("Origin", &r.base)
        .set("Content-Type", "application/json");
    let resp = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match resp {
        Ok(rp) => Ok(rp.into_json().unwrap_or(serde_json::Value::Null)),
        Err(ureq::Error::Status(c, rp)) => {
            let body = rp.into_string().unwrap_or_default();
            // The cloud control plane gates mutating requests behind the
            // subscription paywall (403 SUBSCRIPTION_REQUIRED). Surface a clean,
            // recognizable error so push/pull/web can show actionable guidance
            // instead of a raw JSON blob.
            if c == 403 && body.contains("SUBSCRIPTION_REQUIRED") {
                return Err(PAYWALL_ERR.to_string());
            }
            Err(format!("HTTP {c}: {}", body.trim()))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Sentinel carried in error strings so callers can detect a paywall denial.
const PAYWALL_ERR: &str = "SUBSCRIPTION_REQUIRED";

fn is_paywall(err: &str) -> bool {
    err.contains(PAYWALL_ERR)
}

/// Actionable message for a paywall denial. `web` is where the user manages billing.
fn paywall_message(remote_base: &str) -> String {
    let web = std::env::var("ORCABOT_WEB_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| remote_base.to_string());
    format!(
        "cloud push/pull needs an active OrcaBot subscription or trial on this account.\n\
         \x20 Manage your subscription in the web app: {web}\n\
         \x20 (Tip: `orcabot token` mints a token regardless, but creating dashboards on the cloud requires a subscription.)"
    )
}

// Workspace file API helpers (path is workspace-relative; ureq percent-encodes the query).
fn file_put(r: &Remote, sid: &str, rel: &str, data: &[u8]) -> Result<(), String> {
    let url = format!("{}/sessions/{}/file", r.base, sid);
    match r
        .apply_auth(agent(Duration::from_secs(120)).put(&url).query("path", rel))
        .set("Content-Type", "application/octet-stream")
        .send_bytes(data)
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(c, rp)) => {
            Err(format!("HTTP {c}: {}", rp.into_string().unwrap_or_default().trim()))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn file_get(r: &Remote, sid: &str, rel: &str) -> Result<Vec<u8>, String> {
    let url = format!("{}/sessions/{}/file", r.base, sid);
    match r
        .apply_auth(agent(Duration::from_secs(120)).get(&url).query("path", rel))
        .call()
    {
        Ok(rp) => {
            let mut buf = Vec::new();
            rp.into_reader().read_to_end(&mut buf).map_err(|e| e.to_string())?;
            Ok(buf)
        }
        Err(ureq::Error::Status(c, rp)) => {
            Err(format!("HTTP {c}: {}", rp.into_string().unwrap_or_default().trim()))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn file_list(r: &Remote, sid: &str) -> Result<Vec<serde_json::Value>, String> {
    let v = api_json(r, "GET", &format!("/sessions/{}/files?path=/&recursive=true", sid), None)?;
    Ok(v.get("files").and_then(|x| x.as_array()).cloned().unwrap_or_default())
}

/// Whether the target sandbox supports bulk workspace import. Probes with a tiny
/// body so we never stream a multi-MB tar to a sandbox that lacks the route — an
/// old sandbox 404s *without draining the body*, which stalls a large upload.
/// 404 => unsupported; anything else (e.g. 400 "bad gzip") => the route exists.
fn workspace_import_supported(r: &Remote, sid: &str) -> bool {
    let url = format!("{}/sessions/{}/workspace/import", r.base, sid);
    match r
        .apply_auth(agent(Duration::from_secs(15)).post(&url))
        .set("Content-Type", "application/gzip")
        .send_bytes(b"\x00\x00")
    {
        Ok(_) => true,
        Err(ureq::Error::Status(404, _)) => false,
        Err(ureq::Error::Status(_, _)) => true,
        Err(_) => false,
    }
}

/// Bulk-import a tar.gz of the workspace in one request. Returns (written, skipped).
/// Bounded: on the desktop the workspace is a host-shared virtiofs mount, and a
/// guest write to a file the macOS host holds open (Spotlight/QuickLook) can
/// stall; on timeout the caller falls back to the resilient per-file path. Cloud
/// (ext4) never stalls, so a normal upload completes well within this bound.
fn workspace_import(r: &Remote, sid: &str, tar_path: &str) -> Result<(u64, u64), String> {
    let data = fs::read(tar_path).map_err(|e| e.to_string())?;
    let url = format!("{}/sessions/{}/workspace/import", r.base, sid);
    let resp = r
        .apply_auth(agent(Duration::from_secs(90)).post(&url))
        .set("Content-Type", "application/gzip")
        .send_bytes(&data);
    match resp {
        Ok(rp) => {
            let v: serde_json::Value = rp.into_json().unwrap_or(serde_json::Value::Null);
            Ok((
                v.get("written").and_then(|x| x.as_u64()).unwrap_or(0),
                v.get("skipped").and_then(|x| x.as_u64()).unwrap_or(0),
            ))
        }
        Err(ureq::Error::Status(c, rp)) => {
            Err(format!("HTTP {c}: {}", rp.into_string().unwrap_or_default().trim()))
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Tar the workspace (workspace-relative entries) with the cache excludes applied.
fn tar_workspace(ws: &std::path::Path, out: &str) -> Result<(), String> {
    let mut args: Vec<String> = vec!["-czf".into(), out.into()];
    // .orcabot is live sandbox runtime state (PTY tracking, run-bridge scripts the
    // sandbox executes, mcp secrets) — never user content, and writing into it on
    // the target blocks the import. Exclude it like the other runtime/cache dirs.
    for pat in ["./.browser", "./.npm", "./.orcabot", "./.claude/cache", "./.git", "./node_modules", "*/node_modules"] {
        args.push("--exclude".into());
        args.push(pat.into());
    }
    args.push("-C".into());
    args.push(ws.to_string_lossy().into());
    args.push(".".into());
    let status = Command::new("tar").args(&args).status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("tar failed".into())
    }
}

/// Regenerable caches / transients / runtime state we never transfer.
fn ws_excluded(rel: &str) -> bool {
    let rel = rel.trim_start_matches('/');
    rel.starts_with(".browser")
        || rel.starts_with(".npm")
        || rel == ".orcabot"
        || rel.starts_with(".orcabot/") // live sandbox runtime state (PTYs, secrets)
        || rel.starts_with(".claude/cache") // regenerable cache; often host-held (virtiofs stall)
        || rel == ".git"
        || rel.starts_with(".git/")
        || rel.split('/').any(|seg| seg == "node_modules")
}

/// Resolve a workspace-relative path (from a REMOTE `pull`) to a host path,
/// rejecting anything that would escape the workspace. `pull` writes files the
/// remote control plane lists, so a malicious/compromised remote could return
/// `../...` or a path through an in-workspace symlink and clobber arbitrary host
/// files. Returns None (caller skips) for unsafe paths. Does NOT create anything.
/// (The sandbox import path is already scoped via Workspace.Write; this is the
/// equivalent guard for the local write side.)
fn safe_workspace_dest(ws_canon: &std::path::Path, rel: &str) -> Option<PathBuf> {
    use std::path::Component;
    let rel_path = std::path::Path::new(rel);
    // 1) Lexical: only plain names (reject "..", absolute/root, drive prefix).
    for c in rel_path.components() {
        if !matches!(c, Component::Normal(_) | Component::CurDir) {
            return None;
        }
    }
    let dest = ws_canon.join(rel_path);
    // 2) Symlink-safe: the nearest EXISTING ancestor must resolve inside the
    //    workspace (an in-ws symlink pointing out would otherwise be followed on
    //    write). Non-existent tail components are created later under a verified
    //    ancestor, and contain no symlinks (they don't exist yet).
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

/// Recreate a dashboard (items + edges, old->new item-id remap) on `dest`.
/// Returns (new dashboard id, idmap, edges created).
fn recreate_dashboard(
    dest: &Remote,
    name: &str,
    items: &[serde_json::Value],
    edges: &[serde_json::Value],
) -> Result<(String, HashMap<String, String>, usize), String> {
    let created = api_json(dest, "POST", "/dashboards", Some(serde_json::json!({ "name": name })))?;
    let nd = created
        .get("dashboard")
        .and_then(|d| d.get("id"))
        .and_then(|x| x.as_str())
        .ok_or("remote did not return a dashboard id")?
        .to_string();

    let mut idmap: HashMap<String, String> = HashMap::new();
    for it in items {
        let body = serde_json::json!({
            "type": it.get("type"),
            "content": it.get("content").cloned().unwrap_or(serde_json::json!("")),
            "position": it.get("position"),
            "size": it.get("size"),
            "metadata": it.get("metadata"),
        });
        match api_json(dest, "POST", &format!("/dashboards/{}/items", nd), Some(body)) {
            Ok(rp) => {
                if let (Some(old), Some(new)) = (
                    it.get("id").and_then(|x| x.as_str()),
                    rp.get("item").and_then(|i| i.get("id")).and_then(|x| x.as_str()),
                ) {
                    idmap.insert(old.to_string(), new.to_string());
                }
            }
            Err(e) => eprintln!("orcabot: skip item: {e}"),
        }
    }

    let mut edge_n = 0;
    for e in edges {
        let s = e.get("sourceItemId").and_then(|x| x.as_str()).and_then(|o| idmap.get(o));
        let t = e.get("targetItemId").and_then(|x| x.as_str()).and_then(|o| idmap.get(o));
        if let (Some(s), Some(t)) = (s, t) {
            let body = serde_json::json!({
                "sourceItemId": s, "targetItemId": t,
                "sourceHandle": e.get("sourceHandle"), "targetHandle": e.get("targetHandle"),
            });
            if api_json(dest, "POST", &format!("/dashboards/{}/edges", nd), Some(body)).is_ok() {
                edge_n += 1;
            }
        }
    }
    Ok((nd, idmap, edge_n))
}

/// Ensure `dash` on `r` has an active session (a live sandbox) and return its
/// control-plane session id, so we can read/write the workspace over the file API.
/// Reuses an active session, else starts an existing terminal, else creates one.
fn ensure_session(r: &Remote, dash: &str) -> Result<String, String> {
    let snapshot = |r: &Remote| -> Result<(Option<String>, Option<String>), String> {
        // -> (active session id, an item id of some terminal without an active session)
        let v = api_json(r, "GET", &format!("/dashboards/{}", dash), None)?;
        let sessions = v.get("sessions").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        for s in &sessions {
            if s.get("status").and_then(|x| x.as_str()) == Some("active") {
                if let Some(id) = s.get("id").and_then(|x| x.as_str()) {
                    return Ok((Some(id.to_string()), None));
                }
            }
        }
        let items = v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default();
        let term = items
            .iter()
            .find(|it| it.get("type").and_then(|x| x.as_str()) == Some("terminal"))
            .and_then(|it| it.get("id").and_then(|x| x.as_str()).map(String::from));
        Ok((None, term))
    };

    let (active, term) = snapshot(r)?;
    if let Some(sid) = active {
        return Ok(sid);
    }
    // Need a terminal item to host a session; create a transfer terminal if none.
    let item_id = match term {
        Some(t) => t,
        None => {
            let body = serde_json::json!({
                "type": "terminal",
                "content": "{\"name\":\"transfer\",\"bootCommand\":\"\"}",
            });
            let rp = api_json(r, "POST", &format!("/dashboards/{}/items", dash), Some(body))?;
            rp.get("item")
                .and_then(|i| i.get("id"))
                .and_then(|x| x.as_str())
                .ok_or("could not create a transfer terminal")?
                .to_string()
        }
    };
    let _ = api_json(
        r,
        "POST",
        &format!("/dashboards/{}/items/{}/session", dash, item_id),
        Some(serde_json::json!({})),
    )?;
    // Poll for the session to go active (cloud spins up a VM — allow generous time).
    for _ in 0..60 {
        std::thread::sleep(Duration::from_secs(2));
        let v = api_json(r, "GET", &format!("/dashboards/{}", dash), None)?;
        if let Some(sessions) = v.get("sessions").and_then(|x| x.as_array()) {
            for s in sessions {
                if s.get("itemId").and_then(|x| x.as_str()) == Some(item_id.as_str())
                    && s.get("status").and_then(|x| x.as_str()) == Some("active")
                {
                    if let Some(id) = s.get("id").and_then(|x| x.as_str()) {
                        return Ok(id.to_string());
                    }
                }
            }
        }
    }
    Err("timed out waiting for a sandbox session on the target".into())
}

/// Copy a local dashboard to `dest`. Returns the new remote dashboard id.
/// Recreates canvas (items+edges) and, unless `include_workspace` is false,
/// transfers the workspace over the file API. Prints progress.
fn push_dashboard(dest: &Remote, did: &str, include_workspace: bool) -> Result<String, String> {
    let v = cp_call("GET", &format!("/dashboards/{}", did), None)
        .map_err(|e| format!("read local dashboard: {e}"))?;
    let name = v
        .get("dashboard")
        .and_then(|d| d.get("name"))
        .and_then(|x| x.as_str())
        .unwrap_or("dashboard")
        .to_string();
    let empty = vec![];
    let items = v.get("items").and_then(|x| x.as_array()).unwrap_or(&empty).clone();
    let edges = v.get("edges").and_then(|x| x.as_array()).unwrap_or(&empty).clone();

    if dest.is_local() {
        eprintln!("orcabot: note — target is the local control plane (verification mode; same VM/workspace)");
    }
    println!("orcabot: pushing '{name}' ({} components) -> {}", items.len(), dest.base);

    let (nd, idmap, edge_n) = recreate_dashboard(dest, &name, &items, &edges)
        .map_err(|e| format!("recreate on remote failed: {e}"))?;
    println!("orcabot: created remote dashboard {nd} ({} components, {edge_n} edges)", idmap.len());

    if !include_workspace {
        println!("orcabot: pushed (canvas only; --no-workspace).");
        return Ok(nd);
    }

    let sid = ensure_session(dest, &nd)
        .map_err(|e| format!("could not get a remote sandbox for workspace transfer: {e}"))?;

    let ws = workspace_dir();
    // Prefer one bulk tar import (orders of magnitude faster than per-file PUT).
    // Probe first (tiny body) so we never stream a big tar to a sandbox that
    // lacks the route; fall back to per-file PUT when it's unavailable.
    let mut did_bulk = false;
    if workspace_import_supported(dest, &sid) {
        let tar_path = std::env::temp_dir()
            .join(format!("orcabot-push-{}.tgz", std::process::id()))
            .to_string_lossy()
            .to_string();
        match tar_workspace(&ws, &tar_path).and_then(|_| workspace_import(dest, &sid, &tar_path)) {
            Ok((written, skipped)) => {
                println!(
                    "orcabot: pushed '{name}' -> {} (dashboard {nd}; {written} files, {skipped} skipped, bulk)",
                    dest.base
                );
                did_bulk = true;
            }
            Err(e) => eprintln!("orcabot: bulk import failed ({e}); falling back to per-file…"),
        }
        let _ = fs::remove_file(&tar_path);
    } else {
        eprintln!("orcabot: bulk import not supported by the target; using per-file…");
    }
    if !did_bulk {
        let (n, bytes, skipped) = push_workspace_perfile(dest, &sid, &ws);
        println!(
            "orcabot: pushed '{name}' -> {} (dashboard {nd}; {n} files, {} MB, {skipped} skipped)",
            dest.base,
            bytes / 1_048_576
        );
    }
    Ok(nd)
}

/// Per-file workspace upload (PUT /file each). Fallback when bulk import is absent.
/// Returns (files, bytes, skipped).
fn push_workspace_perfile(dest: &Remote, sid: &str, ws: &std::path::Path) -> (u64, u64, u64) {
    let (mut n, mut bytes, mut skipped) = (0u64, 0u64, 0u64);
    for entry in walkdir::WalkDir::new(ws).follow_links(false).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = match entry.path().strip_prefix(ws) {
            Ok(r) => r.to_string_lossy().to_string(),
            Err(_) => continue,
        };
        if ws_excluded(&rel) {
            continue;
        }
        let data = match fs::read(entry.path()) {
            Ok(d) => d,
            Err(_) => continue,
        };
        if data.len() as u64 > 100 * 1024 * 1024 {
            eprintln!("orcabot: skip (>100MB): {rel}");
            skipped += 1;
            continue;
        }
        match file_put(dest, sid, &rel, &data) {
            Ok(()) => {
                n += 1;
                bytes += data.len() as u64;
                if n % 50 == 0 {
                    println!("orcabot: …{n} files ({} MB)", bytes / 1_048_576);
                }
            }
            Err(e) => {
                eprintln!("orcabot: skip {rel}: {e}");
                skipped += 1;
            }
        }
    }
    (n, bytes, skipped)
}

fn cmd_push(rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: run `orcabot up` first (push reads the local stack)");
        return 1;
    }
    let dest = remote_from(rest);
    let include_ws = !has_flag(rest, "--no-workspace");
    let did = match rest
        .iter()
        .position(|a| a == "--dash")
        .and_then(|i| rest.get(i + 1).cloned())
        .or_else(|| first_positional(rest))
    {
        Some(d) => d,
        None => match first_or_named_dash(None) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("orcabot: {e}");
                return 1;
            }
        },
    };
    match push_dashboard(&dest, &did, include_ws) {
        Ok(_) => 0,
        Err(e) if is_paywall(&e) => {
            eprintln!("orcabot: {}", paywall_message(&dest.base));
            1
        }
        Err(e) => {
            eprintln!("orcabot: {e}");
            1
        }
    }
}

fn cmd_pull(rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: run `orcabot up` first (pull writes the local stack)");
        return 1;
    }
    let src = remote_from(rest);
    let no_ws = has_flag(rest, "--no-workspace");
    let did = match rest
        .iter()
        .position(|a| a == "--dash")
        .and_then(|i| rest.get(i + 1).cloned())
        .or_else(|| first_positional(rest))
    {
        Some(d) => d,
        None => {
            eprintln!("usage: orcabot pull <dashboardId> --remote <url> [--token <t>]");
            return 2;
        }
    };

    let v = match api_json(&src, "GET", &format!("/dashboards/{}", did), None) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("orcabot: read remote dashboard: {e}");
            return 1;
        }
    };
    let name = format!(
        "{} (pulled)",
        v.get("dashboard")
            .and_then(|d| d.get("name"))
            .and_then(|x| x.as_str())
            .unwrap_or("dashboard")
    );
    let empty = vec![];
    let items = v.get("items").and_then(|x| x.as_array()).unwrap_or(&empty).clone();
    let edges = v.get("edges").and_then(|x| x.as_array()).unwrap_or(&empty).clone();

    let local = Remote::local();
    println!("orcabot: pulling '{name}' ({} components) <- {}", items.len(), src.base);
    let (nd, idmap, edge_n) = match recreate_dashboard(&local, &name, &items, &edges) {
        Ok(x) => x,
        Err(e) => {
            eprintln!("orcabot: recreate locally failed: {e}");
            return 1;
        }
    };
    println!("orcabot: created local dashboard {nd} ({} components, {edge_n} edges)", idmap.len());

    if no_ws {
        println!("orcabot: pulled (canvas only; --no-workspace).");
        return 0;
    }

    let sid = match ensure_session(&src, &did) {
        Ok(s) => s,
        Err(e) if is_paywall(&e) => {
            eprintln!("orcabot: canvas pulled, but the workspace needs a live sandbox — {}", paywall_message(&src.base));
            return 1;
        }
        Err(e) => {
            eprintln!("orcabot: could not get a remote sandbox to read the workspace: {e}");
            return 1;
        }
    };
    let files = match file_list(&src, &sid) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("orcabot: list remote workspace: {e}");
            return 1;
        }
    };
    let ws = workspace_dir();
    let _ = fs::create_dir_all(&ws);
    // Canonicalize the workspace root once for containment checks against the
    // remote-supplied paths below.
    let ws_canon = match ws.canonicalize() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("orcabot: cannot resolve workspace {}: {e}", ws.display());
            return 1;
        }
    };
    let (mut n, mut bytes, mut skipped) = (0u64, 0u64, 0u64);
    for f in &files {
        if f.get("is_dir").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        let path = match f.get("path").and_then(|x| x.as_str()) {
            Some(p) => p.trim_start_matches('/').to_string(),
            None => continue,
        };
        if path.is_empty() || ws_excluded(&path) {
            continue;
        }
        // Reject remote paths that would escape the workspace (traversal/symlink).
        let dest_path = match safe_workspace_dest(&ws_canon, &path) {
            Some(d) => d,
            None => {
                eprintln!("orcabot: skip unsafe remote path: {path}");
                skipped += 1;
                continue;
            }
        };
        let data = match file_get(&src, &sid, &path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("orcabot: skip {path}: {e}");
                skipped += 1;
                continue;
            }
        };
        if let Some(parent) = dest_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&dest_path, &data).is_ok() {
            n += 1;
            bytes += data.len() as u64;
            if n % 50 == 0 {
                println!("orcabot: …{n} files ({} MB)", bytes / 1_048_576);
            }
        } else {
            skipped += 1;
        }
    }
    println!(
        "orcabot: pulled '{name}' <- {} (dashboard {nd}; {n} files, {} MB, {skipped} skipped)",
        src.base,
        bytes / 1_048_576
    );
    0
}

/// Mint / list / revoke a personal access token (PAT) for `push`/`pull`.
/// Targets a remote (or the local stack). On the public cloud, issuance is
/// gated by Cloudflare Access (browser), so there you generate the PAT in the
/// web UI; this command is for local/dev/self-hosted control planes.
fn cmd_token(rest: &[String]) -> i32 {
    let r = remote_from(rest);
    let sub = first_positional(rest);
    match sub.as_deref() {
        Some("list") => match api_json(&r, "GET", "/auth/api-tokens", None) {
            Ok(v) => {
                let empty = vec![];
                let toks = v.get("tokens").and_then(|x| x.as_array()).unwrap_or(&empty);
                if toks.is_empty() {
                    println!("orcabot: no tokens on {}", r.base);
                } else {
                    for t in toks {
                        println!(
                            "  {}  {}  created {}  last_used {}",
                            t.get("id").and_then(|x| x.as_str()).unwrap_or("?"),
                            t.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                            t.get("createdAt").and_then(|x| x.as_str()).unwrap_or("?"),
                            t.get("lastUsedAt").and_then(|x| x.as_str()).unwrap_or("never"),
                        );
                    }
                }
                0
            }
            Err(e) => {
                eprintln!("orcabot: {e}");
                1
            }
        },
        Some("revoke") => {
            // positional after "revoke": find the token id (next non-flag token)
            let id = rest
                .iter()
                .skip_while(|a| a.as_str() != "revoke")
                .nth(1)
                .cloned();
            let Some(id) = id else {
                eprintln!("usage: orcabot token revoke <id> [--remote URL]");
                return 2;
            };
            match api_json(&r, "DELETE", &format!("/auth/api-tokens/{}", id), None) {
                Ok(_) => {
                    println!("orcabot: revoked {id}");
                    0
                }
                Err(e) => {
                    eprintln!("orcabot: {e}");
                    1
                }
            }
        }
        _ => {
            // mint a new token
            let mut name = "cli".to_string();
            if let Some(i) = rest.iter().position(|a| a == "--name") {
                if let Some(n) = rest.get(i + 1) {
                    name = n.clone();
                }
            }
            match api_json(&r, "POST", "/auth/api-token", Some(serde_json::json!({ "name": name }))) {
                Ok(v) => match v.get("token").and_then(|x| x.as_str()) {
                    Some(tok) => {
                        println!("{tok}");
                        eprintln!("orcabot: PAT created (shown once). Use it with: --token {tok}");
                        0
                    }
                    None => {
                        eprintln!("orcabot: unexpected response: {v}");
                        1
                    }
                },
                Err(e) => {
                    eprintln!("orcabot: {e}");
                    1
                }
            }
        }
    }
}

// ---- surface switching (cli / desktop / web) ------------------------------

/// PID of the running desktop backend process, if any (pid file, else pgrep).
fn app_pid() -> Option<u32> {
    if let Ok(s) = fs::read_to_string(pid_file()) {
        if let Ok(p) = s.trim().parse::<i32>() {
            if unsafe { libc::kill(p, 0) } == 0 {
                return Some(p as u32);
            }
        }
    }
    let out = Command::new("pgrep").arg("-f").arg("orcabot-desktop").output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u32>().ok())
        .next()
}

fn send_sig(pid: u32, sig: i32) -> bool {
    unsafe { libc::kill(pid as i32, sig) == 0 }
}

/// Spawn the desktop binary detached. headless=false launches it with the GUI shown.
fn spawn_desktop_detached(headless: bool) -> Result<u32, String> {
    let bin = desktop_binary().ok_or("could not find the orcabot-desktop binary")?;
    let log = File::create(headless_log()).map_err(|e| e.to_string())?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(&bin);
    command.env("VZ_CONSOLE_DIRECT", "1");
    if headless {
        command.env("ORCABOT_DESKTOP_HEADLESS", "1");
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = command.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let _ = fs::write(pid_file(), pid.to_string());
    Ok(pid)
}

fn wait_ready(timeout_secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    while Instant::now() < deadline {
        if controlplane_healthy() && sandbox_health().is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    false
}

fn cmd_desktop() -> i32 {
    if let Some(pid) = app_pid() {
        if send_sig(pid, libc::SIGUSR1) {
            println!("orcabot: switched to desktop — GUI window shown (backend pid {pid}).");
            return 0;
        }
        eprintln!("orcabot: failed to signal app {pid}");
        return 1;
    }
    println!("orcabot: no running stack — launching the desktop GUI…");
    match spawn_desktop_detached(false) {
        Ok(pid) => {
            print!("orcabot: starting (pid {pid})");
            let _ = std::io::stdout().flush();
            if wait_ready(150) {
                println!("\norcabot: desktop up.");
                0
            } else {
                eprintln!("\norcabot: timed out waiting for services");
                1
            }
        }
        Err(e) => {
            eprintln!("orcabot: {e}");
            1
        }
    }
}

fn cmd_cli(rest: &[String]) -> i32 {
    // `--owns` marks a desktop→CLI hand-off (the GUI's "Switch to CLI" button):
    // the CLI becomes the active surface, so closing it stops the session.
    let takeover = has_flag(rest, "--owns");
    let force_own = match app_pid() {
        Some(pid) => {
            send_sig(pid, libc::SIGUSR2);
            eprintln!("orcabot: switched to cli — GUI hidden (backend pid {pid}).");
            takeover // attach; own only if this is an explicit hand-off
        }
        None => {
            eprintln!("orcabot: no running stack — starting headless…");
            if spawn_desktop_detached(true).is_err() || !wait_ready(150) {
                eprintln!("orcabot: failed to start stack");
                return 1;
            }
            true // we started it → we own it
        }
    };
    run_tui(force_own)
}

fn cmd_web(rest: &[String]) -> i32 {
    // The web surface lives in the cloud. Switching to it = push the local
    // dashboard up, then open it in the browser. Requires a remote target
    // (--remote/--token or ORCABOT_REMOTE_URL/_TOKEN). The browser URL is the
    // web app origin (ORCABOT_WEB_URL), falling back to the remote API base.
    let dest = remote_from(rest);
    let web_base = std::env::var("ORCABOT_WEB_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| dest.base.clone());

    if dest.is_local() && std::env::var("ORCABOT_REMOTE_URL").is_err() {
        eprintln!(
            "orcabot: no cloud target set. Configure ORCABOT_REMOTE_URL=<cloud control plane>\n\
             and ORCABOT_REMOTE_TOKEN=<PAT from the web Settings page>, then `orcabot web`."
        );
        if !web_base.is_empty() && web_base != dest.base {
            let _ = Command::new("open").arg(&web_base).status();
            eprintln!("opened {web_base} (your local dashboard is not transferred).");
        }
        return 1;
    }

    if !controlplane_healthy() {
        eprintln!("orcabot: run `orcabot up` first (web reads the local stack to push it).");
        return 1;
    }
    let include_ws = !has_flag(rest, "--no-workspace");
    let did = match rest
        .iter()
        .position(|a| a == "--dash")
        .and_then(|i| rest.get(i + 1).cloned())
        .or_else(|| first_positional(rest))
    {
        Some(d) => d,
        None => match first_or_named_dash(None) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("orcabot: {e}");
                return 1;
            }
        },
    };

    let nd = match push_dashboard(&dest, &did, include_ws) {
        Ok(id) => id,
        Err(e) if is_paywall(&e) => {
            eprintln!("orcabot: {}", paywall_message(&web_base));
            return 1;
        }
        Err(e) => {
            eprintln!("orcabot: {e}");
            return 1;
        }
    };

    let url = format!("{}/dashboards/{}", web_base.trim_end_matches('/'), nd);
    let _ = Command::new("open").arg(&url).status();
    println!("orcabot: switched to web — opened {url}");
    0
}

fn cmd_status() -> i32 {
    let cp = controlplane_healthy();
    let sb = sandbox_health();
    let fe = matches!(
        http_get(
            &format!("http://127.0.0.1:{}/", FRONTEND_PORT),
            Duration::from_secs(2)
        ),
        Some((code, _)) if code < 500
    );
    println!("control plane (:{CONTROLPLANE_PORT}): {}", if cp { "ready" } else { "down" });
    println!(
        "sandbox      (:{SANDBOX_PORT}): {}",
        match &sb {
            Some(h) => h.trim().to_string(),
            None => "down".to_string(),
        }
    );
    println!("frontend     (:{FRONTEND_PORT}): {}", if fe { "ready" } else { "down" });
    if cp && sb.is_some() {
        0
    } else {
        1
    }
}

fn read_debug_token() -> Option<String> {
    let content = fs::read_to_string(VZ_CONSOLE_LOG).ok()?;
    let line = content
        .lines()
        .rev()
        .find(|l| l.contains("debug-exec] auth token:"))?;
    let tok: String = line
        .rsplit("auth token:")
        .next()?
        .trim()
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();
    if tok.len() >= 32 {
        Some(tok)
    } else {
        None
    }
}

fn cmd_exec(rest: &[String]) -> i32 {
    if rest.is_empty() {
        eprintln!("orcabot exec: needs a command, e.g. orcabot exec 'ip addr'");
        return 2;
    }
    if sandbox_health().is_none() {
        eprintln!("orcabot: sandbox not reachable on :{SANDBOX_PORT} — run `orcabot up` first");
        return 1;
    }
    let token = match read_debug_token() {
        Some(t) => t,
        None => {
            eprintln!(
                "orcabot: could not read debug-exec token from {VZ_CONSOLE_LOG}.\n\
                 The stack must have been launched with VZ_CONSOLE_DIRECT=1 (orcabot up does this)."
            );
            return 1;
        }
    };
    let command = rest.join(" ");
    let body = serde_json::json!({ "cmd": command, "timeout_ms": 60000 });
    let resp = agent(Duration::from_secs(65))
        .post(&format!("http://127.0.0.1:{}/debug/exec", SANDBOX_PORT))
        .set("X-Debug-Exec-Token", &token)
        .set("Content-Type", "application/json")
        .send_json(body);

    let json: serde_json::Value = match resp {
        Ok(r) => r.into_json().unwrap_or_default(),
        Err(ureq::Error::Status(code, r)) => {
            eprintln!(
                "orcabot exec: HTTP {code}: {}",
                r.into_string().unwrap_or_default().trim()
            );
            return 1;
        }
        Err(e) => {
            eprintln!("orcabot exec: request failed: {e}");
            return 1;
        }
    };

    if let Some(s) = json.get("stdout").and_then(|v| v.as_str()) {
        print!("{s}");
    }
    if let Some(s) = json.get("stderr").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            eprint!("{s}");
        }
    }
    json.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(0) as i32
}

// ===========================================================================
// Control-plane client (the engine) — dev-auth, components, mutations.
// ===========================================================================

// Dev-auth identity for the local control plane. The email/name MUST match the
// desktop frontend's dev login (`loginDevMode("Desktop User", "desktop@localhost")`)
// so the CLI and the GUI resolve to the SAME user: the control plane's dev-auth
// matches an existing user by email, so sending the email makes both surfaces
// converge on one account (shared dashboards). Sending only X-User-ID also 401s on
// a clean D1 — dev-auth only auto-creates a user when X-User-Email is present.
const DEV_USER: &str = "dev-desktop";
const DEV_EMAIL: &str = "desktop@localhost";
const DEV_NAME: &str = "Desktop User";

fn cp_call(method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{}{}", CONTROLPLANE_PORT, path);
    let req = agent(Duration::from_secs(15))
        .request(method, &url)
        .set("X-User-ID", DEV_USER)
        .set("X-User-Email", DEV_EMAIL)
        .set("X-User-Name", DEV_NAME)
        .set("Content-Type", "application/json");
    let resp = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match resp {
        Ok(r) => Ok(r.into_json().unwrap_or(serde_json::Value::Null)),
        Err(ureq::Error::Status(code, r)) => Err(format!(
            "HTTP {code}: {}",
            r.into_string().unwrap_or_default().trim()
        )),
        Err(e) => Err(e.to_string()),
    }
}

/// (id, name) for each dashboard the dev user can see.
fn list_dashboards() -> Result<Vec<(String, String)>, String> {
    let v = cp_call("GET", "/dashboards", None)?;
    let arr = v.get("dashboards").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    Ok(arr
        .iter()
        .filter_map(|d| {
            let id = d.get("id")?.as_str()?.to_string();
            let name = d
                .get("name")
                .or_else(|| d.get("title"))
                .and_then(|x| x.as_str())
                .unwrap_or("(untitled)")
                .to_string();
            Some((id, name))
        })
        .collect())
}

struct Component {
    id: String,
    kind: String,
    label: String,
    status: String,
}

fn is_integration(kind: &str) -> bool {
    matches!(
        kind,
        "gmail" | "calendar" | "contacts" | "sheets" | "forms" | "twitter" | "outlook"
            | "slack" | "discord" | "telegram" | "whatsapp" | "teams" | "matrix" | "google_chat"
            | "github" | "drive"
    )
}

fn label_for(item: &serde_json::Value, content: &str) -> String {
    // Terminals (and some blocks) store JSON content with a human "name".
    if let Ok(j) = serde_json::from_str::<serde_json::Value>(content) {
        if let Some(n) = j.get("name").and_then(|x| x.as_str()) {
            if !n.is_empty() {
                return n.to_string();
            }
        }
    }
    if let Some(t) = item
        .get("metadata")
        .and_then(|m| m.get("title"))
        .and_then(|x| x.as_str())
    {
        if !t.is_empty() {
            return t.to_string();
        }
    }
    let first = content.lines().next().unwrap_or("").trim();
    if first.is_empty() {
        "(empty)".to_string()
    } else if first.len() > 44 {
        format!("{}…", &first[..44])
    } else {
        first.to_string()
    }
}

fn get_components(dash_id: &str) -> Result<Vec<Component>, String> {
    let v = cp_call("GET", &format!("/dashboards/{}", dash_id), None)?;
    let items = v.get("items").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let sessions = v.get("sessions").and_then(|x| x.as_array()).cloned().unwrap_or_default();

    let mut sess: HashMap<String, String> = HashMap::new();
    for s in &sessions {
        if let (Some(it), Some(st)) = (
            s.get("itemId").and_then(|x| x.as_str()),
            s.get("status").and_then(|x| x.as_str()),
        ) {
            sess.insert(it.to_string(), st.to_string());
        }
    }

    let mut out = Vec::new();
    for it in &items {
        let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let kind = it.get("type").and_then(|x| x.as_str()).unwrap_or("?").to_string();
        let content = it.get("content").and_then(|x| x.as_str()).unwrap_or("");
        let label = label_for(it, content);
        let status = if kind == "terminal" {
            match sess.get(&id).map(String::as_str) {
                Some("active") => "running",
                Some("creating") => "starting",
                Some(other) => other,
                None => "idle",
            }
            .to_string()
        } else if is_integration(&kind) {
            "attached".to_string()
        } else {
            "-".to_string()
        };
        out.push(Component { id, kind, label, status });
    }
    Ok(out)
}

/// Map an agent name to (display name, boot command). Empty boot = plain shell.
fn agent_boot(agent: &str) -> (String, String) {
    match agent {
        "claude" | "claude-code" => ("Claude Code".into(), "claude".into()),
        "gemini" => ("Gemini".into(), "gemini".into()),
        "codex" => ("Codex".into(), "codex".into()),
        "shell" | "" => ("Shell".into(), String::new()),
        other => (other.to_string(), other.to_string()),
    }
}

/// Create a terminal component running the given agent, then start its session
/// (boots the agent in a PTY in the sandbox). Returns the new item id.
fn create_terminal(dash_id: &str, agent: &str) -> Result<String, String> {
    let (name, boot) = agent_boot(agent);
    let content = serde_json::json!({
        "name": name,
        "bootCommand": boot,
        "skipApprovals": true,
        "subagentIds": [],
        "skillIds": [],
    })
    .to_string();
    let resp = cp_call(
        "POST",
        &format!("/dashboards/{}/items", dash_id),
        Some(serde_json::json!({ "type": "terminal", "content": content })),
    )?;
    let item_id = resp
        .get("item")
        .and_then(|i| i.get("id"))
        .and_then(|x| x.as_str())
        .ok_or("create item: no id in response")?
        .to_string();
    // Start the session — provisions the PTY and runs the boot command.
    cp_call(
        "POST",
        &format!("/dashboards/{}/items/{}/session", dash_id, item_id),
        Some(serde_json::json!({})),
    )?;
    Ok(item_id)
}

fn create_note(dash_id: &str, text: &str) -> Result<String, String> {
    let resp = cp_call(
        "POST",
        &format!("/dashboards/{}/items", dash_id),
        Some(serde_json::json!({ "type": "note", "content": text })),
    )?;
    Ok(resp
        .get("item")
        .and_then(|i| i.get("id"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string())
}

fn first_or_named_dash(named: Option<String>) -> Result<String, String> {
    if let Some(id) = named {
        return Ok(id);
    }
    list_dashboards()?
        .into_iter()
        .next()
        .map(|(id, _)| id)
        .ok_or_else(|| "no dashboards — create one first".to_string())
}

// ---- new (non-interactive create, also reused by the TUI) -----------------

fn cmd_new(rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: control plane not reachable — run `orcabot up` first");
        return 1;
    }
    // Pull out `--dash <id>`; the remainder is positional.
    let mut dash: Option<String> = None;
    let mut pos: Vec<String> = Vec::new();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        if a == "--dash" {
            dash = it.next().cloned();
        } else {
            pos.push(a.clone());
        }
    }
    match pos.first().map(String::as_str) {
        Some("terminal") => {
            let agent = pos.get(1).map(String::as_str).unwrap_or("claude");
            let did = match first_or_named_dash(dash) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("orcabot: {e}");
                    return 1;
                }
            };
            match create_terminal(&did, agent) {
                Ok(id) => {
                    println!("created {agent} terminal {id}");
                    0
                }
                Err(e) => {
                    eprintln!("orcabot: {e}");
                    1
                }
            }
        }
        Some("note") => {
            let text = pos[1..].join(" ");
            let did = match first_or_named_dash(dash) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("orcabot: {e}");
                    return 1;
                }
            };
            match create_note(&did, &text) {
                Ok(id) => {
                    println!("created note {id}");
                    0
                }
                Err(e) => {
                    eprintln!("orcabot: {e}");
                    1
                }
            }
        }
        _ => {
            eprintln!("usage: orcabot new terminal [claude|gemini|codex|shell] [--dash <id>]");
            eprintln!("       orcabot new note <text> [--dash <id>]");
            2
        }
    }
}

// ---- PTY streaming (terminal I/O) -----------------------------------------

/// Resolve a terminal component (item id) to its (control-plane session id, pty id).
fn session_for_item(dash: &str, item_id: &str) -> Result<(String, String), String> {
    let v = cp_call("GET", &format!("/dashboards/{}", dash), None)?;
    let sessions = v.get("sessions").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    for s in sessions {
        if s.get("itemId").and_then(|x| x.as_str()) == Some(item_id) {
            let sid = s.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let pty = s.get("ptyId").and_then(|x| x.as_str()).unwrap_or("");
            if !sid.is_empty() && !pty.is_empty() {
                return Ok((sid.to_string(), pty.to_string()));
            }
        }
    }
    Err("that terminal has no running session yet (start it first)".to_string())
}

/// Open the PTY WebSocket through the control plane (dev-auth via X-User-ID).
/// Returns a connected, blocking WebSocket with a short read timeout so callers
/// can poll without blocking forever.
fn open_pty_ws(
    session_id: &str,
    pty_id: &str,
    read_timeout: Duration,
) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, String> {
    use tungstenite::client::IntoClientRequest;
    // WS auth goes via the user_id query param (browsers can't set headers on a WS
    // handshake, so that's how the frontend authenticates). Also send an allowed
    // Origin + the X-User-ID header as belt-and-suspenders.
    let url = format!(
        "ws://127.0.0.1:{}/sessions/{}/ptys/{}/ws?user_id={}",
        CONTROLPLANE_PORT, session_id, pty_id, DEV_USER
    );
    let mut req = url.into_client_request().map_err(|e| e.to_string())?;
    // This tungstenite client (unlike a browser) CAN set headers on the handshake,
    // so we pass the full dev-auth identity as headers — incl. email/name so the
    // control plane resolves the same user as the GUI and auto-creates on a clean DB.
    req.headers_mut().insert(
        "X-User-ID",
        tungstenite::http::HeaderValue::from_static(DEV_USER),
    );
    req.headers_mut().insert(
        "X-User-Email",
        tungstenite::http::HeaderValue::from_static(DEV_EMAIL),
    );
    req.headers_mut().insert(
        "X-User-Name",
        tungstenite::http::HeaderValue::from_static(DEV_NAME),
    );
    req.headers_mut().insert(
        "Origin",
        tungstenite::http::HeaderValue::from_static("http://localhost:8788"),
    );
    let (ws, _resp) = tungstenite::connect(req).map_err(|e| format!("ws connect: {e}"))?;
    if let tungstenite::stream::MaybeTlsStream::Plain(s) = ws.get_ref() {
        let _ = s.set_read_timeout(Some(read_timeout));
    }
    Ok(ws)
}

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io)
        if io.kind() == std::io::ErrorKind::WouldBlock || io.kind() == std::io::ErrorKind::TimedOut)
}

/// Headless verification of the PTY stream: connect and print whatever the
/// terminal emits for `secs` seconds. Proves WS auth + routing + streaming.
fn cmd_tail(rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: run `orcabot up` first");
        return 1;
    }
    let (pos, dash) = split_dash_flag(rest);
    let Some(item) = pos.first() else {
        eprintln!("usage: orcabot tail <terminal-id> [--dash <id>] [--secs N]");
        return 2;
    };
    let mut secs = 5u64;
    if let Some(i) = pos.iter().position(|a| a == "--secs") {
        if let Some(v) = pos.get(i + 1).and_then(|s| s.parse::<u64>().ok()) {
            secs = v;
        }
    }
    // --screen feeds the stream through vt100 and prints the rendered grid at the
    // end (verifies the exact render pipeline the TUI uses), instead of raw bytes.
    let screen_mode = pos.iter().any(|a| a == "--screen");
    // --send <text>: take control and type <text> + Enter (verifies the input path).
    let send_text = pos
        .iter()
        .position(|a| a == "--send")
        .and_then(|i| pos.get(i + 1).cloned());
    let did = match dash_for_terminal(item, dash) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("orcabot: {e}");
            return 1;
        }
    };
    let (sid, pty) = match session_for_item(&did, item) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("orcabot: {e}");
            return 1;
        }
    };
    let mut ws = match open_pty_ws(&sid, &pty, Duration::from_millis(400)) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("orcabot: {e}");
            return 1;
        }
    };
    eprintln!("orcabot: connected to pty {} — streaming for {secs}s…", &pty[..pty.len().min(8)]);
    // In screen mode, nudge the PTY to redraw so we capture a full frame.
    let mut parser = vt100::Parser::new(24, 80, 0);
    if screen_mode {
        let _ = ws.send(tungstenite::Message::Text(
            serde_json::json!({ "type": "resize", "cols": 80, "rows": 24 }).to_string(),
        ));
    }
    if let Some(text) = &send_text {
        let _ = ws.send(tungstenite::Message::Text(
            serde_json::json!({ "type": "take_control" }).to_string(),
        ));
        std::thread::sleep(Duration::from_millis(300));
        let mut bytes = text.clone().into_bytes();
        bytes.push(b'\n');
        let _ = ws.send(tungstenite::Message::Binary(bytes));
    }
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut total = 0usize;
    while Instant::now() < deadline {
        match ws.read() {
            Ok(tungstenite::Message::Binary(b)) => {
                total += b.len();
                if screen_mode {
                    parser.process(&b);
                } else {
                    print!("{}", String::from_utf8_lossy(&b));
                    let _ = std::io::stdout().flush();
                }
            }
            Ok(tungstenite::Message::Text(t)) => {
                if !screen_mode {
                    total += t.len();
                    print!("{t}");
                    let _ = std::io::stdout().flush();
                }
            }
            Ok(tungstenite::Message::Ping(p)) => {
                let _ = ws.send(tungstenite::Message::Pong(p));
            }
            Ok(tungstenite::Message::Close(_)) => break,
            Ok(_) => {}
            Err(e) if is_timeout(&e) => continue,
            Err(e) => {
                eprintln!("\norcabot: ws error: {e}");
                break;
            }
        }
    }
    let _ = ws.close(None);
    if screen_mode {
        println!("{}", parser.screen().contents());
    }
    eprintln!("\norcabot: stream ended ({total} bytes received)");
    0
}

// ---- live PTY session (background WS thread + vt100 screen) ----------------

enum WsOut {
    Bin(Vec<u8>),
    Text(String),
}

/// A live attachment to a terminal's PTY: a background thread owns the WebSocket,
/// feeds binary output into a vt100 parser, and sends queued input/control frames.
struct PtySession {
    item_id: String,
    pty_short: String,
    parser: Arc<Mutex<vt100::Parser>>,
    status: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
    out: mpsc::Sender<WsOut>,
    rows: u16,
    cols: u16,
}

impl PtySession {
    fn send_input(&self, bytes: Vec<u8>) {
        let _ = self.out.send(WsOut::Bin(bytes));
    }
    fn resize(&mut self, rows: u16, cols: u16) {
        if rows == 0 || cols == 0 || (rows == self.rows && cols == self.cols) {
            return;
        }
        self.rows = rows;
        self.cols = cols;
        if let Ok(mut p) = self.parser.lock() {
            p.set_size(rows, cols);
        }
        let _ = self.out.send(WsOut::Text(
            serde_json::json!({ "type": "resize", "cols": cols, "rows": rows }).to_string(),
        ));
    }
    fn parser_status(&self) -> String {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn spawn_pty_session(
    item_id: &str,
    session_id: &str,
    pty_id: &str,
    rows: u16,
    cols: u16,
) -> Result<PtySession, String> {
    let mut ws = open_pty_ws(session_id, pty_id, Duration::from_millis(40))?;
    // Take control so our keystrokes reach the PTY, and size it to our pane.
    let _ = ws.send(Message::Text(serde_json::json!({ "type": "take_control" }).to_string()));
    let _ = ws.send(Message::Text(
        serde_json::json!({ "type": "resize", "cols": cols, "rows": rows }).to_string(),
    ));

    let parser = Arc::new(Mutex::new(vt100::Parser::new(rows.max(1), cols.max(1), 0)));
    let status = Arc::new(Mutex::new("connected".to_string()));
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<WsOut>();

    let (p, st, stt) = (parser.clone(), stop.clone(), status.clone());
    std::thread::spawn(move || {
        loop {
            if st.load(Ordering::Relaxed) {
                break;
            }
            // Drain queued output (keystrokes / control frames).
            while let Ok(m) = rx.try_recv() {
                let r = match m {
                    WsOut::Bin(b) => ws.send(Message::Binary(b)),
                    WsOut::Text(t) => ws.send(Message::Text(t)),
                };
                if r.is_err() {
                    break;
                }
            }
            match ws.read() {
                // Binary = PTY output → vt100. Text = JSON control frames → not rendered.
                Ok(Message::Binary(b)) => {
                    if let Ok(mut pp) = p.lock() {
                        pp.process(&b);
                    }
                }
                Ok(Message::Ping(x)) => {
                    let _ = ws.send(Message::Pong(x));
                }
                Ok(Message::Text(_)) => {}
                Ok(Message::Close(_)) => {
                    if let Ok(mut s) = stt.lock() {
                        *s = "closed".into();
                    }
                    break;
                }
                Ok(_) => {}
                Err(e) if is_timeout(&e) => {}
                Err(e) => {
                    if let Ok(mut s) = stt.lock() {
                        *s = format!("error: {e}");
                    }
                    break;
                }
            }
        }
        let _ = ws.close(None);
    });

    Ok(PtySession {
        item_id: item_id.to_string(),
        pty_short: pty_id.chars().take(8).collect(),
        parser,
        status,
        stop,
        out: tx,
        rows,
        cols,
    })
}

/// Encode a key event into the bytes a PTY expects.
fn key_to_bytes(code: KeyCode, mods: KeyModifiers) -> Option<Vec<u8>> {
    let b = match code {
        KeyCode::Char(c) => {
            if mods.contains(KeyModifiers::CONTROL) {
                let lc = c.to_ascii_lowercase();
                if lc.is_ascii_alphabetic() {
                    vec![lc as u8 - b'a' + 1]
                } else {
                    return None;
                }
            } else {
                c.to_string().into_bytes()
            }
        }
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Tab => vec![b'\t'],
        KeyCode::Esc => vec![0x1b],
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::PageUp => b"\x1b[5~".to_vec(),
        KeyCode::PageDown => b"\x1b[6~".to_vec(),
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        _ => return None,
    };
    Some(b)
}

fn conv_color(c: vt100::Color) -> Color {
    match c {
        vt100::Color::Default => Color::Reset,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}

// ---- integrations: connect / attach / detach ------------------------------

/// Map a provider name to its OAuth connect sub-path under /integrations/.
fn connect_subpath(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "gmail" => "google/gmail",
        "drive" | "google_drive" => "google/drive",
        "calendar" | "google_calendar" => "google/calendar",
        "contacts" | "google_contacts" => "google/contacts",
        "github" => "github",
        "twitter" | "x" => "twitter",
        "box" => "box",
        "onedrive" => "onedrive",
        _ => return None,
    })
}

fn provider_matches(a: &str, b: &str) -> bool {
    a == b
        || (a == "drive" && b == "google_drive")
        || (a == "google_drive" && b == "drive")
}

/// Fetch the OAuth authorization URL for a provider (the connect route 302-redirects
/// to the provider; we capture the Location instead of following it).
fn connect_url(provider: &str) -> Result<String, String> {
    let sub = connect_subpath(provider)
        .ok_or_else(|| format!("unknown provider '{provider}' (gmail|drive|calendar|github|twitter|box|onedrive)"))?;
    let url = format!("http://127.0.0.1:{}/integrations/{}/connect", CONTROLPLANE_PORT, sub);
    let ag = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .redirects(0)
        .build();
    let loc_from = |code: u16, resp: ureq::Response| -> Result<String, String> {
        if (300..400).contains(&code) {
            resp.header("location")
                .map(|s| s.to_string())
                .ok_or_else(|| "redirect without Location header".to_string())
        } else {
            let body = resp.into_string().unwrap_or_default();
            if body.contains("not configured") || body.contains("Connection failed") {
                Err(format!(
                    "OAuth not configured for {provider} — relaunch with its *_CLIENT_ID/*_CLIENT_SECRET set"
                ))
            } else {
                Err(format!("unexpected HTTP {code} (no redirect) connecting {provider}"))
            }
        }
    };
    match ag
        .get(&url)
        .set("X-User-ID", DEV_USER)
        .set("X-User-Email", DEV_EMAIL)
        .set("X-User-Name", DEV_NAME)
        .call()
    {
        Ok(resp) => loc_from(resp.status(), resp),
        Err(ureq::Error::Status(code, resp)) => loc_from(code, resp),
        Err(e) => Err(e.to_string()),
    }
}

/// Find the connected user_integration id for a provider on a terminal, if any.
fn find_user_integration(dash: &str, terminal: &str, provider: &str) -> Result<Option<String>, String> {
    let v = cp_call(
        "GET",
        &format!("/dashboards/{}/terminals/{}/available-integrations", dash, terminal),
        None,
    )?;
    let arr = v.get("integrations").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    for e in arr {
        let p = e.get("provider").and_then(|x| x.as_str()).unwrap_or("");
        if provider_matches(p, provider) {
            if let Some(uid) = e.get("userIntegrationId").and_then(|x| x.as_str()) {
                return Ok(Some(uid.to_string()));
            }
        }
    }
    Ok(None)
}

/// Resolve a terminal component (dashboard item id) to its session's PTY id —
/// integrations key off the PTY id, not the item id. Requires a running session.
fn pty_for_item(dash: &str, item_id: &str) -> Result<String, String> {
    let v = cp_call("GET", &format!("/dashboards/{}", dash), None)?;
    let sessions = v.get("sessions").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    for s in sessions {
        if s.get("itemId").and_then(|x| x.as_str()) == Some(item_id) {
            if let Some(p) = s.get("ptyId").and_then(|x| x.as_str()) {
                if !p.is_empty() {
                    return Ok(p.to_string());
                }
            }
        }
    }
    Err("that terminal has no running session/PTY yet (start it first)".to_string())
}

fn attach_integration(dash: &str, item_id: &str, provider: &str) -> Result<(), String> {
    let pty = pty_for_item(dash, item_id)?;
    match find_user_integration(dash, &pty, provider)? {
        Some(uid) => {
            cp_call(
                "POST",
                &format!("/dashboards/{}/terminals/{}/integrations", dash, pty),
                Some(serde_json::json!({ "provider": provider, "userIntegrationId": uid })),
            )?;
            Ok(())
        }
        None => Err(format!(
            "{provider} isn't connected — run `connect {provider}` and authorize it first"
        )),
    }
}

fn detach_integration(dash: &str, item_id: &str, provider: &str) -> Result<(), String> {
    let pty = pty_for_item(dash, item_id)?;
    cp_call(
        "DELETE",
        &format!("/dashboards/{}/terminals/{}/integrations/{}", dash, pty, provider),
        None,
    )?;
    Ok(())
}

/// Find which dashboard a terminal/item id belongs to (so attach/detach can take
/// just the component id). Falls back to a provided --dash.
fn dash_for_terminal(terminal: &str, hint: Option<String>) -> Result<String, String> {
    if let Some(h) = hint {
        return Ok(h);
    }
    for (id, _) in list_dashboards()? {
        if let Ok(cs) = get_components(&id) {
            if cs.iter().any(|c| c.id == terminal) {
                return Ok(id);
            }
        }
    }
    Err("could not find which dashboard that terminal belongs to (pass --dash <id>)".to_string())
}

fn split_dash_flag(rest: &[String]) -> (Vec<String>, Option<String>) {
    let mut dash = None;
    let mut pos = Vec::new();
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        if a == "--dash" {
            dash = it.next().cloned();
        } else {
            pos.push(a.clone());
        }
    }
    (pos, dash)
}

fn cmd_connect(rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: run `orcabot up` first");
        return 1;
    }
    let Some(provider) = rest.first() else {
        eprintln!("usage: orcabot connect <gmail|drive|calendar|github|twitter|box|onedrive>");
        return 2;
    };
    match connect_url(provider) {
        Ok(url) => {
            println!("Open this URL in a browser to authorize {provider}:\n  {url}");
            0
        }
        Err(e) => {
            eprintln!("orcabot: {e}");
            1
        }
    }
}

fn cmd_attach(rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: run `orcabot up` first");
        return 1;
    }
    let (pos, dash) = split_dash_flag(rest);
    let (Some(terminal), Some(provider)) = (pos.first(), pos.get(1)) else {
        eprintln!("usage: orcabot attach <terminal-id> <provider> [--dash <id>]");
        return 2;
    };
    let did = match dash_for_terminal(terminal, dash) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("orcabot: {e}");
            return 1;
        }
    };
    match attach_integration(&did, terminal, provider) {
        Ok(()) => {
            println!("attached {provider} to {terminal}");
            0
        }
        Err(e) => {
            eprintln!("orcabot: {e}");
            1
        }
    }
}

fn cmd_detach(rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: run `orcabot up` first");
        return 1;
    }
    let (pos, dash) = split_dash_flag(rest);
    let (Some(terminal), Some(provider)) = (pos.first(), pos.get(1)) else {
        eprintln!("usage: orcabot detach <terminal-id> <provider> [--dash <id>]");
        return 2;
    };
    let did = match dash_for_terminal(terminal, dash) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("orcabot: {e}");
            return 1;
        }
    };
    match detach_integration(&did, terminal, provider) {
        Ok(()) => {
            println!("detached {provider} from {terminal}");
            0
        }
        Err(e) => {
            eprintln!("orcabot: {e}");
            1
        }
    }
}

// ---- ls (non-interactive dump, used for headless verification) ------------

fn cmd_ls(_rest: &[String]) -> i32 {
    if !controlplane_healthy() {
        eprintln!("orcabot: control plane not reachable — run `orcabot up` first");
        return 1;
    }
    let dashboards = match list_dashboards() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("orcabot: {e}");
            return 1;
        }
    };
    if dashboards.is_empty() {
        println!("(no dashboards yet — create one in the app or with the TUI)");
        return 0;
    }
    for (id, name) in &dashboards {
        println!("# {name}  [{id}]");
        match get_components(id) {
            Ok(cs) if cs.is_empty() => println!("  (no components)"),
            Ok(cs) => {
                for c in cs {
                    println!("  {:<9} {:<9} {}", c.status, c.kind, c.label);
                }
            }
            Err(e) => println!("  ! {e}"),
        }
    }
    0
}

// ===========================================================================
// Interactive TUI
// ===========================================================================

fn status_glyph(status: &str) -> &'static str {
    match status {
        "running" => "●",
        "starting" => "◐",
        "attached" | "connected" => "◉",
        "idle" | "stopped" => "○",
        _ => "·",
    }
}

struct App {
    dashboards: Vec<(String, String)>,
    dash_idx: usize,
    components: Vec<Component>,
    input: String,
    log: Vec<String>,
    quit: bool,
    /// Set when leaving the TUI to hand the session to the desktop GUI — the
    /// stack must stay up (the GUI now owns it), so skip the owned-session teardown.
    handoff_to_desktop: bool,
    /// When set, we're in "terminal mode" streaming a component's live PTY.
    term: Option<PtySession>,
}

impl App {
    fn new() -> Self {
        let mut a = App {
            dashboards: Vec::new(),
            dash_idx: 0,
            components: Vec::new(),
            input: String::new(),
            log: vec![
                "orcabot TUI — `help` for commands, Enter to run, Esc to quit. `desktop` to pop the GUI.".to_string(),
            ],
            quit: false,
            handoff_to_desktop: false,
            term: None,
        };
        a.reload_dashboards();
        a.reload_components();
        a
    }

    fn logln(&mut self, s: impl Into<String>) {
        self.log.push(s.into());
        if self.log.len() > 500 {
            self.log.drain(0..self.log.len() - 500);
        }
    }

    fn current_dash_id(&self) -> Option<String> {
        self.dashboards.get(self.dash_idx).map(|(id, _)| id.clone())
    }

    fn reload_dashboards(&mut self) {
        match list_dashboards() {
            Ok(d) => {
                self.dashboards = d;
                if self.dash_idx >= self.dashboards.len() {
                    self.dash_idx = 0;
                }
            }
            Err(e) => self.logln(format!("! dashboards: {e}")),
        }
    }

    fn reload_components(&mut self) {
        match self.current_dash_id() {
            Some(id) => match get_components(&id) {
                Ok(c) => self.components = c,
                Err(e) => self.logln(format!("! components: {e}")),
            },
            None => self.components.clear(),
        }
    }

    fn run(&mut self, term: &mut DefaultTerminal) -> std::io::Result<()> {
        while !self.quit {
            // Keep the live PTY sized to the screen (minus the 1-line status bar).
            if self.term.is_some() {
                if let Ok(sz) = term.size() {
                    if let Some(t) = self.term.as_mut() {
                        t.resize(sz.height.saturating_sub(1), sz.width);
                    }
                }
            }
            term.draw(|f| self.ui(f))?;
            // Poll fast in terminal mode for responsive output.
            let poll = if self.term.is_some() { 30 } else { 200 };
            if event::poll(Duration::from_millis(poll))? {
                if let Event::Key(k) = event::read()? {
                    if k.kind == KeyEventKind::Press {
                        if self.term.is_some() {
                            self.on_key_terminal(k);
                        } else {
                            self.on_key_list(k);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Key handling while a live terminal is focused: forward to the PTY, except
    /// Ctrl-] which detaches and returns to the component list.
    fn on_key_terminal(&mut self, k: ratatui::crossterm::event::KeyEvent) {
        if k.code == KeyCode::Char(']') && k.modifiers.contains(KeyModifiers::CONTROL) {
            self.term = None; // Drop closes the WS thread.
            self.logln("detached from terminal");
            self.reload_components();
            return;
        }
        if let Some(bytes) = key_to_bytes(k.code, k.modifiers) {
            if let Some(t) = self.term.as_ref() {
                t.send_input(bytes);
            }
        }
    }

    /// Key handling in the component-list view: type + run commands.
    fn on_key_list(&mut self, k: ratatui::crossterm::event::KeyEvent) {
        match k.code {
            KeyCode::Esc => self.quit = true,
            KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => self.quit = true,
            KeyCode::Enter => {
                let line = std::mem::take(&mut self.input);
                self.run_command(line.trim());
            }
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char(c) => self.input.push(c),
            _ => {}
        }
    }

    /// Open a component (by 1-based index) as a live terminal pane.
    fn open_component(&mut self, idx1: usize) {
        let Some(dash) = self.current_dash_id() else {
            self.logln("! no dashboard selected");
            return;
        };
        let Some(c) = self.components.get(idx1.wrapping_sub(1)) else {
            self.logln(format!("! no component #{idx1}"));
            return;
        };
        if c.kind != "terminal" {
            self.logln(format!("! #{idx1} is a {} — only terminals can be opened", c.kind));
            return;
        }
        let item_id = c.id.clone();
        let (sid, pty) = match session_for_item(&dash, &item_id) {
            Ok(v) => v,
            Err(e) => {
                self.logln(format!("! {e}"));
                return;
            }
        };
        match spawn_pty_session(&item_id, &sid, &pty, 24, 80) {
            Ok(s) => {
                self.logln(format!("opened terminal #{idx1} (Ctrl-] to detach)"));
                self.term = Some(s);
            }
            Err(e) => self.logln(format!("! open: {e}")),
        }
    }

    fn run_command(&mut self, line: &str) {
        if line.is_empty() {
            return;
        }
        self.logln(format!("> {line}"));
        let parts: Vec<&str> = line.split_whitespace().collect();
        match parts.as_slice() {
            ["help"] | ["?"] => {
                for l in [
                    "commands:",
                    "  refresh|r            reload dashboards + components",
                    "  use <n>              switch to dashboard number <n>",
                    "  dash                 list dashboards",
                    "  dash new <name>      create a dashboard",
                    "  new terminal <agent> start a terminal (claude|gemini|codex|shell)",
                    "  open <n>             attach to terminal #n live (Ctrl-] to detach)",
                    "  new note <text>      add a note component",
                    "  connect <provider>   get OAuth URL (gmail|drive|calendar|github|twitter)",
                    "  attach <id> <prov>   attach a connected integration to terminal <id>",
                    "  detach <id> <prov>   detach an integration from terminal <id>",
                    "  rm <id>              delete a component by id",
                    "  exec <cmd...>        run a shell command in the sandbox VM",
                    "  status               service health",
                    "  desktop|gui          pop the desktop GUI (keeps the session; closes the TUI)",
                    "  quit|q | Esc         exit the TUI (stops the session if this TUI started it)",
                ] {
                    self.logln(l);
                }
            }
            ["quit"] | ["q"] | ["exit"] => self.quit = true,
            ["refresh"] | ["r"] => {
                self.reload_dashboards();
                self.reload_components();
                self.logln("refreshed");
            }
            ["dash"] => {
                let lines: Vec<String> = self
                    .dashboards
                    .iter()
                    .enumerate()
                    .map(|(i, (id, n))| format!("  {}{}. {}  [{}]", if i == self.dash_idx { "*" } else { " " }, i + 1, n, id))
                    .collect();
                if lines.is_empty() {
                    self.logln("  (no dashboards)");
                } else {
                    for l in lines {
                        self.logln(l);
                    }
                }
            }
            ["dash", "new", rest @ ..] => {
                let name = rest.join(" ");
                let name = if name.is_empty() { "Untitled".to_string() } else { name };
                match cp_call("POST", "/dashboards", Some(serde_json::json!({ "name": name }))) {
                    Ok(_) => {
                        self.logln(format!("created dashboard '{name}'"));
                        self.reload_dashboards();
                        self.reload_components();
                    }
                    Err(e) => self.logln(format!("! {e}")),
                }
            }
            ["new", "terminal", agent_rest @ ..] => {
                let agent = agent_rest.first().copied().unwrap_or("claude");
                let Some(dash) = self.current_dash_id() else {
                    self.logln("! no dashboard selected (use `dash new <name>` first)");
                    return;
                };
                self.logln(format!("starting {agent} terminal…"));
                match create_terminal(&dash, agent) {
                    Ok(id) => {
                        self.logln(format!("created terminal {}", &id[..id.len().min(8)]));
                        self.reload_components();
                    }
                    Err(e) => self.logln(format!("! {e}")),
                }
            }
            ["new", "note", note_rest @ ..] => {
                let Some(dash) = self.current_dash_id() else {
                    self.logln("! no dashboard selected");
                    return;
                };
                match create_note(&dash, &note_rest.join(" ")) {
                    Ok(_) => {
                        self.logln("created note");
                        self.reload_components();
                    }
                    Err(e) => self.logln(format!("! {e}")),
                }
            }
            ["connect", provider] => match connect_url(provider) {
                Ok(url) => {
                    self.logln(format!("open to authorize {provider}:"));
                    self.logln(format!("  {url}"));
                }
                Err(e) => self.logln(format!("! {e}")),
            },
            ["attach", terminal, provider] => {
                let Some(dash) = self.current_dash_id() else {
                    self.logln("! no dashboard selected");
                    return;
                };
                match attach_integration(&dash, terminal, provider) {
                    Ok(()) => {
                        self.logln(format!("attached {provider} to {terminal}"));
                        self.reload_components();
                    }
                    Err(e) => self.logln(format!("! {e}")),
                }
            }
            ["detach", terminal, provider] => {
                let Some(dash) = self.current_dash_id() else {
                    self.logln("! no dashboard selected");
                    return;
                };
                match detach_integration(&dash, terminal, provider) {
                    Ok(()) => {
                        self.logln(format!("detached {provider} from {terminal}"));
                        self.reload_components();
                    }
                    Err(e) => self.logln(format!("! {e}")),
                }
            }
            ["use", n] => match n.parse::<usize>() {
                Ok(i) if i >= 1 && i <= self.dashboards.len() => {
                    self.dash_idx = i - 1;
                    self.reload_components();
                    self.logln(format!("using dashboard {i}"));
                }
                _ => self.logln("! use <n>: invalid index"),
            },
            ["open", n] => match n.parse::<usize>() {
                Ok(i) => self.open_component(i),
                _ => self.logln("! open <n>: component number from the list"),
            },
            ["rm", id] => {
                let Some(dash) = self.current_dash_id() else {
                    self.logln("! no dashboard selected");
                    return;
                };
                match cp_call("DELETE", &format!("/dashboards/{}/items/{}", dash, id), None) {
                    Ok(_) => {
                        self.logln(format!("deleted {id}"));
                        self.reload_components();
                    }
                    Err(e) => self.logln(format!("! {e}")),
                }
            }
            ["status"] => {
                let cp = controlplane_healthy();
                let sb = sandbox_health().is_some();
                self.logln(format!(
                    "control plane: {}   sandbox: {}",
                    if cp { "ready" } else { "down" },
                    if sb { "ready" } else { "down" }
                ));
            }
            ["exec", rest @ ..] if !rest.is_empty() => {
                let out = run_in_vm(&rest.join(" "));
                for l in out.lines() {
                    self.logln(l.to_string());
                }
            }
            ["desktop"] | ["gui"] => {
                // Pop the desktop GUI for this same running session, then leave the
                // TUI without tearing the stack down (the GUI takes over ownership).
                match app_pid() {
                    Some(pid) if send_sig(pid, libc::SIGUSR1) => {
                        self.logln("switching to the desktop GUI (this session keeps running)…");
                        self.handoff_to_desktop = true;
                        self.quit = true;
                    }
                    _ => self.logln("! couldn't reach the backend to show the desktop window"),
                }
            }
            _ => self.logln(format!("! unknown command: {line} (try `help`)")),
        }
    }

    fn ui(&self, f: &mut Frame) {
        if self.term.is_some() {
            self.ui_terminal(f);
            return;
        }
        let chunks = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(8),
            Constraint::Length(3),
        ])
        .split(f.area());

        let dash_name = self
            .dashboards
            .get(self.dash_idx)
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| "(no dashboard)".to_string());
        let header = Paragraph::new(format!(
            " orcabot — {}   [{} components]   (Esc to quit, `help` for commands)",
            dash_name,
            self.components.len()
        ))
        .style(Style::default().fg(Color::Black).bg(Color::Cyan).add_modifier(Modifier::BOLD));
        f.render_widget(header, chunks[0]);

        let items: Vec<ListItem> = if self.components.is_empty() {
            vec![ListItem::new("  (no components — `dash new <name>`, or create them in the app)")]
        } else {
            self.components
                .iter()
                .map(|c| {
                    ListItem::new(format!(
                        " {}  {:<9} {:<9} {}  ({})",
                        status_glyph(&c.status),
                        c.status,
                        c.kind,
                        c.label,
                        &c.id[..c.id.len().min(8)]
                    ))
                })
                .collect()
        };
        f.render_widget(List::new(items).block(Block::bordered().title("Components")), chunks[1]);

        let log_h = chunks[2].height.saturating_sub(2) as usize;
        let start = self.log.len().saturating_sub(log_h.max(1));
        let log_lines: Vec<Line> = self.log[start..].iter().map(|l| Line::from(l.clone())).collect();
        f.render_widget(
            Paragraph::new(log_lines).block(Block::bordered().title("Log")),
            chunks[2],
        );

        f.render_widget(
            Paragraph::new(format!("> {}", self.input)).block(Block::bordered().title("Command")),
            chunks[3],
        );
    }

    /// Render the focused live terminal: a status bar + the vt100 screen grid.
    fn ui_terminal(&self, f: &mut Frame) {
        let chunks = Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).split(f.area());
        let Some(term) = self.term.as_ref() else { return };

        let bar = Paragraph::new(format!(
            " terminal pty {} — {}   (Ctrl-] to detach)",
            term.pty_short,
            term.parser_status()
        ))
        .style(Style::default().fg(Color::Black).bg(Color::Green).add_modifier(Modifier::BOLD));
        f.render_widget(bar, chunks[0]);

        let area = chunks[1];
        let Ok(parser) = term.parser.lock() else { return };
        let screen = parser.screen();
        let (rows, cols) = screen.size();
        let mut lines: Vec<Line> = Vec::with_capacity(rows as usize);
        for r in 0..rows.min(area.height) {
            let mut spans: Vec<Span> = Vec::with_capacity(cols as usize);
            for c in 0..cols.min(area.width) {
                match screen.cell(r, c) {
                    Some(cell) => {
                        let mut content = cell.contents();
                        if content.is_empty() {
                            content = " ".to_string();
                        }
                        let mut style = Style::default()
                            .fg(conv_color(cell.fgcolor()))
                            .bg(conv_color(cell.bgcolor()));
                        if cell.bold() {
                            style = style.add_modifier(Modifier::BOLD);
                        }
                        if cell.inverse() {
                            style = style.add_modifier(Modifier::REVERSED);
                        }
                        if cell.underline() {
                            style = style.add_modifier(Modifier::UNDERLINED);
                        }
                        spans.push(Span::styled(content, style));
                    }
                    None => spans.push(Span::raw(" ")),
                }
            }
            lines.push(Line::from(spans));
        }
        f.render_widget(Paragraph::new(lines), area);

        // Mirror the PTY cursor (if visible) into the pane.
        if !screen.hide_cursor() {
            let (cr, cc) = screen.cursor_position();
            if cr < area.height && cc < area.width {
                f.set_cursor_position((area.x + cc, area.y + cr));
            }
        }
    }
}

/// Run a shell command in the sandbox VM, returning a human-readable result.
fn run_in_vm(command: &str) -> String {
    let token = match read_debug_token() {
        Some(t) => t,
        None => return "! cannot read debug-exec token (was the stack started via `orcabot up`?)".into(),
    };
    let body = serde_json::json!({ "cmd": command, "timeout_ms": 60000 });
    match agent(Duration::from_secs(65))
        .post(&format!("http://127.0.0.1:{}/debug/exec", SANDBOX_PORT))
        .set("X-Debug-Exec-Token", &token)
        .set("Content-Type", "application/json")
        .send_json(body)
    {
        Ok(r) => {
            let j: serde_json::Value = r.into_json().unwrap_or_default();
            let mut s = String::new();
            if let Some(o) = j.get("stdout").and_then(|v| v.as_str()) {
                s.push_str(o);
            }
            if let Some(e) = j.get("stderr").and_then(|v| v.as_str()) {
                if !e.is_empty() {
                    s.push_str(e);
                }
            }
            if s.trim().is_empty() {
                s = format!("(exit {})", j.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(0));
            }
            s
        }
        Err(ureq::Error::Status(code, r)) => {
            format!("! HTTP {code}: {}", r.into_string().unwrap_or_default().trim())
        }
        Err(e) => format!("! exec failed: {e}"),
    }
}

fn cmd_tui() -> i32 {
    run_tui(false)
}

/// Run the TUI with ownership semantics.
///
/// Ownership model: a TUI that OWNS the session tears the stack down when it
/// closes — nothing lingers as a daemon. A TUI owns the session if it started
/// the stack itself, OR if `force_own` is set (e.g. a desktop→CLI hand-off via
/// the GUI's "Switch to CLI" button, where the CLI becomes the active surface).
/// Otherwise it just attaches and leaves the stack alone (e.g. `orcabot` against
/// an `up`'d persistent stack). Typing `desktop` in the TUI overrides ownership
/// (hand back to the GUI without tearing down).
fn run_tui(force_own: bool) -> i32 {
    let mut we_own = force_own;
    if !controlplane_healthy() {
        println!("orcabot: starting the stack (it will stop when you quit)…");
        let rc = cmd_up(&[]);
        if rc != 0 || !controlplane_healthy() {
            eprintln!("orcabot: could not start the stack (see the log above); not opening the TUI.");
            return if rc != 0 { rc } else { 1 };
        }
        we_own = true;
    }
    // The TUI needs a real terminal. If stdout isn't a TTY (piped/redirected),
    // don't panic in ratatui::init. If we own the stack but can't open a TUI,
    // tear it back down so we don't leave it running for nothing.
    if unsafe { libc::isatty(libc::STDOUT_FILENO) } != 1 {
        eprintln!("orcabot: can't open the interactive TUI (stdout isn't a TTY).");
        if we_own {
            cmd_down();
        } else {
            eprintln!("orcabot: stack is running; use `orcabot ls` / `orcabot tail <id>` or run `orcabot` in a terminal.");
        }
        return 0;
    }
    let mut app = App::new();
    let mut terminal = ratatui::init();
    let res = app.run(&mut terminal);
    ratatui::restore();
    if app.handoff_to_desktop {
        // Handed the session to the desktop GUI — it owns the stack now; don't stop it.
        println!("orcabot: handed off to the desktop GUI. Quit the app (or `orcabot down`) to stop the session.");
    } else if we_own {
        // Owned-session teardown: stop the stack once the active TUI closes.
        println!("orcabot: stopping the stack…");
        cmd_down();
    }
    if let Err(e) = res {
        eprintln!("orcabot tui error: {e}");
        return 1;
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_workspace_dest_blocks_traversal() {
        let base = std::env::temp_dir().join(format!("orca-swd-{}", std::process::id()));
        let _ = fs::create_dir_all(&base);
        let ws = base.canonicalize().expect("canon temp ws");
        // Safe relative paths resolve under the workspace.
        for ok in ["a.txt", "sub/deep/x.txt", "./a.txt", "etc/passwd"] {
            let d = safe_workspace_dest(&ws, ok);
            assert!(d.is_some(), "should allow {ok}");
            assert!(d.unwrap().starts_with(&ws));
        }
        // Traversal / absolute / escaping paths are rejected.
        for bad in ["../escape.txt", "../../etc/passwd", "a/../../b", "/etc/passwd"] {
            assert!(safe_workspace_dest(&ws, bad).is_none(), "should reject {bad}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn paywall_detection() {
        assert!(is_paywall(PAYWALL_ERR));
        assert!(is_paywall("recreate on remote failed: SUBSCRIPTION_REQUIRED"));
        assert!(!is_paywall("HTTP 404: not found"));
        assert!(!is_paywall("HTTP 401: unauthorized"));
    }

    #[test]
    fn paywall_message_uses_web_url_then_falls_back_to_base() {
        // Falls back to the remote base when ORCABOT_WEB_URL is unset.
        std::env::remove_var("ORCABOT_WEB_URL");
        let m = paywall_message("https://api.example.com");
        assert!(m.contains("https://api.example.com"));
        assert!(m.contains("subscription"));
    }

    #[test]
    fn ws_excluded_covers_runtime_and_cache_dirs() {
        for p in [".orcabot/pty/x", ".claude/cache/changelog.md", ".browser/a", ".npm/b", "x/node_modules/y"] {
            assert!(ws_excluded(p), "should exclude {p}");
        }
        for p in [".claude/settings.json", ".env", "src/main.rs", "dinosaurs/a.psd"] {
            assert!(!ws_excluded(p), "should NOT exclude {p}");
        }
    }
}

// ---- end mod unix_cli ----
}
