#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// REVISION: main-v2-pid-file-cleanup
const MODULE_REVISION: &str = "main-v2-pid-file-cleanup";

mod commands;
mod vm;

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

/// Kill any processes listed in a stale PID file from a previous run.
fn cleanup_stale_processes(data_dir: &Path) {
  let pid_path = pid_file_path(data_dir);
  let contents = match std::fs::read_to_string(&pid_path) {
    Ok(c) => c,
    Err(_) => return, // No PID file — nothing to clean up
  };

  for line in contents.lines() {
    if let Ok(pid) = line.trim().parse::<i32>() {
      // Check if the process is still alive
      #[cfg(unix)]
      {
        if unsafe { libc::kill(pid, 0) } == 0 {
          eprintln!("[cleanup] Killing stale process {}", pid);
          unsafe { libc::kill(pid, libc::SIGTERM) };
          // Give it a moment to exit gracefully, then force kill
          std::thread::sleep(Duration::from_millis(500));
          unsafe { libc::kill(pid, libc::SIGKILL) };
        }
      }
    }
  }

  let _ = std::fs::remove_file(&pid_path);
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

    let mut workerd_env = vec![
      ("D1_HTTP_URL", "http://d1-shim".to_string()),
      ("SANDBOX_URL", sandbox_url),
      ("SANDBOX_INTERNAL_TOKEN", sandbox_internal_token),
      ("INTERNAL_API_TOKEN", internal_api_token),
      ("DEV_AUTH_ENABLED", dev_auth_enabled),
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
        "--directory-path",
        &format!("do-storage={}", do_storage_dir.display()),
        workerd_config.to_str().unwrap_or_default(),
      ],
      &workerd_env,
    );

    wait_for_health(&controlplane_port);

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

    // VM resources are optional - if not present, skip VM startup
    if !vm_resource_paths.image.exists() {
      eprintln!(
        "VM image not found at {}; sandbox VM disabled.",
        vm_resource_paths.image.display()
      );
      return Ok(());
    }

    eprintln!("Starting sandbox VM ({})...", vm::vm_backend_name());

    // Stage VM resources to app data directory
    let staged_paths = vm::image::stage_vm_resources(&vm_resource_paths, data_dir)?;

    // Create workspace directory
    let workspace_dir = data_dir.join("workspace");
    std::fs::create_dir_all(&workspace_dir)?;

    // Build VM configuration
    let sandbox_port: u16 = std::env::var("SANDBOX_PORT")
      .ok()
      .and_then(|s| s.parse().ok())
      .unwrap_or(8080);

    let sandbox_internal_token =
      std::env::var("SANDBOX_INTERNAL_TOKEN").unwrap_or_else(|_| "dev-sandbox-token".to_string());

    let allowed_origins =
      std::env::var("ALLOWED_ORIGINS").unwrap_or_else(|_| "http://localhost:8788".to_string());

    let mut config = VMConfig::new(staged_paths.image.clone(), workspace_dir)
      .with_cpus(2)
      .with_memory(2 * 1024 * 1024 * 1024) // 2GB
      .with_port(sandbox_port)
      .with_env("PORT", sandbox_port.to_string())
      .with_env("SANDBOX_INTERNAL_TOKEN", sandbox_internal_token)
      .with_env("ALLOWED_ORIGINS", allowed_origins)
      .with_env("WORKSPACE_BASE", "/workspace");

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
    let cmdline = if cfg!(target_os = "macos") {
      "console=hvc0 earlycon=virtio_console keep_bootcon root=/dev/vda rw loglevel=7 ignore_loglevel rdinit=/init"
    } else {
      "console=ttyS0 root=/dev/vda rw quiet"
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

    // Remove PID file since we've cleaned up
    if let Ok(dd) = self.data_dir.lock() {
      if let Some(ref data_dir) = *dd {
        let _ = std::fs::remove_file(pid_file_path(data_dir));
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

  let resource_dir = app.path().resource_dir().ok()?;
  if resource_layout_valid(&resource_dir) {
    return Some(resource_dir);
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
      let _ = stream.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n");
      let mut buf = [0u8; 128];
      let _ = stream.read(&mut buf);
      return;
    }
    std::thread::sleep(Duration::from_millis(500));
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
    .invoke_handler(tauri::generate_handler![
      commands::get_workspace_path,
      commands::import_folder,
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
