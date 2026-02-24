# CLAUDE.md

## Purpose

This repository implements the **control plane** for a terminal-first, multiplayer agentic coding platform.

It is responsible for:
- user authentication
- multiplayer dashboards (Google Docs–style)
- durable state and orchestration
- session and sandbox lifecycle coordination
- schedules, recipes, and agent workflows
- secrets storage and encryption
- domain approval workflow for custom secrets
- integration policy enforcement (Gmail, GitHub, Drive, Calendar)
- OAuth token management (tokens never leave control plane)
- PTY token issuance for terminal-level gateway auth

It does **not** run terminals, PTYs, shells, or agents.

Claude should act as a **systems-oriented product + orchestration assistant**, helping to build:
- durable coordination logic
- clear APIs to execution sandboxes
- safe, inspectable autonomy

Claude should **not** introduce execution logic, PTYs, Docker, or Fly Machine internals into this repo.

---

## Related Repos

  Backend sandbox reference: ../sandbox
  - See CLAUDE.md for architecture
  - See api/openapi.yaml for API contract (also copied here in api/)

## High-level product model

- **Dashboards are documents** (multiplayer, persistent)
- **Sandboxes are workers** (ephemeral, disposable; one per dashboard)
- **Sessions are per-terminal** (one session per terminal item; each session maps to a PTY inside the dashboard sandbox)
- **Execution is external** (Fly Machines)
- **Orchestration is durable** (Postgres-backed)
- **Humans and agents collaborate** through explicit state, not hidden processes

---

## System architecture overview

### Layers

Browser
├── Dashboard UI
├── Notes / todos / layout
├── Recipes & schedules
└── Terminal attachments (via sandbox URLs)
↓
Cloudflare (this repo)
├── Auth & access control
├── Durable Objects (live collaboration)
├── Orchestrator (workflows, recipes, schedules)
├── Session coordinator
├── Secrets management (encrypted storage)
├── Integration policy gateway (Gmail, GitHub, Drive, Calendar)
├── OAuth token management (tokens never leave this layer)
├── PTY token issuance (HMAC-SHA256 JWT per terminal)
└── D1 database (durable state)
↓
Fly.io (execution plane – separate repo)
└── Sandbox (Go server)
    ├── PTYs
    ├── Claude Code / Codex CLI
    ├── Secrets broker
    ├── Filesystem
    └── Reports results back

---

## Responsibility boundaries (non-negotiable)

### This repo (Cloudflare) owns **intent & coordination**
- Dashboards and multiplayer state
- Notes, todos, links, layouts
- Recipes / workflows / templates
- Agent profiles and sub-agent definitions
- Scheduling (cron / event-based)
- Session creation & teardown
- Mapping dashboards → sandbox sessions
- Durable orchestration state
- Secrets storage and encryption
- Domain approval workflow for custom secrets
- **Integration policy enforcement** (gateway execute, rate limits, audit)
- **OAuth token lifecycle** (connect, refresh, encrypt at rest)
- **PTY token issuance** (HMAC-SHA256 JWT for terminal-level auth — **fail-closed**: empty `INTERNAL_API_TOKEN` rejects all tokens)
- **Response filtering** (policy-based filtering before LLM sees data)
- **API execution** (Gmail, GitHub, Drive, Calendar calls — tokens stay here)

### This repo does NOT own
- PTYs
- Shells
- Agents as running processes
- Filesystem access
- Execution state
- Docker / VM lifecycle details

Execution is delegated.

---

## Durable Objects usage

Durable Objects are used for:
- real-time collaboration
- presence
- conflict-free UI state
- live coordination (who is viewing what)

They are **not** a database.

Rules:
- DOs hold small, hot state
- Postgres is the source of truth
- DO state can be rebuilt from Postgres at any time

---

## Persistence model

