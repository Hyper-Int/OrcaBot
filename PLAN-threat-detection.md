# PLAN: Threat Detection (egress anomaly + inbound injection + trifecta correlation)

Status: Draft / design
Author: (orcabot)
Related: `EGRESS_HARDENING.md`, `PLAN-secrets-protection.md`, `PLAN-integration-policy-enforcement.md`

## 1. Summary & framing

OrcaBot's current defenses (egress allowlist, secrets broker, integration-policy gateway)
**prevent** the obvious and **fail-closed on the unknown**, but they cannot prevent a
determined exfiltration through *allowed* channels, and they don't detect prompt-injection
attacks arriving via inbound messages. This plan adds a **detection + notification + adaptive
response** layer — explicitly *not* prevention.

The model is a fraud-detection desk, not a firewall: we can't stop every attack, but we can
catch a meaningful class, **tell the user and the admin it's happening**, and **automatically
tighten the blast radius** when it does. The highest-value signal is the **lethal trifecta**
lining up in one session: untrusted input ingested **+** access to private/sensitive data **+**
an outbound exfiltration attempt.

Three components, each independently useful, strongest when joined:

1. **Egress anomaly detection** — "shapes in the network": volume/rate/fan-out/provenance.
2. **Inbound prompt-injection scanner** — scan untrusted content before it reaches the LLM.
3. **Provenance / trifecta correlation** — join #1 and #2 into a per-session risk verdict.

## 2. Goals / Non-goals

**Goals**
- Detect bulk and patterned exfiltration to *allowed* domains and surface it to user + admin.
- Detect likely prompt-injection in inbound messages/emails before delivery to the agent.
- Give the admin a feedback loop: observability + the ability to tighten a channel/session.
- Auto-downgrade blast radius on high-confidence detection (held-approval, pause, repliesOnly).
- Reuse existing pipelines (egress audit, messaging webhook, WS→toast) — minimal new surface.

**Non-goals / explicit non-guarantees**
- NOT prevention. A competent attacker with prompt-injection can still exfiltrate via
  low-bandwidth side channels (timing/ordering, `allowed.site/0` vs `/1`) — information-theoretically
  invisible to traffic-shape heuristics. We say so in the UI; we do not claim coverage.
- NOT a replacement for the allowlist/broker/policy layers — this is defense-in-depth on top.
- The injection classifier is best-effort and adversaries adapt; false positives are expected.

## 3. Current state (what we build on)

- **Egress proxy** (`sandbox/internal/egress/proxy.go`): per-decision `AuditEvent{domain, port,
  decision}` via `emitAudit` → control plane (`egress_audit_log` in `controlplane/src/egress/handler.ts`).
  `tunnelConnect` already does the bidirectional `io.Copy` where bytes can be counted.
  Gaps today: binary per-domain allow; no bytes/rate/path signal; wildcard sinks
  (`*.sentry.io`, `*.datadoghq.com`, `*.cloudfront.net`, `storage.googleapis.com`) are open.
- **Inbound messaging** (`controlplane/src/messaging/webhook-handler.ts`): verify sig → normalize →
  load subscription+policy → enforce inbound policy (channel/sender/`repliesOnly`) → buffer in
  `inbound_messages` → broadcast via DO + deliver/wake. **No content risk scan today.**
- **Integration gateway** (`controlplane/src/integration-policies/`): `enforcePolicy` (boolean),
  `filterResponse` (repo/sender filtering), per-action rate limits, audit. Email/message bodies
  fetched for the LLM (`gmail.get`, etc.) are *not* injection-scanned.
- **Alert pipeline (reuse)**: broker `model_provider_error` → `broadcastToSessionHubs` →
  `model_provider_error` WS event → `TerminalWSManager` CustomEvent → `dashboards/[id]/page.tsx`
  toast. This is the template for surfacing threat alerts.
- **Admin** (`controlplane/src/analytics/handler.ts`, `GET /admin/metrics`, `frontend .../admin`).

## 4. Architecture overview

```
Inbound (email/SMS/Slack/…)                      Outbound (agent → network)
        │                                                 │
        ▼                                                 ▼
 webhook-handler / gateway read            egress proxy (sandbox)  +  integration gateway
        │  normalize                         │  per-request audit + bytes/rate
        ▼                                     ▼
 [INJECTION SCANNER] ── risk ──┐     [EGRESS AGGREGATOR] ── anomaly ──┐
        │                       │            │                         │
   inbound_messages.risk        └──►  SESSION RISK STATE  ◄────────────┘
        │                              (trifecta correlation)
        ▼                                     │
   quarantine? deliver?                       ▼
        └──────────────►  NOTIFY (user toast + admin)  +  ADAPT (downgrade policy / pause)
```

