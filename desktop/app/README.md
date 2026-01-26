# Desktop App (Tauri)

This folder will contain the Tauri shell that embeds the frontend build and
orchestrates workerd + the local VM.

Planned steps:
- Initialize Tauri here (e.g. `cargo tauri init` or `pnpm create tauri-app`).
- Embed frontend build assets.
- Add Rust commands to manage workerd and the VM lifecycle.

## Dev notes
- Set `ORCABOT_DESKTOP_ROOT` to the `orcabot/desktop` path to autostart services.
- Set `ORCABOT_DESKTOP_AUTOSTART=0` to skip starting the shim/workerd processes.
- Tauri dev expects the frontend at `http://localhost:8788`.
