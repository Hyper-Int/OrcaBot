# CLAUDE.md

## Purpose

This repository implements a **terminal-first, multiplayer agentic coding platform on the web**.
The frontend will look like Figma for AI agents. It will allow multiple terminals to be created
that can run claude code or codex cli or just the shell. It will have a basic file explorer for
the remote work directory. It will also allow integrations with google drive, github, post it
notes etc. When the user adds a terminal in the webpage it will trigger a sandboxed docker VM
on the backend. These dashboards are multiplayer like google docs the terminals can only have
one driver at a time but every doc user should be able to see the output.

This is the repo for the backend that supports all of this.

Claude should act as a **systems-oriented engineering assistant**, helping to build:
- a Go-based backend that owns execution truth (sandboxes, PTYs, agents)

Claude should **not invent alternative architectures** or expand scope beyond what is specified here.

---

## High-level product model

- **Dashboards are multiplayer and persistent**
- **Sandboxes are ephemeral and single-tenant**
- **A sandbox may host multiple terminals (PTYs)**
- **Each terminal supports multiple viewers but only one controller at a time**
- **Terminal input uses explicit turn-taking**
- **Claude Code runs inside a sandbox as an agent, not as infrastructure**

---

## System architecture overview

### Layers

Browser
├── Dashboard UI (multiplayer)
├── File explorer
└── Terminal panes (Ghostty-web)
↓
Cloudflare (control plane)
├── Auth
├── Dashboard collaboration (Durable Objects)
├── Session orchestration
└── Routing
↓
Fly.io (execution plane)
└── Sandbox (1 machine per session)
├── Go backend
├── Multiple PTYs (terminals)
├── Turn-taking controller (per PTY)
├── Agent controller (Claude Code)
└── /workspace filesystem

---

## Responsibility boundaries (non-negotiable)

### Backend (Go) owns **truth**
- Sandbox lifecycle (Fly Machines)
- PTY creation and management
- PTY ↔ WebSocket streaming
- Turn-taking enforcement
- Filesystem access (`/workspace`)
- Agent execution (Claude Code)
- Session metadata persistence

### Frontend (not in this repo) owns **experience**
- Dashboard UI
- Multiplayer presence & UX
- Terminal rendering (Ghostty-web)
- Turn-taking UI (request / grant / revoke)
- File explorer UI
- Session lifecycle UX

### Explicit constraints
- Ghostty-web lives **only** in the frontend
- Docker / sandbox runtime lives **only** in the backend
- No IDE/editor features
- No concurrent terminal typing
- No Redis (unless explicitly revisited)

---

## Multiplayer model

### Dashboards
- True multiplayer (Google Docs–style)
- Implemented via **Cloudflare Durable Objects**
- Postgres is the source of truth
- Durable Objects handle live fan-out and coordination

### Terminals
- Shared execution model (like shared hardware)
- One PTY per terminal
- Multiple users may observe
- Exactly one controller may send input
- Control is explicit and revocable (turn-taking)

---

## Turn-taking rules (terminals)

- Only the controller's input reaches the PTY
- Observers are read-only
- Control must be explicitly:
  - requested
  - granted (by current controller)
  - revoked
- Control may expire automatically
- Claude Code may take control without requesting, but must yield when finished
- Control state is **in-memory per PTY**, not persisted

### Controller disconnect behavior
- On disconnect: control is released after **10 second grace period**
- If original controller reconnects within 10s: control is automatically re-granted
- If grace period expires: control becomes available (no controller)

---

## Agent input control (soft lock)

When Claude Code (or other agents) run in a multiplayer terminal, there's a risk of **byte-level input interleaving** if humans and the agent type simultaneously. This could corrupt commands.

### Soft lock model (implemented)

The backend enforces a "soft lock" on agent PTYs:

| Agent State | Human Input | Rationale |
|-------------|-------------|-----------|
| **Running** | Blocked | Agent has exclusive control; human input silently dropped |
| **Paused**  | Allowed | Agent is SIGSTOP'd; humans can take control via turn-taking |
| **Stopped** | Allowed | Agent terminated; normal PTY behavior |

### Implementation details

- Agent Hub has `agentMode` flag (true for agent PTYs)
- `Hub.Write()` checks agent state before allowing human input
- State changes broadcast `agent_state` events to all clients
- Frontend should show "Agent is running" indicator and disable typing

### WebSocket events

```json
{"type": "agent_state", "agent_state": "running"}  // Human input blocked
{"type": "agent_state", "agent_state": "paused"}   // Human input allowed
{"type": "agent_state", "agent_state": "stopped"}  // Agent terminated
```

### Why soft lock?

