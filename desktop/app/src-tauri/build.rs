fn main() {
  // The packaged frontend is a REMOTE-origin webview (http://localhost:8788), and
  // Tauri v2's ACL rejects custom app commands from remote origins unless they're
  // explicitly granted in a capability. Declaring the commands here generates the
  // `allow-<command>` permissions that capabilities/default.json references, so the
  // frontend can invoke sign-in / workspace / cloud commands (not just the opener
  // plugin). Keep this list in sync with the `generate_handler!` list in main.rs.
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&[
        "get_workspace_path",
        "import_folder",
        "switch_to_cli",
        "quit_app",
        "get_surface_token",
        "open_url",
        "reveal_workspace",
        "get_ports",
        "get_app_version",
        "read_startup_log",
        "verify_orcabot_account",
        "set_cloud_credential",
        "sign_in_google_loopback",
        "cancel_google_sign_in",
        "rollback_sign_in",
        "get_cloud_account",
        "clear_cloud_credential",
        "list_cloud_dashboards",
        "get_cloud_dashboard",
        "download_cloud_workspace",
      ]),
    ),
  )
  .expect("failed to run tauri build script");
}