Session risk state is the join point: a control-plane object keyed by `session_id` /
`dashboard_id` accumulating (a) untrusted-input events, (b) sensitive-data-access events,
(c) outbound-anomaly events. When enough align → escalate.

## 5. Component 1 — Egress anomaly detection

### Captured signals (extend the proxy, cheap, no MITM)
- **Bytes out** per (session, domain): count in `tunnelConnect`'s client→upstream `io.Copy`
  (wrap the copy or use a counting `io.Writer`). Add `BytesOut` to `AuditEvent`.
- **Request/connection rate** per (session, domain): already one audit event per CONNECT/HTTP.
- **Connection cardinality / fan-out**: distinct (domain, port) and distinct CONNECTs per domain
  per window — proxy can't read TLS paths, but high connection cardinality to a wildcard sink is
  itself the signal for the `/0`,`/1` pattern.
- **Sink classification**: tag domains that are data-ingest capable (telemetry: `*.sentry.io`,
  `*.datadoghq.com`; storage: `storage.googleapis.com`, `*.amazonaws.com`; paste/CDN-upload).
  A static list in `defaults.json` (`"category": "data_sink"`) is enough to start.

### Detection (control plane, aggregating `egress_audit_log`)
Rolling per-session counters (Durable Object or D1 window query). Initial heuristics:
- `bytes_out_to_sink_per_session > THRESHOLD` (e.g. 1 MB) → **medium**; > 10 MB → **high**.
- `requests_per_min_to_domain > N` (e.g. 120) → **medium**.
- `distinct_subpaths_or_connections_to_sink > K` in a short window → **medium** (side-channel shape).
- **Provenance multiplier**: any of the above within T seconds of an untrusted-input or
  sensitive-data event (from session risk state) → escalate one level.

### Response
- Emit a `threat_alert` WS event (reuse `broadcastToSessionHubs`) → dashboard toast:
  *"Unusual egress: 4.2 MB sent to telemetry sink `*.sentry.io` in 30s."*
- Write an `threat_events` row (audit) + admin notification.
- **Adapt** (configurable, default on for `high`): flip the session's data-sink domains back to
  held-approval (remove from runtime allowlist via `allowlist` API), and/or pause the agent.

## 6. Component 2 — Inbound prompt-injection scanner

### Hook points (the chokepoints where untrusted content enters)
- `webhook-handler.ts` between **normalize** and **buffer/deliver** (step 5–6) — scan
  `NormalizedMessage.text` for every inbound platform message.
- Integration gateway read responses that return externally-authored content to the LLM
  (`gmail.get/search`, future web fetch) — scan body before `filterResponse` returns it.

### Two-stage classifier (cost/latency-aware)
1. **Cheap pre-filter** (no model call): regex/heuristics — instruction-shaped text in a data
   field ("ignore previous", "system:", "you are now"), tool-name lures, base64/hex blobs over a
   length, suspicious URL shapes, zero-width/unicode obfuscation. Benign messages stop here.
2. **LLM judge** (escalation only): a small fast model (Haiku) scoring injection likelihood +
   category (instruction-override / exfil-request / tool-lure / encoded-payload). Returns
   `{risk: 0–1, category, rationale}`.

### Schema & handling
- Add to `inbound_messages`: `risk_score REAL`, `risk_category TEXT`, `risk_status TEXT`
  (`clear` | `flagged` | `quarantined`).
- `risk >= QUARANTINE_THRESHOLD` → buffer but **do not auto-deliver**; require user confirm in UI.
  Mark the message "⚠ possible injection" in the messaging block + inbound list.
- Below quarantine but flagged → deliver but tag, and record for the channel's running score.

### Adapt
- A channel/sender with repeated flags auto-tightens: drop to `repliesOnly`, read-only, or
  require approval for any tool call within N minutes of a flagged message. Surface to admin to
  confirm/tune. (Adjust-settings-to-reduce-impact, the "bank" move.)

## 7. Component 3 — Provenance / trifecta correlation

