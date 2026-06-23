# PLAN: Custom / Self-Hosted Model Endpoints (Ollama, vLLM, cloud BYO)

Status: Draft / design
Author: (orcabot)
Related: `frontend/src/data/openrouter-models.json`, `sandbox/internal/geminishim/`,
`sandbox/internal/sessions/model_selection.go`, `PLAN-custom-secret-approval.md`,
`PLAN-threat-detection.md`

## 1. Summary

Let users point any terminal at a **custom OpenAI-compatible model endpoint** — a local Ollama /
LM Studio / llama.cpp / vLLM, or a self-hosted box on AWS / Together / Fireworks / Bedrock-via-gateway.
Surface it as a "Custom endpoint" option in the Model panel, route it through the secrets broker
(so any key is protected and egress is controlled), and make it work across **all harnesses**
(Claude / Codex / OpenCode / Droid / Gemini) by **generalizing the existing `geminishim` into a
universal translation gateway**.

Key decisions:
- **Default format = OpenAI-compatible chat completions** — the lingua franca of self-hosted
  servers. Anthropic-compatible is an optional second format.
- **Reuse the broker** custom-provider/custom-secret machinery for key injection + egress.
- **One universal gateway** (the generalized shim) presents each harness its native wire format
  and translates to chat-completions for the endpoint — this is the whole unlock, and it also
  fixes Codex (which now requires the Responses API that self-hosted servers don't implement).

## 2. Goals / Non-goals

**Goals**
- "Custom endpoint" in the Model panel: base URL + format + model + optional key + ctx/output limits.
- Works for all harnesses against a plain OpenAI-compatible endpoint.
- Desktop: auto-detect a local Ollama / LM Studio and wire the host-gateway address.
- Cloud: user-provided URL, key protected by broker, endpoint domain allowed in egress.
- Reusable per-user saved endpoints, selectable per terminal.

**Non-goals**
- Not shipping/curating local models — the user runs the server.
- Not guaranteeing tool-calling/streaming quality on small local models (flag "experimental").
- Not a generic reverse proxy for arbitrary protocols — OpenAI-compatible (+ optional Anthropic).

## 3. Current state (what we build on)

- **Model selection** (`model_selection.go`): `ModelSelection{Provider, Model, ContextWindow,
  MaxOutputTokens}`. `applyOpenRouterEnv` wires per-harness env / CLI flags; OpenRouter routes
  through the broker (`openrouter` / `openrouter-anthropic`). Limits flow FE→CP→sandbox.
- **Translation proxy already exists** (`geminishim/`): accepts Gemini `generateContent`,
  translates to OpenAI chat completions, forwards through the broker. This is ~80% of the
  universal gateway — it already does format translation, SSE streaming, tool-call mapping,
  schema sanitization, and broker forwarding.
- **Broker custom secrets** (`secrets_broker.go`): `/broker/{sid}/custom/{secretName}?target=...`
  with per-domain approval (`PLAN-custom-secret-approval.md`). The mechanism for "inject a key
  for an arbitrary user-provided URL" already exists.
- **Catalog UI** (`TerminalBlock.tsx` Model panel, `openrouter-models.json`): curated list +
  `compatibleHarnesses` filtering + key-missing warnings.
- **Passthrough** (`controlplane/src/sessions/handler.ts`, `sandbox/client.ts`,
  `cmd/server/main.go`): `model_selection` provider/model + `contextWindow`/`maxOutputTokens`.

## 4. The universal model gateway (generalize `geminishim`)

Rename/extend `geminishim` → `modelgateway` (or keep the package, add formats). One localhost
server per VM that **accepts a harness's native format and emits OpenAI chat-completions** to a
configurable target (broker → custom endpoint, or broker → OpenRouter).

Front-side translators (harness → chat-completions):
- **Gemini** `generateContent` / `streamGenerateContent` — **exists**.
- **Anthropic** `/v1/messages` — **new** (same shape as the Gemini translator; needed for Claude).
- **OpenAI Responses** `/responses` — **new** (needed for Codex, which rejects `wire_api=chat`).
- **OpenAI chat** `/chat/completions` — trivial pass-through (or skip the gateway entirely, below).

Back-side: always POST chat-completions to the **broker custom-provider URL**, which injects the
key (if any) and forwards to the user's endpoint. (Optionally a future Anthropic/Ollama-native
back-side if a target needs it; OpenAI-chat covers Ollama/vLLM/etc.)

The URL carries routing context, as the shim already does:
`http://127.0.0.1:<gw>/cg/<sessionID>/<providerRef>/<base64(model)>/…`

### Per-harness routing table (custom OpenAI-compatible endpoint)

