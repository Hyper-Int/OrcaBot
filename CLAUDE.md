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

1. **Secrets Broker** - API keys are NOT set as env vars. Instead, a session-local broker injects keys server-side. LLMs only see placeholder values.

2. **Output Redaction** - Any secret values in PTY output are replaced with asterisks before reaching WebSocket clients.

3. **Domain Allowlisting** - Built-in providers (Anthropic, OpenAI, ElevenLabs, etc.) have hardcoded target domains. Custom secrets require owner approval per-domain.

Key files:
- `sandbox/internal/broker/` — Broker implementation
- `controlplane/src/secrets/` — Secrets API + encryption
- `frontend/src/components/blocks/TerminalBlock.tsx` — Secrets UI

## OAuth Integrations (Drive/GitHub)
- Control plane provides connect + callback endpoints:
  - `/integrations/google/drive/connect`
  - `/integrations/google/drive/callback`
  - `/integrations/github/connect`
  - `/integrations/github/callback`
- Required env vars on Cloudflare:
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
  - `OAUTH_REDIRECT_BASE` (optional; defaults to request origin)
- D1 tables: `oauth_states`, `user_integrations` (run `/init-db` after schema updates)

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
