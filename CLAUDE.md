# AGENTS.md

This repo is a monorepo for Orcabot - a sandboxed, multiplayer AI coding platform.

## Coding Practices (MANDATORY for ALL repos)

### Revision Markers
**ALWAYS** add a revision marker when modifying code. This eliminates "did you deploy?" debugging.

1. **Comment at top of modified file:**
   ```
   // REVISION: <feature>-v<N>-<brief>
   ```

2. **Log on load/startup with runtime timestamp:**
   ```typescript
   // Frontend (TypeScript)
   const MODULE_REVISION = "feature-v1-desc";
   console.log(`[module] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
   ```
   ```go
   // Backend (Go)
   const moduleRevision = "feature-v1-desc"
   log.Printf("[module] REVISION: %s loaded at %s", moduleRevision, time.Now().Format(time.RFC3339))
   ```

3. **For API responses:** Add a `revision` field so clients can display what version is running.

This is non-negotiable. Never speculate about deployment issues - add logs that prove it.

## What Orcabot Does
- Run Claude Code, Codex, or shell in the browser with zero setup
- Sandboxed VMs for security (isolated execution)
- Built-in Chromium browser for testing
- Secrets broker protects API keys from LLM exfiltration
- Persistent, background intelligent processes
- Multiplayer dashboards (Figma-like collaboration)

## Structure
- `frontend` — Next.js dashboard UI
- `controlplane` — Cloudflare Worker control plane
- `sandbox` — Go sandbox server

## App Guides
- Frontend: `frontend/CLAUDE.md`
- Control plane: `controlplane/CLAUDE.md`
- Sandbox: `sandbox/CLAUDE.md`

## Deploy (Prod)
```
cd sandbox && make deploy && cd ../controlplane && wrangler deploy -c wrangler.production.toml && cd ../frontend && npm run workers:deploy && cd ..
```

## Running Locally
Sandbox:
```
docker run --rm -it \
    -p 8080:8080 \
    --cpus=2 --memory=4g \
    -e SANDBOX_INTERNAL_TOKEN=... \
    -e CONTROLPLANE_URL=http://localhost:8787 \
    -e INTERNAL_API_TOKEN=... \
    -e ALLOWED_ORIGINS=http://localhost:8788 \
    -v orcabot-sandbox-workspace:/workspace \
    orcabot-sandbox
```

Control plane:
```
npm run dev
```

Frontend:
```
npx wrangler dev
```

## Auth + Security Architecture

### Auth Flow
- Frontend never talks directly to sandbox; all traffic goes through the control plane
- Cloudflare control plane uses dev auth via headers/query params when `DEV_AUTH_ENABLED=true`
- Internal sandbox auth uses `SANDBOX_INTERNAL_TOKEN` (do not reuse Cloudflare API keys)

### Secrets Protection (Security-Critical)
Orcabot has a layered defense system to prevent LLMs from exfiltrating API keys:

1. **Secrets Broker** - API keys are NOT set as env vars. Instead, a session-local broker injects keys server-side. LLMs only see placeholder values. Broker configs and approved domains are **session-namespaced** — two terminals in the same VM cannot see or overwrite each other's keys.

2. **Output Redaction** - Any secret values in PTY output are replaced with asterisks before reaching WebSocket clients.

3. **Domain Allowlisting** - Built-in providers (Anthropic, OpenAI, ElevenLabs, etc.) have hardcoded target domains. Custom secrets require owner approval per-domain, scoped per-session.

4. **Localhost Auth** - The MCP server and event endpoints on localhost require `X-MCP-Secret` proof-of-possession. Each PTY gets a unique `ORCABOT_MCP_SECRET` env var at creation. This prevents rogue processes in the sandbox from calling MCP tools or faking agent events.

5. **PTY Token Fail-Closed** - `INTERNAL_API_TOKEN` must be non-empty. If it's missing, PTY token verification rejects all tokens rather than accepting them.

Security invariants (non-negotiable):
- Broker configs keyed by `sessionID:provider` — never global provider name
- Broker URLs include session ID: `/broker/{sessionID}/{provider}/...`
- Approved domains keyed by `sessionID:secretName` — never just secret name
- Empty `INTERNAL_API_TOKEN` = all PTY tokens rejected (fail-closed)
- Localhost MCP/event endpoints require valid `X-MCP-Secret` (no fail-open)

Key files:
- `sandbox/internal/broker/` — Broker implementation
- `sandbox/cmd/server/env.go` — Env setup with session-scoped broker config
- `controlplane/src/secrets/` — Secrets API + encryption
- `controlplane/src/auth/pty-token.ts` — PTY token creation/verification (fail-closed)
- `frontend/src/components/blocks/TerminalBlock.tsx` — Secrets UI

## OAuth Integrations (Gmail/Drive/GitHub/Calendar)
- Control plane provides connect + callback endpoints:
  - `/integrations/google/drive/connect` + `/callback`
  - `/integrations/google/gmail/connect` + `/callback`
  - `/integrations/google/calendar/connect` + `/callback`
  - `/integrations/github/connect` + `/callback`
- Required env vars on Cloudflare:
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
  - `OAUTH_REDIRECT_BASE` (optional; defaults to request origin)
- D1 tables: `oauth_states`, `user_integrations`, `terminal_integrations`, `integration_policies`

## Integration Policy Enforcement (Security-Critical)

Orcabot uses a **component integration gate** model: on the dashboard canvas, users draw edges
from terminal blocks to integration blocks (Gmail, GitHub, Drive, Calendar). Only attached
integrations are visible as MCP tools to the LLM in that terminal. Each attachment has a policy
that controls what actions are allowed and what data the LLM can see.

### Security Invariants (non-negotiable)
1. **No tool without edge** — MCP only exposes tools for integrations attached to the terminal
2. **No policy from request** — Policy is loaded from `active_policy_id` in DB, never from the sandbox
3. **Boolean enforcement** — `enforcePolicy()` uses only if/else logic, no LLM judgment
4. **OAuth tokens stay in control plane** — Never sent to sandbox; API calls made server-side
5. **Fail-closed** — Missing policy, expired token, or unknown action = deny
6. **Audit before response** — Every request logged before response is returned
7. **Filtered responses only** — LLM never sees raw API data; responses are filtered + formatted

### Request Flow
```
LLM (in sandbox PTY)
  → calls gmail_search via MCP
  → mcp-bridge forwards to sandbox MCP server (HTTP)
  → sandbox calls control plane gateway: POST /internal/gateway/gmail/execute
    (sends PTY token for auth, action + args only — no OAuth token)
  → control plane:
    1. Verify PTY token (HMAC-SHA256 JWT → terminal_id, dashboard_id, user_id)
    2. Load terminal_integration + active_policy from DB
    3. Check rate limits
    4. enforcePolicy() — boolean logic
    5. Get OAuth access token (refresh if expired)
    6. Call Gmail/GitHub/Drive/Calendar API
    7. Filter response based on policy (sender allowlist, repo filter, etc.)
    8. Format response for LLM (decode base64, strip HTML, extract headers)
    9. Log audit entry
    10. Return filtered response
  → sandbox wraps in MCP content format
  → mcp-bridge returns to LLM
