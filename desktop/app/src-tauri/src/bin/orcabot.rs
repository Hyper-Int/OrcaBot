// REVISION: orcabot-cli-v1-foundation
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

use std::fs::{self, File};
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CONTROLPLANE_PORT: u16 = 8787;
const SANDBOX_PORT: u16 = 8080;
const FRONTEND_PORT: u16 = 8788;
const VZ_CONSOLE_LOG: &str = "/tmp/vz-console.log";
const REVISION: &str = "orcabot-cli-v1-foundation";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("help");
    let rest = &args[args.len().min(2)..];

    let code = match cmd {
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
         \x20 up [--timeout N]   Launch the stack headlessly (background) and wait until ready\n\
         \x20 down               Stop the headless stack\n\
         \x20 status             Show service health (control plane, sandbox, frontend)\n\
         \x20 exec <cmd...>      Run a shell command inside the sandbox VM\n\
         \x20 version            Print CLI revision\n\n\
         EXAMPLES:\n\
         \x20 orcabot up\n\
         \x20 orcabot exec 'ip -4 addr show eth0'\n\
         \x20 orcabot status\n\
         \x20 orcabot down"
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
