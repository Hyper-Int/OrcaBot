# Orcabot Desktop

Dev docs for building the desktop app from source. End users install a pre-built
`.dmg` / `.AppImage` / `.exe` — workerd, d1-shim, frontend assets, and the VM
image are bundled into the installer, so they need none of the toolchains below.

## Layout
- app/     Tauri shell (UI + orchestrator).
- d1-shim/ Local D1 (SQLite) HTTP shim for workerd.
- workerd/ Local controlplane runtime config and scripts.
- vm/      VM image build and sandbox startup.
- profile/ Desktop profile schema + secret generation.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Rust + Cargo | stable (`rustup` recommended) | Tauri shell (`desktop/app/src-tauri`) |
| Go | ≥ 1.20 | d1-shim binary |
| Node.js | **≥ 20** (system Node 18 silently fails wrangler/OpenNext) | controlplane bundle + frontend bundle |
| npm | bundled with Node 20 | dependency install |

### Linux system packages (Tauri + WebKit)
```
sudo apt install -y libwebkit2gtk-4.1-dev build-essential libxdo-dev \
                    libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
```

### macOS
- Xcode Command Line Tools (`xcode-select --install`)
- For the sandbox VM: macOS 13+ (uses Virtualization.framework via `vz-helper`)

### One-time setup
```
# Project-level npm installs (controlplane downloads the workerd binary; frontend pulls Next.js/OpenNext)
( cd controlplane && npm install )
( cd frontend && npm install )
```

## Dev (quick start — no Tauri shell)
Runs d1-shim + controlplane workerd + frontend dev server. Good for iterating
on controlplane/frontend code without touching Tauri.
```
desktop/scripts/dev.sh
```

Defaults:
- controlplane: http://localhost:8787
- frontend: http://localhost:8788
- sandbox url: http://127.0.0.1:8080
- DEV_AUTH_ENABLED=true

A 32-byte `SECRETS_ENCRYPTION_KEY` is generated on first run and persisted at
`desktop/.dev-secrets-encryption-key` (gitignored). Delete the file to rotate.

## Local Desktop Dev (full Tauri build)
1. Build the bundled resources (controlplane bundle + d1-shim + frontend bundle + VM image):
   ```
   NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 \
   NEXT_PUBLIC_SITE_URL=http://127.0.0.1:8788 \
   NEXT_PUBLIC_DEV_MODE_ENABLED=true \
   BUILD_VM=force \
   sh desktop/scripts/build-desktop-resources.sh
   ```
   Skip the VM rebuild when iterating on the binary:
   ```
   BUILD_VM=0 sh desktop/scripts/build-desktop-resources.sh
   ```
2. Build and run the Tauri binary:
   ```
   cd desktop/app/src-tauri && cargo build --release
   VZ_CONSOLE_DIRECT=1 ./target/release/orcabot-desktop
   ```
   The Tauri shell persists its `SECRETS_ENCRYPTION_KEY` at the OS-standard
   app-data dir (e.g. `~/.local/share/com.orcabot.desktop/secrets-encryption-key`
   on Linux). Losing it makes existing stored user secrets unreadable.

### Drift check
The desktop orchestration layer (workerd capnp + main.rs env plumbing) must
stay in sync with the env vars the controlplane code references. Run:
```
node desktop/scripts/check-drift.mjs
```
This also runs in CI on PRs that touch controlplane/desktop config.

### Optional flags
- `VM_ONLY=1` — skip workerd, d1-shim, and frontend builds (VM-only iteration).
- `BUILD_VM=force|0` — force or skip the VM image rebuild.
