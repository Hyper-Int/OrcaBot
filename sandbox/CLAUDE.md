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

## Coding Practices (MANDATORY)

### Revision Markers
**ALWAYS** add a revision marker comment when modifying code that will be deployed. This helps verify which version is running.

Format: `// REVISION: <feature>-v<N>-<brief-desc>`

Example:
```go
// REVISION: metrics-v2-topprocs
const metricsRevision = "metrics-v2-topprocs"

func init() {
    log.Printf("[metrics] REVISION: %s loaded at %s", metricsRevision, time.Now().Format(time.RFC3339))
}
```

For API responses that can be inspected, include a `revision` field in the response struct so the frontend/client can display what version is running.

### Logging for Deployments
Add a log line on startup or first use of new features that includes the revision with runtime timestamp, so logs confirm deployment success.

---

## High-level product model

- **Dashboards are multiplayer and persistent**
- **Each dashboard gets its own dedicated VM** (one sandbox per dashboard)
- **Sandboxes are ephemeral and single-tenant**
- **A sandbox may host multiple terminals (PTYs)**
- **Each terminal maps to a control-plane session** (one session per terminal item)
- **Each session maps to a PTY inside the dashboard sandbox**
- **Each terminal supports multiple viewers but only one controller at a time**
- **Terminal input uses explicit turn-taking**
- **Claude Code runs inside a sandbox as an agent, not as infrastructure**

---

## System architecture overview

### Layers

Browser
├── Dashboard UI (multiplayer)
├── File explorer
└── Terminal panes (xterm.js)
↓
Cloudflare (control plane)
├── Auth
├── Dashboard collaboration (Durable Objects)
├── Session orchestration
├── Integration policy gateway (OAuth tokens stay here)
└── Routing
↓
Fly.io (execution plane)
└── Sandbox (1 machine per dashboard)
├── Go backend (cmd/server)
├── MCP server (integration + browser/UI tools)
├── MCP bridge (stdio↔HTTP for Claude Code/Gemini)
├── Multiple PTYs (terminals)
├── Turn-taking controller (per PTY)
├── Agent hooks (stop detection for all agent types)
├── Secrets broker (localhost:8082)
└── /workspace filesystem

---

## Responsibility boundaries (non-negotiable)

### Backend (Go) owns **truth**
- Sandbox lifecycle (Fly Machines)
- PTY creation and management
- PTY ↔ WebSocket streaming
- Turn-taking enforcement
- Filesystem access (`/workspace`)
- Agent execution (Claude Code, Gemini, Codex, etc.)
- Session metadata persistence
- Secrets broker and output redaction
- MCP server (tool discovery + proxying to control plane gateway)
- MCP bridge (stdio-to-HTTP translation for LLM clients)
- Agent hook generation (stop detection for all supported agents)
- Integration tool listing (based on attached integrations via gateway)

### Frontend (not in this repo) owns **experience**
- Dashboard UI
- Multiplayer presence & UX
- Terminal rendering (xterm.js)
- Turn-taking UI (request / grant / revoke)
- File explorer UI
- Session lifecycle UX

### Explicit constraints
- xterm.js lives **only** in the frontend
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

## Secrets Protection

The sandbox implements two layers of defense against LLM secret exfiltration.

### Output Redaction
**File:** `internal/pty/hub.go`

- All PTY output is scanned before broadcasting
- Secret values (≥8 chars) are replaced with asterisks
- Handles secrets split across output chunks via tail buffering
- One-way redaction - no reveal UI

### Session-Local Auth Broker
**File:** `internal/broker/secrets_broker.go`

- HTTP server running on `localhost:8082` inside each sandbox
- API keys are NOT set as env vars (only dummy placeholders)
- Broker injects real keys when forwarding requests
- **Session-namespaced**: all configs and approved domains keyed by `sessionID:provider` to isolate terminals sharing a VM

Built-in providers (hardcoded allowlist):
- Anthropic, OpenAI, Google, Gemini
- ElevenLabs, Deepgram
- Groq, Together, Fireworks, Mistral, Cohere, Replicate, Hugging Face