- **Prevents corruption**: Commands can't interleave at byte level
- **Backend authority**: Even if UI bugs allow typing, backend drops it
- **Natural UX**: Matches user expectation (can't type while Claude is working)
- **Flexible**: Pause allows manual intervention when needed

---

## Persistence model

### Persisted (Postgres)
- Users
- Dashboards
- Dashboard items (notes, todos, layout)
- Dashboard permissions
- Session metadata
- Usage / billing counters
- Integration tokens (encrypted)

### Not persisted
- PTY buffers
- Running processes
- Live terminal state
- Agent scratchpads

Sandboxes are expected to die and be recreated.

---

## API surface (summary)

### Sessions / Sandboxes
POST /sessions
DELETE /sessions/:sessionId

### Terminals (PTYs)
GET    /sessions/:id/ptys
POST   /sessions/:id/ptys
DELETE /sessions/:id/ptys/:ptyId

### Attach terminal (Ghostty-web)
wss://sandbox/sessions/:id/ptys/:ptyId/ws

- Binary frames: PTY output
- Binary input: accepted only from controller
- JSON control frames: resize, turn-taking

### WebSocket reconnection behavior
- On reconnect: client attaches and receives output from "now" (no replay)
- **Future**: keep per-PTY ring buffer (256KB–2MB) for scrollback replay on reconnect

### Turn-taking messages (JSON)

{ "type": "request_control" }
{ "type": "grant_control", "to": "user_id" }
{ "type": "revoke_control" }
{ "type": "control_expired" }

Filesystem (scoped to /workspace)

GET    /sessions/:id/files
GET    /sessions/:id/file
PUT    /sessions/:id/file
DELETE /sessions/:id/file
POST   /sessions/:id/upload

### Coding Agent integration
Claude Code and Codex CLI are preinstalled in the sandbox image.
Claude runs as a CLI process inside a PTY.

**Agent control signals:**
- **Pause**: `SIGSTOP`
- **Resume**: `SIGCONT`
- **Stop**: Triple `SIGINT` → `SIGTERM` → `SIGKILL` (escalating)

### Sandbox launch
- **MVP**: Cold start is acceptable (2-5s Fly Machine spin-up)
- **Future**: Warm spare VM per region

---

## Work plan (phased)

### Phase 1 — Core sandbox & PTY (backend)
- Go HTTP server skeleton
- Fly Machine–based sandbox launch
- Docker image with Claude Code installed
- Single PTY per sandbox
- WebSocket ↔ PTY streaming
- Resize + signal handling
- Hard kill / cleanup

Goal: one user, one terminal, works reliably

### Phase 2 — Multiple PTYs per sandbox
- PTY manager (map of PTYs)
- Create / destroy terminal endpoints
- Independent PTY lifecycles
- Shared /workspace

Goal: multiple terminals like tmux windows

### Phase 3 — Multiplayer terminals with turn-taking
- PTY hub with fan-out
- Turn controller state machine
- Request / grant / revoke control
- Auto-revoke on disconnect (10s grace period for reconnect)
- Optional control timeouts

Goal: safe shared terminals

### Phase 4 — Claude Code as agent
- Dedicated Claude terminal
- Agent controller wrapper
- Pause (SIGSTOP) / resume (SIGCONT) / stop (SIGINT→SIGTERM→SIGKILL)
- Soft lock: agent has exclusive input control while running
- Humans can only type when agent is paused
- `agent_state` WebSocket events for UI sync

Goal: Claude can "drive" visibly and safely

backend/
├── cmd/
│   └── server/
│       └── main.go 
├── internal/
│   ├── sessions/
│   │   ├── manager.go
│   │   ├── session.go
│   │   └── lifecycle.go
│   ├── sandbox/
│   │   ├── fly.go
│   │   ├── spec.go
│   │   └── launcher.go
│   ├── pty/
│   │   ├── pty.go
│   │   ├── session.go
│   │   ├── hub.go
│   │   └── turn.go
│   ├── ws/
│   │   ├── handler.go
│   │   ├── router.go
│   │   └── protocol.go
│   ├── fs/
│   │   └── workspace.go
│   ├── agent/
│   │   └── controller.go
│   └── auth/
│       └── auth.go
├── api/
│   └── openapi.yaml
└── go.mod

## Package-by-package

cmd/server/main.go
Role:
  Wire everything together
  Load config
  Start HTTP + WS server
  Handle shutdown
  Keep this thin.
  
internal/sessions/
Role:
  Session lifecycle
  Session ↔ sandbox mapping
  Metadata persistence hooks
  Session termination logic
    sessions/
    ├── manager.go      // create/destroy sessions
    ├── session.go      // Session struct (ID, state, PTYs)
    └── lifecycle.go    // start/stop, cleanup
  Sessions do not manage PTYs directly — they contain them.

internal/sandbox/
Role:
  Fly Machine lifecycle
  Environment variables
  Volume mounts
  Image selection
  This is the “execution substrate” layer.
    sandbox/
      ├── fly.go
      ├── spec.go        // machine specs
      └── launcher.go    // abstract interface (future-proof)
  
internal/pty/
  This is where multiplayer complexity lives
    pty/
      ├── pty.go          // low-level PTY creation (os/exec, creack/pty)
      ├── session.go      // PTYSession (1 PTY = 1 terminal)
      ├── hub.go          // fan-out, clients, broadcast
      └── turn.go         // turn-taking state machine
  This keeps:
    PTY mechanics
    multiplayer logic
    turn control

internal/ws/
  This should:
    Upgrade HTTP → WS
    Authenticate user
    Route to correct PTY hub
    Translate frames
    
    ws/
      ├── handler.go
      ├── router.go      // maps WS → PTYSession
      └── protocol.go    // message formats

internal/fs/
  Role:
    Read/write files under /workspace
    Enforce path scoping
    Provide stat/list APIs

internal/agent/
  Role:
    Launch Claude Code
    Inject commands
    Pause / stop / resume

api/openapi.yaml
  This gives:
    shared contract clarity
    frontend/backend alignment
    future SDK potential

internal/auth/
  WS auth
  Role checking (viewer vs controller)
  Session ownership
  This avoids auth logic leaking everywhere later.

---

## Future: Cloudflare internal API integration

The `/internal/executions/:id/artifacts` and `/internal/events` endpoints are for future integration when the sandbox needs to:
- Report execution results/artifacts back
- Emit events to trigger schedules

When that integration is implemented, it will need to:
1. Add `INTERNAL_API_TOKEN` to sandbox config
2. Include `X-Internal-Token` header in outbound calls
3. Use the `/internal/` prefixed routes