A per-session **risk state** (Durable Object keyed by `session_id`) accumulates:
- `untrusted_input` events (inbound message delivered, web/email content fetched).
- `sensitive_access` events (integration gateway returned private data; secret broker used).
- `outbound_anomaly` events (Component 1).

Escalation rule (boolean, no LLM in the loop — auditable): when **all three** classes are present
within a sliding window → **session under likely attack** → strongest response (pause agent,
freeze data-sink egress, alert user + admin with the correlated timeline:
*"message X → read of private data Y → 4 MB to sink Z"*). This is the single most valuable signal
and the cleanest story to show a user.

## 8. Cross-cutting

### Notifications
- **User**: `threat_alert` WS event → toast (reuse Component built for `model_provider_error`),
  severity-styled, with the timeline and the action taken ("egress to sinks paused").
- **Admin**: new `threat_events` feed on the admin page; optional email (Resend) for `high`.

### Admin dashboard (extend `/admin/metrics` + page)
- Threat events over time, by channel/provider/severity; top flagged senders/channels;
  quarantine queue; per-dashboard "tightened" state.

### Policy auto-adaptation
- All adaptations are reversible and logged; admin can pin a channel to a tighter policy or
  whitelist a false-positive sender. Defaults: alert-only for `low/medium`, auto-act on `high`.

## 9. (Bonus, from #3) Route raw `git` through the policy gateway

Today `git push` over HTTPS bypasses the integration gateway (only the GitHub MCP *tools* get
`enforcePolicy` capability gates, `repoFilter` response filtering, rate limits, audit). Optional
hardening: proxy git operations (or the agent's git credential helper) through the gateway so raw
pushes inherit `canPush`/repo-allowlist/rate-limit/audit. Larger lift; tracked here, not phase 1.

## 10. Data model (D1)

```
threat_events(
  id, dashboard_id, session_id, kind,           -- 'egress_anomaly'|'inbound_injection'|'trifecta'
  severity,                                      -- 'low'|'medium'|'high'
  detail JSON,                                   -- signals, timeline, rationale
  action_taken TEXT,                             -- 'alert'|'held'|'paused'|'tightened'
  created_at, acknowledged_at, acknowledged_by
)
-- inbound_messages: + risk_score REAL, risk_category TEXT, risk_status TEXT
-- egress_audit_log:  + bytes_out INTEGER, session_id (if not present)
```
Session risk state lives in a Durable Object (hot, rebuildable from the above), not a table.

## 11. Phasing

1. **Egress volume/rate anomaly (Phase 1)** — smallest, plumbing exists. Add `BytesOut` to
   `AuditEvent`, sink classification in `defaults.json`, control-plane aggregation + threshold +
   `threat_alert` toast + `threat_events` row. Alert-only first.
2. **Inbound injection scanner (Phase 2)** — pre-filter + Haiku judge at the webhook chokepoint;
   `inbound_messages.risk_*`; quarantine + UI flag + admin notify.
3. **Trifecta correlation (Phase 3)** — session risk DO joining 1+2+sensitive-access; escalation
   + auto-downgrade; correlated-timeline UI.
4. **Admin dashboard + auto-adaptation polish (Phase 4)**.
5. **(Optional) git-through-gateway (Phase 5)**.

## 12. Security & privacy considerations
- **Content scanning** reads message/email bodies in the control plane (where they already
  transit). No new storage of raw secrets; store risk metadata, not full content beyond existing
  `inbound_messages` retention. Document in privacy notes.
- **Fail mode**: detection failing should *not* break delivery (fail-open for the scanner, with a
  logged "scan unavailable" — unlike policy enforcement which is fail-closed). Anomaly auto-actions
  must be reversible and rate-limited to avoid a DoS-on-self via false positives.
- **Don't leak the detector**: keep thresholds/heuristics server-side; assume attackers probe.

## 13. Open questions
- Auto-act on `high` by default, or alert-only until an admin opts in per dashboard?
- Haiku judge cost/latency budget per inbound message; cache identical content.
- Where to draw the sink list (start static; later learn per-deployment baselines).
- Trifecta window length and whether secret-broker use alone counts as "sensitive access".

## 14. Honest bottom line
This catches bulk/obvious exfil and naive/known injection, and — more importantly — gives the
user and admin **observability and a control loop** the current "guardrails + YOLO" posture
lacks. It does **not** close low-bandwidth side channels or stop a determined, adaptive attacker.
The win is detection, notification, and shrinking blast radius — the bank-fraud-desk model, not a
vault.