### Stored in D1
- Users
- Dashboards
- Dashboard items (notes, todos, layout)
- Dashboard membership & permissions
- Recipes / workflows
- Workflow execution state
- Agent profiles / templates
- Schedules
- Integration credentials (encrypted) — `user_integrations`
- Terminal-integration attachments — `terminal_integrations`
- Integration policies — `integration_policies`
- Session metadata (start/end, region, status)
- Artifacts & summaries
- User secrets (encrypted)
- Secret domain allowlists

### Not stored here
- PTY buffers
- Shell history
- Running process state
- Live agent execution

---

## Secrets Management

The control plane stores and manages all user secrets with encryption at rest.

### Database Tables
- `user_secrets` — Encrypted secrets with broker_protected flag
- `user_secret_allowlist` — Approved domains for custom secrets
- `pending_domain_approvals` — Pending approval requests from sandbox

### Key APIs
**File:** `src/secrets/handler.ts`

CRUD:
- `listSecrets(userId, dashboardId, type?)` — List with type filtering
- `createSecret(userId, data)` — Create + auto-apply to sessions
- `deleteSecret(userId, id)` — Delete + auto-apply (remove from sessions)
- `updateSecretProtection(userId, secretId, brokerProtected)` — Toggle protection

Approvals:
- `listPendingApprovals(userId, dashboardId)` — Get pending requests
- `approveSecretDomain(userId, secretId, data)` — Approve with header config
- `dismissPendingApproval(userId, approvalId)` — Deny request

### Internal Endpoints (sandbox → controlplane)
These are called by the sandbox broker when a custom secret hits an unapproved domain:

```bash
# Create a pending approval request (called by sandbox)
curl -X POST "http://localhost:8787/internal/sessions/{sessionId}/approval-request" \
  -H "Content-Type: application/json" \
  -H "X-Internal-Token: $INTERNAL_API_TOKEN" \
  -d '{"secretName": "MY_API_KEY", "domain": "api.example.com"}'

# Response: {"status": "pending", "id": "..."}

# Get approved domains for a session (called by sandbox on startup)
curl "http://localhost:8787/internal/sessions/{sessionId}/approved-domains" \
  -H "X-Internal-Token: $INTERNAL_API_TOKEN"

# Response: {"approvedDomains": [{"secretName": "MY_API_KEY", "domain": "api.example.com", "headerName": "Authorization", "headerFormat": "Bearer %s"}]}
```

### Auto-Apply Mechanism
When secrets change, `autoApplySecretsToSessions()` pushes updates to all active sandbox sessions for that dashboard via the sandbox's `updateEnv()` endpoint.

### Encryption
- Secrets encrypted at rest using configured encryption key
- Supports legacy plaintext migration
- Decryption only on read for sandbox delivery

---

## Network Egress Control

The control plane manages user approval decisions and persistent allowlists for the sandbox egress proxy.

### Database Tables
- `egress_allowlist` — Per-dashboard user-approved domains (domain, created_by, revoked_at)
- `egress_audit_log` — All egress decisions (domain, port, decision, decided_by)

### User-Facing Endpoints (authenticated)
- `POST /api/dashboards/:id/egress/approve` — User decision (allow_once/always/deny) → forward to sandbox
- `GET /api/dashboards/:id/egress/allowlist` — List user-approved domains
- `DELETE /api/dashboards/:id/egress/allowlist/:entryId` — Revoke a user-approved domain
- `GET /api/dashboards/:id/egress/pending` — List currently held connections

### Internal Endpoints (sandbox → controlplane)
- `GET /internal/dashboards/:id/egress/allowlist` — Sandbox loads persisted allowlist on startup
- `POST /internal/dashboards/:id/egress/audit` — Sandbox forwards runtime audit events

### Key Files
- `src/egress/handler.ts` — Allowlist CRUD, approval flow, audit logging

---

## Integration Policy Enforcement

The control plane is the **sole enforcement point** for integration policies. The sandbox
never has OAuth tokens — it sends requests to the control plane gateway, which verifies
auth, enforces policy, makes the API call, filters the response, and returns clean data.