| Harness        | How it's pointed at the endpoint                                  | Gateway needed?               |
|----------------|-------------------------------------------------------------------|-------------------------------|
| OpenCode/Droid | `OPENAI_BASE_URL` = broker custom-provider URL, `OPENAI_MODEL`     | No — native chat-completions  |
| Codex          | `-c` flags: `base_url` = gateway, `wire_api="responses"`           | **Yes** — Responses→chat      |
| Claude         | `ANTHROPIC_BASE_URL` = gateway; placeholder `ANTHROPIC_API_KEY`    | **Yes** — Anthropic→chat      |
| Gemini         | `GOOGLE_GEMINI_BASE_URL` = gateway (existing path)                 | **Yes** — Gemini→chat (exists)|

OpenAI-native harnesses skip the gateway and hit the broker directly (least overhead). Everything
else goes through the gateway. Mirrors the existing `applyOpenRouterEnv` switch — add a
`provider == "custom"` branch alongside the OpenRouter one.

## 5. Broker integration

Add a **custom model provider** to the broker, generalizing the custom-secret flow:
- Per-session config: `{ targetBaseURL, secretName?, headerName, headerFormat }`, installed when a
  terminal with a custom endpoint is created (alongside the existing broker config push).
- Route: `/broker/{sid}/customprovider/{providerRef}/...` → forwards to `targetBaseURL + path`,
  injecting `Authorization: Bearer <key>` from the referenced user secret (or nothing for no-auth
  local servers). Strips inbound auth (same as today).
- Egress: the endpoint domain is **auto-approved** for the session (the user configured it) but
  tagged a **data sink** for `PLAN-threat-detection.md`. No-auth localhost endpoints bypass.

Key protection: the harness only ever sees the gateway/broker localhost URL + a placeholder key;
the real key (if any) is injected server-side. Same guarantee as OpenRouter today.

## 6. Data model & persistence

New per-user table (reusable saved endpoints, like saved subagents):

```
user_model_providers(
  id, user_id, label,
  base_url,                 -- e.g. http://host.docker.internal:11434/v1  or  https://my-llm.aws…/v1
  format,                   -- 'openai' | 'anthropic'   (default openai)
  model_id,                 -- e.g. 'llama3.3:70b', 'qwen2.5-coder:32b'
  secret_name,              -- nullable; ref to user_secrets for the API key
  context_window,           -- manual (no catalog)
  max_output_tokens,        -- manual
  compatible_harnesses,     -- JSON array
  is_local,                 -- hint: localhost/host-gateway vs public URL
  created_at
)
```

`ModelSelection` gains `provider: 'custom'` + `customProviderId` (and the resolved
`baseUrl`/`format`/`model`/`contextWindow`/`maxOutputTokens`/`secretName` round-tripped
FE→CP→sandbox, same path as the OpenRouter limits).

## 7. UI (Model panel)

A "Custom endpoint" section below Default/OpenRouter:
- List of saved custom providers (per-user), each with label + model + a "local"/"remote" tag.
- "+ Add custom endpoint" form: **label, base URL, format** (OpenAI default), **model id**,
  **API key** (optional; stored as a brokered secret), **context window**, **max output tokens**,
  **compatible harnesses**.
- Same key-missing/validation affordances as the OpenRouter section, but scoped to the panel
  (per the earlier fix — no badges leaking to the top-level menu).
- For **remote** custom endpoints, a clear inline note: *"This endpoint receives the full
  conversation context — only use providers you trust."* (security, §9).

## 8. Desktop vs cloud

**Desktop (Tauri, local VM sandbox)**
- The user's Ollama/LM Studio runs on the **host**, not the sandbox. The Tauri layer
  (`desktop/app/src-tauri`) should:
  - **Auto-detect**: probe `http://localhost:11434/api/tags` (Ollama) and
    `http://localhost:1234/v1/models` (LM Studio) on the host; offer found models in the panel.
    For Ollama, **auto-fill the context window** from `/api/show` (`model_info`) so the user
    doesn't have to guess; manual field with a default elsewhere.
  - **Bridge networking**: inject the host-gateway address the sandbox can reach (e.g.
    `host.docker.internal` on Docker Desktop, or the VM gateway IP) so a saved `base_url` of
    `localhost:11434` is rewritten to the reachable host address for the sandbox.
- No key, no public exposure, no egress concern (host-local). Best UX: "Found Ollama — pick a model."

**Cloud (Fly sandbox)**
- Endpoint must be reachable by URL (their AWS box, a tunnel like Cloudflare/ngrok, or a managed
  BYO provider). Key held by broker; endpoint domain auto-allowed in egress (tagged data sink).
- Surface the "receives full context" warning prominently here.

