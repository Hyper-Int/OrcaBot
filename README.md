# Orcabot

A sandboxed, multiplayer AI coding platform. Run Claude Code, Codex, Gemini, or a
plain shell in the browser with zero setup — each dashboard gets its own isolated
VM with a built-in Chromium browser, a secrets broker that keeps API keys away
from the LLM, and a network egress proxy ("Little Snitch for AI agents").
Dashboards are Figma-like multiplayer canvases where terminals, notes, browsers,
and integration blocks (Gmail, GitHub, Drive, Calendar, Twitter, …) are wired
together with edges.

## Two ways to run it

- **Cloud** — Cloudflare Workers control plane + Fly.io sandbox VMs, fronted by
  the Next.js dashboard. This is the hosted product.
- **Desktop** — a native Tauri app (`desktop/`) that bundles the *entire* stack
  locally: control plane on `workerd`, a local SQLite "D1" shim, and a sandbox VM
  via Apple Virtualization.framework (macOS) / QEMU (Linux). No cloud account
  needed at runtime.

## Architecture

```
Browser / Desktop webview / orcabot CLI
        │
Cloudflare control plane (controlplane/)  ── auth, dashboards (Durable Objects),
        │                                     sessions, secrets, integration gateway,
        │                                     PTY tokens, billing, personal access tokens
Fly.io / local VM  sandbox (sandbox/)     ── PTYs, agents, /workspace filesystem,
                                              secrets broker, egress proxy, MCP server
```

The frontend never talks to a sandbox directly — all traffic flows through the
control plane.

## The `orcabot` CLI

The desktop crate ships a second binary, **`orcabot`**, that runs the whole stack
*headlessly* and drives it from the terminal — an interactive TUI plus scriptable
subcommands. It can switch a live session between surfaces (`cli` ↔ `desktop` ↔
`web`) and package a dashboard + workspace for transfer (`export`/`import` locally,
`push`/`pull` against a remote control plane). See `desktop/CLAUDE.md`.

## Repository layout

| Path | What | Guide |
|---|---|---|
| `frontend/` | Next.js dashboard UI (canvas, blog, docs, admin) | `frontend/CLAUDE.md` |
| `controlplane/` | Cloudflare Worker control plane | `controlplane/CLAUDE.md` |
| `sandbox/` | Go sandbox server (PTYs, agents, FS, brokers) | `sandbox/CLAUDE.md` |
| `desktop/` | Tauri desktop app + the `orcabot` CLI | `desktop/CLAUDE.md` |
| `bridge/` | Node WhatsApp/messaging bridge (Fly) | `bridge/CLAUDE.md` |
| `e2e/` | Playwright end-to-end tests | — |

Project-wide conventions and the security model live in the top-level
[`CLAUDE.md`](./CLAUDE.md).

## Quick start

**Desktop (everything local):**

```bash
cd desktop && BUILD_VM=force sh scripts/build-desktop-resources.sh   # one-time: build VM + workerd + frontend
cd app/src-tauri && cargo build --release
# GUI:
VZ_CONSOLE_DIRECT=1 ./target/release/orcabot-desktop
# or CLI (boots the stack headlessly, opens the TUI):
./target/release/orcabot
```

**Cloud (dev):**

```bash
cd controlplane && npm run dev          # control plane on :8787
cd frontend && npx wrangler dev         # frontend on :8788
# sandbox: see CLAUDE.md "Running Locally" for the docker run command
```

## Tests

- Sandbox (Go): `cd sandbox && go test ./...`
- Control plane (vitest): `cd controlplane && npm test`
- E2E (Playwright, against a live instance): `cd e2e && ORCABOT_URL=… npm test`
- Desktop regression smoke (live stack): `desktop/tests/regression-smoke.sh`