```

### Key Files
- `controlplane/src/integration-policies/gateway.ts` — Gateway execute endpoint + PTY token verification
- `controlplane/src/integration-policies/handler.ts` — Attach/detach integrations, policy CRUD
- `controlplane/src/integration-policies/response-filter.ts` — Policy-based response filtering
- `controlplane/src/integration-policies/api-clients/` — Gmail, GitHub, Drive, Calendar API wrappers
- `controlplane/src/auth/pty-token.ts` — PTY token creation/verification
- `sandbox/cmd/mcp-bridge/main.go` — stdio-to-HTTP bridge with tool change notifications
- `sandbox/cmd/server/mcp.go` — MCP server with integration tool handling
- `sandbox/internal/mcp/integration_tools.go` — Tool definitions for all providers
- `sandbox/internal/mcp/gateway_client.go` — Client for control plane gateway calls

### Agent Hooks
When an LLM agent (Claude, Gemini, etc.) finishes a turn, stop hooks notify the
sandbox so it can broadcast `agent_stopped` WebSocket events to all connected clients.
- Hook scripts: `sandbox/internal/agenthooks/hooks.go`
- Supported agents: Claude Code, Gemini CLI, OpenCode, Codex, Droid, OpenClaw
- Settings files generated per-agent (`.claude/settings.json`, `.gemini/settings.json`, etc.)
- **All hooks must include `X-MCP-Secret` header** from `ORCABOT_MCP_SECRET` env var — unauthenticated hook callbacks are rejected

## Key Subsystems

### Sandbox Behavior
- Each dashboard gets its own dedicated VM (one sandbox per dashboard)
- Each terminal creates its own **session** in the control plane (one session per terminal item)
- All terminal sessions in a dashboard share the same sandbox VM; each session maps to a PTY inside that VM
- Sandbox sessions use a shared `/workspace` by default
- PTY cwd is set to the session workspace
- Multiple PTYs per sandbox with turn-taking

### Browser Block
- Browser block checks embeddability via control plane `/embed-check`
- If embedding is blocked, UI collapses to a small "open in new tab" panel

### TTS (Text-to-Speech)
- Sandbox-side talkito handles TTS via brokered API calls
- Frontend shows TTS status via WebSocket events
- Supports OpenAI, ElevenLabs, Deepgram, Google providers

### Subagents
- Saved subagents persist per user in control plane
- Catalog lives in `frontend/src/data/claude-subagents.json`

### Workspace Sidebar
- File tree is populated via control plane proxy of sandbox filesystem APIs