Custom secrets use dynamic domain approval:
- Route: `/broker/{sessionID}/custom/{secretName}?target=https://...`
- Returns 403 with approval request if domain not in allowlist
- Owner approves via frontend (out-of-band)
- Approved domains scoped per-session (two sessions can independently approve the same domain)

Security rules:
- HTTPS only (except localhost in dev mode)
- No redirect following to different hosts
- Auth headers stripped from responses
- Target host must match provider or approved allowlist
- Broker URL must include correct session ID — no cross-session access

### Env Setup Flow
**File:** `cmd/server/env.go`

When secrets are applied to a session:
1. `brokerProtected=true`: Set dummy value + broker URL in env
2. `brokerProtected=false`: Set actual value in env (user override)
3. Pass secret values to Hub for redaction
4. Configure broker with provider configs

---

## Network Egress Proxy

An HTTP/HTTPS forward proxy on `localhost:8083` that acts as "Little Snitch for AI Agents". Intercepts all outbound HTTP(S) from PTY processes via `HTTP_PROXY`/`HTTPS_PROXY` env vars.

### How It Works
- **CONNECT** (HTTPS): Extracts domain from `CONNECT host:port`, checks allowlist
- **Regular HTTP**: Extracts domain from Host header, checks allowlist
- **Allowed domains**: Connection proceeds immediately
- **Unknown domains**: Connection is **held** (goroutine blocks on channel). Frontend shows approval dialog. User chooses Allow Once / Always Allow / Deny.
- **Timeout**: 60 seconds with no response = deny (fail-closed)
- **Coalescing**: Multiple connections to the same unknown domain share one approval prompt

### Default Allowlist
Hardcoded in `internal/egress/allowlist.go`:
- Package registries (npm, PyPI, crates.io, Maven, Gradle, etc.)
- Git hosting (GitHub, GitLab, Bitbucket + subdomains)
- System packages (Debian, Ubuntu, Alpine)
- CDNs (Cloudflare, CloudFront, Fastly, jsDelivr, unpkg)
- LLM APIs (Anthropic, OpenAI, ChatGPT, Google, Groq, Together, etc.)
- Telemetry (Datadog, Sentry)
- Common dev tools (Node.js, Google storage)

Glob matching: `*.example.com` matches subdomains but NOT `example.com` itself.

### Feature Flag
- `EGRESS_PROXY_ENABLED=true` env var: Enable globally for all sessions
- Per-session opt-in: `egress_enabled: true` in session or PTY creation request body
- Without either, proxy runs but PTYs don't route through it

### Localhost Bypass
Localhost traffic (`localhost`, `127.0.0.1`, `::1`) always bypasses the proxy:
- `NO_PROXY=localhost,127.0.0.1` env var (client-side hint)
- Server-side `isLocalhost()` check in proxy (catches tools that ignore NO_PROXY)

### Key Files
- `internal/egress/proxy.go` — HTTP/HTTPS forward proxy with connection holding
- `internal/egress/allowlist.go` — Default + runtime allowlist with glob matching
- `internal/egress/proxy_test.go` — Unit tests (14 tests, race-safe)
- `internal/egress/allowlist_test.go` — Allowlist matching tests

### Sandbox Endpoints
- `POST /egress/approve` — Control plane delivers user decision
- `POST /egress/revoke` — Remove domain from runtime allowlist
- `GET /egress/pending` — List pending approvals (for UI sync on reconnect)
- `GET /egress/allowlist` — Current allowlist (default + user)

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

### Attach terminal (xterm.js)
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

### Broker (session-local, localhost:8082)
/broker/{sessionID}/{provider}/{path}         # Built-in provider (anthropic, openai, etc.)
/broker/{sessionID}/custom/{secretName}       # Custom secret with ?target= param

### Testing Custom Secret Domain Approval

To test the broker requesting permission for an unknown domain:

```bash
# Inside the sandbox, make a request with a custom secret to an unapproved domain
# Replace {sessionID} with the actual session ID
curl -X POST "http://localhost:8082/broker/{sessionID}/custom/MY_API_KEY?target=https://api.example.com/v1/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "test"}'

# Expected response (403): domain requires approval
# {"error":"domain_approval_required","domain":"api.example.com","secret":"MY_API_KEY","message":"This domain requires owner approval before the secret can be sent."}

# The broker will also notify the control plane, creating a pending approval request
# that appears in the frontend for the dashboard owner to approve.
```

### Coding Agent integration
Claude Code, Gemini CLI, and Codex CLI are preinstalled in the sandbox image.
Agents run as CLI processes inside PTYs.

**Supported agents:** Claude Code, Gemini CLI, OpenCode, Codex, Droid, OpenClaw

**Agent control signals:**
- **Pause**: `SIGSTOP`
- **Resume**: `SIGCONT`
- **Stop**: Triple `SIGINT` → `SIGTERM` → `SIGKILL` (escalating)

**Agent hooks:** When an agent finishes a turn, a stop hook script calls back to the sandbox
server which broadcasts `agent_stopped` WebSocket events. Each agent type has its own hook
configuration format — see `internal/agenthooks/hooks.go`.
- **All hooks must send `X-MCP-Secret: $ORCABOT_MCP_SECRET` header** — unauthenticated callbacks are rejected (fail-closed)

### MCP Server (Model Context Protocol)

The sandbox exposes an HTTP-based MCP server at `/sessions/:id/mcp/*`.

**Localhost auth (security-critical):** All localhost MCP requests require `pty_id` query param + `X-MCP-Secret` header matching the secret assigned at PTY creation (`ORCABOT_MCP_SECRET` env var). Requests without valid auth are rejected with 403. This prevents rogue processes in the sandbox from using integration tools.

**Tool categories:**
1. **Browser/UI tools** — Always available (browser_navigate, screenshot, etc.)
2. **Integration tools** — Only available when an integration is attached to the terminal

**Integration tool discovery flow:**
1. MCP client calls `tools/list` with `?pty_id=` query param + `X-MCP-Secret` header
2. Sandbox validates MCP secret, reads `ORCABOT_INTEGRATION_TOKEN` from PTY environment
3. Sandbox calls `GET /internal/terminals/:ptyId/integrations` on control plane
4. Control plane verifies PTY token, returns list of attached providers
5. Sandbox adds tool definitions for each attached provider (gmail_*, github_*, etc.)

**Integration tool call flow:**
1. MCP client calls `tools/call` with tool name + arguments (+ `pty_id` + `X-MCP-Secret`)
2. Sandbox forwards to `POST /internal/gateway/:provider/execute` with PTY token
3. Control plane enforces policy, makes API call, filters response
4. Sandbox wraps result in MCP content format: `{"content": [{"type": "text", "text": "..."}]}`

### MCP Bridge

`cmd/mcp-bridge/` is a stdio-to-HTTP bridge. LLM clients (Claude Code, Gemini) communicate
via JSON-RPC over stdin/stdout; the bridge translates to HTTP calls.

- Advertises `listChanged: true` capability
- Background goroutine polls for tool list changes every 5s
- Sends `notifications/tools/list_changed` when integrations are attached/detached
- This allows LLMs to discover new tools without restarting

### Sandbox launch
- **MVP**: Cold start is acceptable (2-5s Fly Machine spin-up)
- **Future**: Warm spare VM per region

---

## Directory structure