## 9. Security considerations
- **A custom endpoint receives the entire prompt context** — it is a user-authorized, full-data
  egress channel. This is fine (it's their model) but must be explicit in the UI, and the endpoint
  domain is a **data sink** for trifecta detection (`PLAN-threat-detection.md`) — a custom endpoint
  is a *sanctioned* exfil-shaped channel, not a trusted one. Don't auto-suppress anomaly signals to it.
- **Key protection** stays intact (broker injection); the LLM/harness never sees the real key.
- **Egress** still applies: cloud endpoints are allowed because the user configured them, not
  because they're safe. No-auth localhost (desktop host-gateway) bypasses egress like other loopback.
- **No SSRF surprise**: the broker validates the target host against the configured custom-provider
  base URL (same host-match guard the broker already enforces for built-in providers).

## 10. Capability / limitations (be honest in UI)
- **Codex** requires the Responses API surface — only works via the gateway's Responses→chat
  translator; some advanced Codex features may degrade against a vanilla chat endpoint.
- **Tool/function-calling + streaming** vary widely across self-hosted servers and small models;
  tag custom endpoints "experimental." Schema sanitization (already in the shim) helps.
- **Context window / max output** are user-supplied (no catalog) — wrong values degrade
  compaction; show sensible defaults per known server where possible.
- **Anthropic-format self-hosted servers are rare** — OpenAI-compatible is the real target.

## 11. Phasing (status)

1. **Universal gateway** — DONE. Generalized `geminishim`: `forwardChat(sessionID, provider, …)`
   parameterizes the broker target; added Anthropic→chat (`anthropic.go`, `/av1`) and made the
   Gemini `/gv1` path carry the provider. Responses→chat (Codex) still TODO.
2. **Broker custom-provider** — DONE (folded into 3). The broker's built-in forwarding handles
   `/broker/{sid}/customprovider/...` generically (target from config, SSRF host-match);
   `GetCustomSecretValue` resolves the key; no-auth guard skips the auth header when keyless.
3. **Data model + Model-panel UI** — DONE. `user_model_providers` table + CRUD; `ModelSelection`
   `provider:'custom'` end-to-end (FE→CP→sandbox); Model-panel "Custom endpoint" section with
   add-form (raw key auto-stored as a brokered secret) + full-context warning; `applyCustomEndpointEnv`
   wires OpenCode/Droid (direct) + Claude (`/av1`) + Gemini (`/gv1`).
4. **Desktop** — CORE DONE (testable): broker http-allowance for custom endpoints (gated on
   `ALLOW_HTTP_CUSTOM_ENDPOINT`, SSRF host-match preserved) + `rewriteCustomBaseURLForDesktop`
   (localhost → VM host gateway `10.0.2.2`, overridable via `ORCABOT_HOST_GATEWAY`). So a manually
   added `http://localhost:11434/v1` routes to the host's Ollama on desktop.
   REMAINING (needs the desktop env to test): the Tauri Ollama/LM Studio **auto-detect** UX (a
   `detect_local_models` command + frontend pre-fill) — a convenience on top, not a blocker.
   CAVEAT: only the QEMU/slirp VM backend has guest→host networking; the macOS native-VZ backend
   does **not** (see `vm/macos.rs`), so local endpoints won't reach the host there.
5. **Threat-detection integration** — BLOCKED on the threat-detection system itself
   (`PLAN-threat-detection.md`), which is unbuilt. Note: brokered traffic bypasses egress (the
   broker runs in the server process), so a custom endpoint never hits the egress allowlist — its
   "data sink" nature only matters to the future threat-detection correlation. The user-facing
   "this endpoint receives the full conversation context" warning is already in place. No code to
   write here until threat-detection exists.

Remaining work: Codex `Responses→chat` (Phase 1 follow-up) and the Tauri auto-detect UX (Phase 4).

## 12. Resolved decisions (v1)
1. **Scope: per-user** — saved endpoints belong to the user (same model as env vars / secrets),
   reusable across dashboards. Team sharing deferred.
2. **Explicit selection only** — a custom endpoint does NOT override the harness's "Default"
   model; it appears as an explicit pick. (A custom *default* model is a later add-on.)
3. **Desktop auto-detect = Ollama + LM Studio only** (`:11434` / `:1234`), plus manual add-by-URL
   for anything else. No configurable probe list in v1.
4. **Cloud = require a reachable URL** (user's own box/tunnel). No bundled tunnel helper in v1.
5. **Auto-fill context window from Ollama** when detected (via its `model_info`/`/api/show`);
   manual field with a sensible default elsewhere.

## 13. Bottom line
The `geminishim` we built for Gemini→OpenRouter is the same machine we need here — generalizing
it to a universal translation gateway gives every harness access to any OpenAI-compatible endpoint,
local or self-hosted, with the broker preserving key protection and egress control. Desktop gets a
zero-config "we found your Ollama" path; cloud gets BYO-endpoint with an honest "this sees all your
context" warning. The main new engineering is the Anthropic→chat and Responses→chat translators
(Codex/Claude) and the per-user custom-provider plumbing.
