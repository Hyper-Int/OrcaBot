# Orcabot Desktop Plan (Tauri + workerd + VM)

## Goals
- Single consumer-friendly app with strong isolation for untrusted code.
- Keep frontend/controlplane/sandbox code shared with production.
- Offline-capable desktop mode.
- Avoid Node at runtime; use workerd directly.

## Status
- Repo layout created under `desktop/` with app/workerd/vm/profile skeletons.
- Tauri v2 shell scaffolded in `desktop/app/` with placeholder UI.
- workerd config + launcher in progress; controlplane now supports a D1 HTTP shim fallback.
- D1 shim service scaffolded in `desktop/d1-shim/` (SQLite-backed).
- Desktop dev script added to launch shim + workerd + frontend.
- Drive cache (R2) now returns a desktop-disabled error when not configured.

## Architecture
- UI: Tauri shell renders built frontend assets.
- Controlplane: workerd binary runs the same Worker bundle as prod.
- Sandbox: Go sandbox binary runs inside a minimal Linux VM.
- Storage: local SQLite for D1, filesystem for KV/DO persistence.

## Security model
- Untrusted code executes only inside the VM.
- Host services are protected by local auth tokens or OS IPC.
- Shared folders are user-driven and permissioned per mount.

## Desktop vs Production Compatibility
- Frontend: same build output.
- Controlplane: same Worker code.
- Sandbox: same Go binary.
- Differences: local persistence, local auth, single-user mode.

## Repo Layout (Option A)
- desktop/
  - app/ (Tauri shell)
    - src-tauri/ (Rust backend)
    - src/ (desktop UI shell)
    - assets/ (icons, installer metadata)
  - workerd/
    - config/ (desktop workerd config)
    - scripts/ (bundle + run workerd)
  - d1-shim/
    - scripts/ (run shim)
    - main.go (SQLite-backed D1 HTTP service)
  - scripts/
    - dev.sh (start shim + workerd + frontend)
  - vm/
    - image/ (Linux image build)
    - config/ (init/system scripts)
    - scripts/ (build image, inject sandbox)
  - profile/
    - schema.json (desktop config schema)
    - scripts/ (secret generation, storage)

## Runtime components
- workerd
  - Runs on localhost with a generated config that binds:
    - D1 to a local SQLite file
    - KV/DO to local storage directories
  - Exposes a local controlplane port for the UI.
- VM
  - Minimal Linux image (Alpine or NixOS).
  - Includes sandbox Go binary and required dev tools.
  - Shared folder mounted at /workspace (user-selected).
  - Sandbox listens on localhost inside the VM; host proxies to UI.
- Tauri app
  - Starts workerd and the VM.
  - Manages secrets, ports, and mount permissions.
  - Exposes the UI and desktop settings.

## Secrets and local auth
- Desktop profile is generated on first run.
- Secrets are random per install and stored in OS credential store.
- Tokens are used for local HTTP auth or IPC protection.

## Platform VM strategy
- macOS: Virtualization.framework.
- Windows: WSL2 (preferred) or Hyper-V.
- Linux: KVM/QEMU.

## Build flow
- Production:
  - frontend/ -> npm run build -> Cloudflare Pages.
  - controlplane/ -> wrangler deploy -> Cloudflare Workers.
  - sandbox/ -> make deploy -> Fly.io.
- Desktop:
  - frontend/ -> npm run build -> embed in Tauri.
  - controlplane/ -> workerd bundle -> embed in Tauri.
  - sandbox/ -> cross-compile Go -> include in VM image.
  - vm/ -> build minimal image -> bundle with desktop app.
  - package -> .dmg / .exe / .AppImage.

## Required new artifacts (initial)
- desktop/app/src-tauri/tauri.conf.json
- desktop/app/src-tauri/src/main.rs
- desktop/workerd/config/workerd.desktop.capnp
- desktop/workerd/scripts/build-workerd.sh
- desktop/d1-shim/main.go
- desktop/d1-shim/scripts/run-d1-shim.sh
- desktop/vm/scripts/build-image.sh
- desktop/vm/config/init.sh
- desktop/profile/schema.json
- desktop/profile/scripts/generate-secrets.(rs|ts|sh)

## Open questions
- Preferred minimal Linux base (Alpine vs NixOS).
- Do we need a dedicated local proxy between UI and workerd.
- Storage location for local persistence (per-user vs per-workspace).
- Exact UX for mounting drives and resetting desktop profile.
- Best path for D1 + R2 on workerd (shim service vs miniflare fallback).

## Milestones
1) Build macOS prototype with workerd + VM boot + sandbox run.
2) Add desktop profile generation and local storage wiring.
3) Package and ship a macOS build.
4) Add Windows and Linux VM backends.
