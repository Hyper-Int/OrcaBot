// REVISION: orcabot-cli-v2-create-components
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

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Line;
use ratatui::widgets::{Block, List, ListItem, Paragraph};
use ratatui::{DefaultTerminal, Frame};

const CONTROLPLANE_PORT: u16 = 8787;
const SANDBOX_PORT: u16 = 8080;
const FRONTEND_PORT: u16 = 8788;
const VZ_CONSOLE_LOG: &str = "/tmp/vz-console.log";
const REVISION: &str = "orcabot-cli-v2-create-components";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Bare `orcabot` opens the interactive TUI — the primary interface.
    let cmd = args.get(1).map(String::as_str).unwrap_or("tui");
    let rest = &args[args.len().min(2)..];

    let code = match cmd {
        "tui" | "ui" => cmd_tui(),
        "ls" | "components" => cmd_ls(rest),
        "new" | "create" => cmd_new(rest),
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
         \x20 (no args) / tui    Open the interactive TUI (component list + command line)\n\
         \x20 ls                 Print the dashboard's components + status (non-interactive)\n\
         \x20 up [--timeout N]   Launch the stack headlessly (background) and wait until ready\n\
         \x20 down               Stop the headless stack\n\
         \x20 status             Show service health (control plane, sandbox, frontend)\n\
         \x20 exec <cmd...>      Run a shell command inside the sandbox VM\n\
         \x20 version            Print CLI revision\n\n\
         EXAMPLES:\n\
         \x20 orcabot up && orcabot          # bring up the stack, then open the TUI\n\
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
    let pid = fs::read_to_string(pid_file())
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok());
    let Some(pid) = pid else {
        eprintln!("orcabot: no pid file — stack not started by this CLI (nothing to stop)");
        return 1;
    };
    // SIGINT triggers the desktop app's ctrlc handler → clean shutdown (stops VM).
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

const DEV_USER: &str = "dev-desktop";

fn cp_call(method: &str, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{}{}", CONTROLPLANE_PORT, path);
    let req = agent(Duration::from_secs(15))
        .request(method, &url)
        .set("X-User-ID", DEV_USER)
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
}

impl App {
    fn new() -> Self {
        let mut a = App {
            dashboards: Vec::new(),
            dash_idx: 0,
            components: Vec::new(),
            input: String::new(),
            log: vec![
                "orcabot TUI — `help` for commands, Enter to run, Esc to quit.".to_string(),
            ],
            quit: false,
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
            term.draw(|f| self.ui(f))?;
            if event::poll(Duration::from_millis(300))? {
                if let Event::Key(k) = event::read()? {
                    if k.kind == KeyEventKind::Press {
                        match k.code {
                            KeyCode::Esc => self.quit = true,
                            KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => {
                                self.quit = true
                            }
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
                }
            }
        }
        Ok(())
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
                    "  new note <text>      add a note component",
                    "  rm <id>              delete a component by id",
                    "  exec <cmd...>        run a shell command in the sandbox VM",
                    "  status               service health",
                    "  quit|q | Esc         exit the TUI",
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
            ["use", n] => match n.parse::<usize>() {
                Ok(i) if i >= 1 && i <= self.dashboards.len() => {
                    self.dash_idx = i - 1;
                    self.reload_components();
                    self.logln(format!("using dashboard {i}"));
                }
                _ => self.logln("! use <n>: invalid index"),
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
            _ => self.logln(format!("! unknown command: {line} (try `help`)")),
        }
    }

    fn ui(&self, f: &mut Frame) {
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
    if !controlplane_healthy() {
        eprintln!("orcabot: stack not running — start it with `orcabot up` first.");
        return 1;
    }
    let mut app = App::new();
    let mut terminal = ratatui::init();
    let res = app.run(&mut terminal);
    ratatui::restore();
    if let Err(e) = res {
        eprintln!("orcabot tui error: {e}");
        return 1;
    }
    0
}
