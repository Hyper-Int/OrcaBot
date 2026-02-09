// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: bridge-v3-outbound-send
const MODULE_REVISION = 'bridge-v3-outbound-send';
console.log(`[bridge] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import express from 'express';
import { SessionManager } from './session-manager.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const BRIDGE_INTERNAL_TOKEN = process.env.BRIDGE_INTERNAL_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || '/data';

if (!BRIDGE_INTERNAL_TOKEN) {
  console.error('[bridge] BRIDGE_INTERNAL_TOKEN not set — all authenticated requests will be rejected');
}

const sessionManager = new SessionManager(DATA_DIR, BRIDGE_INTERNAL_TOKEN);
const app = express();
app.use(express.json());

const startTime = Date.now();

// ---------- Auth middleware ----------

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = req.headers['x-bridge-token'] as string | undefined;
  if (!BRIDGE_INTERNAL_TOKEN || token !== BRIDGE_INTERNAL_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ---------- Health (no auth) ----------

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    revision: MODULE_REVISION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    sessions: sessionManager.listSessions().length,
  });
});

// ---------- Session endpoints ----------

app.post('/sessions', requireAuth, async (req, res) => {
  try {
    const { sessionId, userId, provider, callbackUrl, config } = req.body;
    if (!sessionId || !userId || !provider || !callbackUrl) {
      res.status(400).json({ error: 'sessionId, userId, provider, and callbackUrl are required' });
      return;
    }

    const result = await sessionManager.startSession({
      sessionId,
      userId,
      provider,
      callbackUrl,
      config,
    });

    res.json(result);
  } catch (err) {
    console.error('[bridge] Failed to start session:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
  }
});

app.delete('/sessions/:sessionId', requireAuth, async (req, res) => {
  try {
    await sessionManager.stopSession(req.params.sessionId as string);
    res.json({ status: 'stopped' });
  } catch (err) {
    if (err instanceof Error && err.message === 'Session not found') {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    console.error('[bridge] Failed to stop session:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/sessions/:sessionId/status', requireAuth, (req, res) => {
  const session = sessionManager.getSession(req.params.sessionId as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({
    sessionId: session.sessionId,
    userId: session.userId,
    provider: session.provider,
    status: session.status,
    connectedAt: session.connectedAt?.toISOString() ?? null,
    lastMessageAt: session.lastMessageAt?.toISOString() ?? null,
    error: session.error ?? null,
  });
});

app.get('/sessions/:sessionId/qr', requireAuth, (req, res) => {
  const session = sessionManager.getSession(req.params.sessionId as string);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (session.status === 'connected') {
    res.json({ status: 'connected' });
    return;
  }
  const qrCode = session.providerInstance.getQrCode?.();
  if (!qrCode) {
    res.json({ status: session.status, qrCode: null, ...(session.error && { error: session.error }) });
    return;
  }
  res.json({ status: 'awaiting_scan', qrCode });
});

// POST /sessions/:sessionId/send -- Send outbound message via bridge
app.post('/sessions/:sessionId/send', requireAuth, async (req, res) => {
  try {
    const { jid, text } = req.body;
    if (!jid || !text) {
      res.status(400).json({ error: 'jid and text are required' });
      return;
    }

    const session = sessionManager.getSession(req.params.sessionId as string);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (session.status !== 'connected') {
      res.status(503).json({ error: `Session not connected (status: ${session.status})` });
      return;
    }

    const provider = session.providerInstance;
    if (!provider.sendMessage) {
      res.status(400).json({ error: 'Provider does not support sending messages' });
      return;
    }

    const result = await provider.sendMessage(jid, text);
    res.json({ ok: true, messageId: result.messageId });
  } catch (err) {
    console.error('[bridge] Failed to send message:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Send failed' });
  }
});

app.get('/sessions', requireAuth, (_req, res) => {
  const sessions = sessionManager.listSessions();
  res.json({ sessions });
});

// ---------- Graceful shutdown ----------

const server = app.listen(PORT, () => {
  console.log(`[bridge] Listening on port ${PORT}`);
});

async function shutdown(signal: string) {
  console.log(`[bridge] Received ${signal}, shutting down gracefully...`);
  await sessionManager.stopAll();
  server.close(() => {
    console.log('[bridge] Server closed');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
