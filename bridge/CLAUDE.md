# CLAUDE.md

## Purpose

This service is the **messaging bridge** — a standalone Node.js server deployed on Fly that maintains persistent connections to messaging platforms on behalf of users.

Currently supports **WhatsApp** via Baileys (unofficial WhatsApp Web API).

It does **not**:
- Store messages long-term (forwards to control plane callback)
- Handle auth or user management (control plane owns that)
- Run agents or terminals
- Serve any UI

Claude should act as a **systems-oriented assistant** focused on reliable, long-lived messaging connections.

---

## Architecture

```
Control Plane
  → POST /sessions        (start a messaging session)
  → DELETE /sessions/:id  (stop a session)
  → GET /sessions/:id/qr  (get QR code for WhatsApp pairing)
  → POST /sessions/:id/send  (send outbound message)
  → POST /sessions/:id/handshake  (refresh 24h window)
  ← POST callbackUrl      (bridge forwards inbound messages to control plane)
```

### Auth
- All endpoints (except `/health`) require `X-Bridge-Token` header matching `BRIDGE_INTERNAL_TOKEN` env var
- Empty token = all authenticated requests rejected (fail-closed)

### Session Lifecycle
1. Control plane calls `POST /sessions` with `sessionId`, `userId`, `provider`, `callbackUrl`
2. Bridge creates a provider instance (WhatsApp) and starts connection
3. For WhatsApp: generates QR code, user scans, connection established
4. Inbound messages are normalized to `NormalizedMessage` format and forwarded to `callbackUrl`
5. Session state persisted to disk (`DATA_DIR`) for reconnection across restarts

### Env Vars
- `PORT` — HTTP port (default: 8080)
- `BRIDGE_INTERNAL_TOKEN` — Auth token for API requests
- `DATA_DIR` — Directory for session persistence (default: /data)

---

## Structure

```
bridge/
├── src/
│   ├── index.ts           — Express server, routes, auth middleware
│   ├── session-manager.ts — Session lifecycle, message forwarding
│   └── providers/
│       └── whatsapp.ts    — WhatsApp via Baileys (QR pairing, reconnection, send/receive)
├── Dockerfile
├── fly.toml               — Production Fly config
└── fly.dev.toml           — Dev Fly config
```

---

## Key Concepts

- **Provider interface**: `BridgeProvider` — start/stop/status/sendMessage/getQrCode
- **NormalizedMessage**: Platform-agnostic message format forwarded to control plane
- **Callback URL**: Control plane provides a URL per session; bridge POSTs inbound messages there
- **Reconnection**: WhatsApp sessions persist auth state to disk, surviving service restarts

---

## Responsibility Boundaries (non-negotiable)

### Bridge owns
- Persistent platform connections (WebSocket to WhatsApp servers)
- QR code generation and pairing flow
- Message normalization and forwarding
- Session persistence to disk
- Outbound message sending

### Bridge does NOT own
- User auth or identity
- Message storage or history
- Policy enforcement
- Webhook verification (that's control plane for other platforms)
- UI

---

## Deployment

```bash
# Production
cd bridge && fly deploy

# Dev
cd bridge && fly deploy -c fly.dev.toml
```