### Architecture

```
Sandbox MCP Server
  → POST /internal/gateway/:provider/execute
  → Headers: Authorization: Bearer <pty_token>
  → Body: { action: "gmail.search", args: { query: "..." } }
```

### Key Files
- `src/integration-policies/gateway.ts` — Gateway execute endpoint, PTY token verification, response formatting
- `src/integration-policies/handler.ts` — CRUD for terminal integrations + policies, `enforcePolicy()`
- `src/integration-policies/response-filter.ts` — Policy-based response filtering (sender allowlist, repo filter, etc.)
- `src/integration-policies/api-clients/` — Gmail, GitHub, Drive, Calendar API wrappers
- `src/auth/pty-token.ts` — HMAC-SHA256 JWT token creation/verification

### Database Tables
- `user_integrations` — OAuth tokens (encrypted), provider, account email
- `terminal_integrations` — Which integrations are attached to which terminals
- `integration_policies` — Policy definitions (per-provider rules)

### Security Invariants
1. **OAuth tokens never leave control plane** — API calls are made here, not in sandbox
2. **Policy loaded from DB** — `active_policy_id` on `terminal_integrations`, never from request
3. **Boolean enforcement** — `enforcePolicy()` uses if/else logic only, no LLM judgment
4. **Fail-closed** — Missing policy, expired token, unknown action → deny
5. **Audit before response** — Every request logged via `logAuditEntry()` before returning
6. **Context derived server-side** — Recipient, domain, etc. extracted from args in control plane

### Providers
- **Gmail**: search, get, send, archive, trash, mark_read/unread, add/remove_label
- **GitHub**: list_repos, search_repos, search_code, get_file, list_issues, create_issue, list_prs
- **Google Drive**: list, search, get_metadata, download, create, update
- **Google Calendar**: list_calendars, list_events, get_event, create_event, update_event, delete_event

---

## ASR (Automatic Speech Recognition)

The control plane manages ASR API keys and provides token vending / proxy endpoints for speech-to-text.

### Providers
- **AssemblyAI** — Token vending (temporary token, 1h TTL)
- **OpenAI Whisper** — HTTP proxy (multipart audio forwarded server-side, 25MB limit)
- **Deepgram** — Token vending (JWT, 30s TTL) + REST transcription fallback + WebSocket streaming via Durable Object

### Endpoints
- `GET /asr/keys` — List configured providers (no values)
- `POST /asr/keys` — Upsert API key (stored encrypted in `user_secrets` at `_global` scope)
- `DELETE /asr/keys/:provider` — Remove key
- `POST /asr/assemblyai/token` — Exchange key for temporary token
- `POST /asr/deepgram/token` — Exchange key for JWT
- `POST /asr/openai/transcribe` — Proxy audio to Whisper API
- `POST /asr/deepgram/transcribe` — Proxy audio to Deepgram Nova v2

### ASRStreamProxy (Durable Object)
WebSocket relay between browser and Deepgram for real-time streaming. API key injected server-side via `X-ASR-Api-Key` header — never reaches the browser.

### Key Files
- `src/asr/handler.ts` — Endpoints, key management, proxy logic
- `src/asr/ASRStreamProxy.ts` — Durable Object WebSocket relay

---

## Analytics & Metrics

First-party analytics with client-side event ingestion and admin metrics.

### Endpoints
- `POST /analytics/events` — Batch ingest (max 50 events), verifies user has dashboard access
- `GET /admin/metrics` — Admin-only: DAU/WAU/MAU, signups by day, active dashboards, session breakdown by agent type, block type distribution, integration adoption, top 20 users, 7-day retention

### Database
- `analytics_events` table: `(id, user_id, dashboard_id, event_name, properties JSON, created_at)`
- `users.last_active_at` column: throttled write (only if NULL or >5min old)

