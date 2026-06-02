# CLAUDE.md

## Purpose

This directory contains the **Orcabot Desktop** app — a native macOS/Linux/Windows application that runs the entire Orcabot stack locally using Tauri (Rust shell), a local VM for the sandbox, and workerd for the control plane.

It does **not**:
- Depend on cloud infrastructure at runtime
- Require Fly.io or Cloudflare accounts
- Use Docker (uses native virtualization instead)

Claude should act as a **systems-oriented assistant** focused on native platform integration, VM lifecycle, and local service orchestration.

---

## Architecture

```
Tauri App (Rust)
├── D1 Shim (Go)        — Local SQLite HTTP server mimicking Cloudflare D1
├── workerd (control)    — Runs the control plane Worker locally
├── workerd (frontend)   — Serves the Next.js frontend assets
└── Sandbox VM           — Lightweight VM via platform virtualization
    ├── macOS: Virtualization.framework (via vz-helper Swift process)
    ├── Linux: QEMU/KVM
    └── Windows: Hyper-V (planned)
```

### Startup Sequence
1. Tauri app launches, cleans up any orphaned processes from previous crash (PID file)
2. Stages binaries (d1-shim, workerd) from app resources to data directory
3. Starts D1 shim (SQLite HTTP API on `127.0.0.1:9001`)
4. Starts frontend workerd (serves Next.js on port 8788)
5. Starts control plane workerd (on port 8787)
6. Waits for health checks on both
7. Starts sandbox VM in background thread (can take up to 120s)
8. Window appears immediately (doesn't block on VM boot)

### Shutdown
- SIGTERM to all children, wait 2s, SIGKILL survivors
- Stop sandbox VM
- Remove PID file

---

## Structure

```
desktop/
├── app/                    — Tauri application
│   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── main.rs     — Service orchestration, VM boot, process management
│   │   │   ├── commands.rs — Tauri commands (workspace path, folder import)
│   │   │   └── vm/         — Cross-platform VM abstraction
│   │   │       ├── mod.rs      — VMConfig, VirtualMachine trait
│   │   │       ├── macos.rs    — macOS Virtualization.framework (via vz-helper)
│   │   │       ├── linux.rs    — Linux QEMU/KVM
│   │   │       └── windows.rs  — Windows stub
│   │   ├── resources/      — Bundled runtime resources
│   │   │   ├── frontend/   — Pre-built Next.js assets
│   │   │   ├── vm/         — VM kernel, initrd, rootfs
│   │   │   └── workerd/    — workerd config + assets worker
│   │   └── vz-helper/      — Swift helper for macOS Virtualization.framework
│   └── src/
│       └── index.html      — Tauri webview entry point
├── d1-shim/                — Go HTTP server providing Cloudflare D1 API over local SQLite
│   └── main.go             — /query, /batch, /exec endpoints with WAL mode + retry
├── workerd/                — workerd configuration
│   ├── config/
│   │   ├── workerd.desktop.capnp   — Control plane workerd config
│   │   └── workerd.frontend.capnp  — Frontend assets workerd config
│   └── assets-service/     — Static asset serving worker
├── vm/                     — VM image build tooling
│   ├── image/              — Pre-built kernel, initrd, rootfs
│   ├── config/init.sh      — VM init script
│   └── scripts/            — Image build scripts
├── profile/                — Desktop profile schema + secret generation
└── scripts/
    ├── dev.sh              — Start all services for local development
    ├── build-desktop-resources.sh  — Build all bundled resources
    └── tauri-dev.sh        — Tauri dev mode
```

---

## D1 Shim

Local HTTP server (Go) that provides a Cloudflare D1-compatible API backed by SQLite.

- Endpoints: `/query`, `/batch`, `/exec`
- SQLite with WAL mode, 5s busy timeout, automatic retry on SQLITE_BUSY
- Transactions for batch operations
- The control plane workerd connects to this instead of Cloudflare D1

### Env Vars
- `D1_SQLITE_PATH` — SQLite database path (default: `~/.orcabot/desktop/d1/controlplane.sqlite`)
- `D1_SHIM_ADDR` — Listen address (default: `127.0.0.1:9001`)
- `D1_SHIM_DEBUG` — Enable query logging when set

---

## Sandbox VM

Platform-native lightweight VM running the Go sandbox server.

- **macOS**: Uses Virtualization.framework via a Swift helper process (`vz-helper`)
  - Direct kernel boot (vmlinuz + initrd), no full OS image needed
  - virtio-console for serial output
  - Shared directory for `/workspace`
- **Linux**: QEMU with KVM acceleration
- **Windows**: Hyper-V (planned)

### VM Resources
- `vmlinuz` — Custom Linux kernel
- `initrd.img` — Init ramdisk
- `sandbox-rootfs.tar.gz` — Root filesystem with Go sandbox server

---

## Security

### Folder Import
The `import_folder` Tauri command has hardened path handling:
- Validates subpath has no `..` or absolute components
- `ensure_within_workspace()` — resolves symlinks to catch escapes
- `safe_copy_file()` — uses `O_NOFOLLOW` on Unix to prevent write-through-symlink attacks
- Post-creation containment checks guard against TOCTOU races
- Source symlinks are not followed (`WalkDir::follow_links(false)`)

---

## Dev

```bash
# Quick start (all services)
desktop/scripts/dev.sh

# Build resources (VM + workerd + frontend)
BUILD_VM=force sh desktop/scripts/build-desktop-resources.sh

# Build and run desktop binary
cd desktop/app/src-tauri && cargo build --release
VZ_CONSOLE_DIRECT=1 ./target/release/orcabot-desktop
```

### Default Ports
- Control plane: `http://localhost:8787`
- Frontend: `http://localhost:8788`
- Sandbox: `http://127.0.0.1:8080`
- D1 shim: `http://127.0.0.1:9001`

### Env Vars
- `ORCABOT_DESKTOP_AUTOSTART=0` — Skip service autostart
- `ORCABOT_DESKTOP_ROOT` — Override resource root path
- `SANDBOX_PORT`, `CONTROLPLANE_PORT`, `FRONTEND_PORT` — Port overrides
- `DEV_AUTH_ENABLED=true` — Enable dev auth (default in desktop mode)
- `BUILD_VM=force|0` — Force or skip VM image rebuild
- `VM_ONLY=1` — Skip workerd/frontend builds

### Optional integrations (set before launch)
Each is unset by default; setting a key turns the feature on. Same names as the
production wrangler.production.toml — refer to that for descriptions.

- OAuth client IDs + secrets: `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`, `ONEDRIVE_CLIENT_ID/SECRET`, `BOX_CLIENT_ID/SECRET`, `TWITTER_CLIENT_ID/SECRET`, `DISCORD_CLIENT_ID/SECRET`, `SLACK_CLIENT_ID/SECRET`
- `GOOGLE_API_KEY` — server-side Google APIs (Drive metadata etc.)
- `RESEND_API_KEY` — transactional email
- `EGRESS_PROXY_ENABLED=true` — turn on the network egress proxy inside the sandbox VM (off by default; requires iptables setup)
- `OAUTH_REDIRECT_BASE` — overrides the localhost OAuth callback base
- `EMAIL_FROM` — overrides the default "OrcaBot Desktop <noreply@localhost>"

### Auto-managed
- `SECRETS_ENCRYPTION_KEY` — 32-byte AES-GCM key for stored user_secrets. Generated on first launch and persisted in the app-data dir under the `com.orcabot.desktop` bundle id (macOS: `~/Library/Application Support/com.orcabot.desktop/secrets-encryption-key`; Linux: `~/.local/share/com.orcabot.desktop/secrets-encryption-key`). Losing the file makes existing stored secrets unreadable (by design).

---

## Drift detection

The desktop orchestration layer (`workerd.desktop.capnp` + `main.rs` env plumbing
+ `dev.sh` exports) must stay in sync with the env vars `controlplane/src/**/*.ts`
references. Run:

```bash
node desktop/scripts/check-drift.mjs
```

The script reports:
- ✓ **OK** — var/binding used by code and provided by desktop
- ⚠ **Cloud-only** — listed in `desktop/scripts/drift-allowlist.json` with a reason
- ✗ **MISSING** — code uses it but desktop doesn't provide it (exit 1)

CI runs this on every PR that touches the relevant files (see `.github/workflows/check-desktop-drift.yml`).

When adding a new optional integration to the controlplane:
1. Add the binding to `desktop/workerd/config/workerd.desktop.capnp`
2. Add a `passthrough_env(...)` line in `desktop/app/src-tauri/src/main.rs`
3. Add the var to `desktop/scripts/dev.sh`

When adding a cloud-only feature, instead add it to `desktop/scripts/drift-allowlist.json` under `cloudOnly` with a short reason.

---

## Cloud-only features (not supported on desktop)

These features require infrastructure that desktop doesn't provide. Code paths
that depend on them either degrade gracefully or are gated off entirely.

- **Stripe billing** — paywall bypassed on desktop
- **Cloudflare Access / Turnstile** — desktop uses `DEV_AUTH_ENABLED`
- **Fly.io provisioning** — desktop runs a single local VM
- **Cloudflare Workers Rate Limiting** — bindings unavailable in OSS workerd
- **Inbound messaging webhooks** (Slack events, Discord interactions, WhatsApp, Telegram, Teams, Matrix, Google Chat) — require a public URL
- **Gmail Pub/Sub push** — uses polling on desktop instead
- **R2 drive cache** — substituted with a stub via `ensureDriveCache()`

Full list with reasons: `desktop/scripts/drift-allowlist.json`.

---

## Responsibility Boundaries (non-negotiable)

### Desktop owns
- Native app lifecycle (Tauri)
- Local process orchestration (d1-shim, workerd, VM)
- VM management (start, stop, health check)
- Local workspace and folder import
- PID file cleanup for crash recovery

### Desktop does NOT own
- Control plane logic (runs unmodified workerd Worker)
- Frontend logic (serves unmodified Next.js build)
- Sandbox logic (runs unmodified sandbox binary in VM)
- User auth beyond dev mode