sandbox/
├── cmd/
│   ├── server/
│   │   ├── main.go          // HTTP server, route registration
│   │   └── mcp.go           // MCP proxy handlers (tools/list, tools/call)
│   └── mcp-bridge/
│       └── main.go          // stdio↔HTTP bridge for Claude Code/Gemini
├── internal/
│   ├── sessions/
│   │   ├── manager.go
│   │   ├── session.go       // PTY creation, env var injection, token storage
│   │   └── lifecycle.go
│   ├── pty/
│   │   ├── pty.go
│   │   ├── hub.go           // fan-out, broadcast, output redaction, agent state
│   │   └── turn.go
│   ├── mcp/
│   │   ├── settings.go          // MCP settings generation per agent type
│   │   ├── integration_tools.go // Tool definitions (Gmail, GitHub, Drive, Calendar)
│   │   └── gateway_client.go    // HTTP client for control plane gateway
│   ├── agenthooks/
│   │   └── hooks.go         // Stop hook generation for all agent types
│   ├── broker/
│   │   ├── secrets_broker.go
│   │   └── providers.go
│   ├── ws/
│   │   ├── handler.go
│   │   └── client.go
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

cmd/server/
  Wire everything together. HTTP server, route registration, MCP proxy handlers.
  - main.go: HTTP routes, session management, PTY endpoints
  - mcp.go: MCP tool listing (merges browser/UI tools + integration tools) and tool call proxying

cmd/mcp-bridge/
  stdio-to-HTTP bridge for MCP. Claude Code and Gemini use stdio transport;
  this translates JSON-RPC over stdin/stdout to HTTP calls to the sandbox MCP server.
  - Passes PTY token for integration tool discovery
  - Monitors for tool list changes (polls every 5s) and sends `notifications/tools/list_changed`
    so LLMs discover newly attached integrations without restarting
  - Uses `GEMINI_CLI_SYSTEM_SETTINGS_PATH` for durable Gemini config

internal/sessions/
  Session lifecycle. Sessions contain PTYs. PTY creation injects env vars
  including `ORCABOT_INTEGRATION_TOKEN` for gateway auth and agent-specific
  settings (e.g., `GEMINI_CLI_SYSTEM_SETTINGS_PATH`).
  - manager.go: create/destroy sessions
  - session.go: Session struct, CreatePTY with token injection, MCP settings + hook generation

internal/pty/
  Multiplayer terminal mechanics.
  - pty.go: low-level PTY creation (os/exec, creack/pty)
  - hub.go: fan-out, clients, broadcast, output redaction, agent state detection
  - turn.go: turn-taking state machine

internal/mcp/
  MCP tool definitions and control plane gateway client.
  - settings.go: Generates per-agent MCP config files (.mcp.json, settings.json, config.toml, etc.)
  - integration_tools.go: Tool definitions for Gmail, GitHub, Drive, Calendar (name, description, inputSchema)
  - gateway_client.go: HTTP client for `GET /internal/terminals/:ptyId/integrations` and
    `POST /internal/gateway/:provider/execute` with PTY token auth

internal/agenthooks/
  Agent stop hook generation for all supported agent types.
  Hooks call back to `POST /sessions/:id/ptys/:ptyId/agent-stopped` when an agent finishes,
  enabling WebSocket `agent_stopped` events.
  - Supported: Claude Code, Gemini CLI, OpenCode, Codex, Droid, OpenClaw
  - Each agent has its own config format (JSON, TOML, YAML, etc.)
  - Gemini settings use system override file to survive CLI rewrites

internal/broker/
  Session-local auth broker for API keys.
  - secrets_broker.go: HTTP server on localhost:8082, session-namespaced config/allowlist, request forwarding with key injection
  - providers.go: Provider specs (URLs, headers, allowlists)

internal/ws/
  WebSocket handling: upgrade HTTP→WS, authenticate, route to PTY hub.

internal/fs/
  Read/write files under /workspace with path scoping.

internal/agent/
  Agent lifecycle: launch, pause (SIGSTOP), resume (SIGCONT), stop (escalating signals).

internal/auth/
  WS auth, role checking (viewer vs controller), session ownership.

---

## Future: Cloudflare internal API integration

The `/internal/executions/:id/artifacts` and `/internal/events` endpoints are for future integration when the sandbox needs to:
- Report execution results/artifacts back
- Emit events to trigger schedules

When that integration is implemented, it will need to:
1. Add `INTERNAL_API_TOKEN` to sandbox config
2. Include `X-Internal-Token` header in outbound calls
3. Use the `/internal/` prefixed routes