### Server-Side Events
- `logServerEvent()` — Fire-and-forget internal logging
- `detectAgentType()` — Parses boot command to identify agent (claude, gemini, codex, etc.)

### Key Files
- `src/analytics/handler.ts` — All endpoints + metrics queries

---

## Messaging Integrations (Inbound Webhooks)

Multi-platform inbound message handling for messaging integrations (Slack, Discord, WhatsApp, Telegram, Teams, Matrix, Google Chat).

### Webhook Flow
1. Verify platform-specific signature (HMAC-SHA256, Ed25519, token header, or shared secret)
2. Parse + normalize message to `NormalizedMessage` format
3. Deduplicate via unique index on `(subscription_id, platform_message_id)`
4. Load subscription + policy from DB
5. Enforce inbound policy: channel filter (allowlist), sender filter (allowlist/blocklist), `repliesOnly`
6. Buffer in `inbound_messages` table
7. Broadcast to frontend via Durable Object (`inbound_message` event)
8. Attempt delivery to terminal or wake VM

### Database Tables
- `messaging_subscriptions` — Channel binding (dashboard_id, item_id, provider, channel_id, webhook_secret, etc.)
- `inbound_messages` — Buffered messages (subscription_id, sender, channel, text, metadata, status, expires_at)

### Key Files
- `src/messaging/webhook-handler.ts` — Signature verification, parsing, policy enforcement, subscription CRUD

---

## Orchestration model

This repo implements a **durable orchestrator**.

Concepts:
- **Recipe**: declarative workflow definition
- **Step**: unit of work (run agent, wait, branch, notify)
- **Agent profile**: tools + prompt + policy template
- **Execution**: a specific run of a recipe
- **Artifact**: output produced by execution
- **Schedule**: time/event trigger for execution

The orchestrator:
- persists workflow state
- launches sandboxes when needed
- resumes after failure
- retries deterministically
- allows human intervention at any step

Think: **Beads / Temporal-like, domain-specific**.

---

## Session & sandbox lifecycle

- **Each dashboard gets its own dedicated VM** (one sandbox per dashboard)
- **Each terminal creates its own session** (one session per terminal item; sessions map to PTYs inside the dashboard sandbox)
- Dashboards may exist with **zero sandboxes** (VM spun up on first terminal)
- A sandbox is created only when:
  - a terminal is opened
  - a recipe step requires execution
- Each sandbox = one Fly Machine
- Sandboxes are disposable
- Recovery = recreate sandbox + continue workflow

This repo **never assumes a sandbox is alive**.

---

## Schedules & autonomy

- Schedules are durable (cron / events)
- When triggered:
  - orchestrator advances workflow
  - sandbox is launched if needed
  - results are persisted
- Humans may:
  - observe
  - pause
  - modify
  - resume

Autonomy is **inspectable and interruptible**.

---

## API philosophy

This repo exposes APIs for:
- dashboards
- recipes
- schedules
- sessions
- integrations
- secrets

It does NOT expose:
- PTY APIs
- shell commands
- filesystem operations

Those belong to the sandbox repo.

---

## What Claude should NOT do in this repo

- Do not add PTY logic
- Do not run agents here
- Do not talk directly to sandboxes except via defined APIs
- Do not persist execution state
- Do not bypass Postgres with Durable Object state
- Do not introduce long-running computation in Workers

If a feature requires execution, delegate it.

---

## Guiding principle

> **This layer decides *what should happen* and *when* — never *how it executes*.**

If you're unsure whether something belongs here or in the sandbox:
- If it's durable, declarative, or collaborative → here
- If it's procedural, interactive, or process-bound → sandbox

---

## Mental model

- Dashboards = shared documents
- Recipes = durable plans
- Sandboxes = disposable workers
- Agents = roles, not processes

---

## Success criteria

This repo is correct if:
- Dashboards survive restarts
- Workflows resume after failure
- Sandboxes can be killed at any time without data loss
- Humans can understand and intervene
- Execution remains isolated and replaceable
