// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: session-manager-v8-dashboardid-in-logs
console.log(`[session-manager] REVISION: session-manager-v8-dashboardid-in-logs loaded at ${new Date().toISOString()}`);

import { WhatsAppProvider } from './providers/whatsapp.js';

// ---------- Types ----------

export interface BridgeProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): 'connecting' | 'connected' | 'disconnected' | 'error';
  getQrCode?(): string | null;
  sendMessage?(jid: string, text: string): Promise<{ messageId: string }>;
  triggerHandshake?(): Promise<boolean>;
}

export interface NormalizedMessage {
  provider: string;
  webhookId: string;
  platformMessageId: string;
  senderId: string;
  senderName: string;
  channelId: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface BridgeSession {
  sessionId: string;
  userId: string;
  provider: string;
  dashboardId?: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  callbackUrl: string;
  providerInstance: BridgeProvider;
  connectedAt?: Date;
  lastMessageAt?: Date;
  error?: string;
}

interface StartSessionConfig {
  sessionId: string;
  userId: string;
  provider: string;
  callbackUrl: string;
  dashboardId?: string;
  config?: Record<string, unknown>;
}

// ---------- Session Manager ----------

export class SessionManager {
  private sessions = new Map<string, BridgeSession>();

  constructor(
    private dataDir: string,
    private bridgeToken: string,
  ) {}

  async startSession(config: StartSessionConfig): Promise<{
    sessionId: string;
    status: string;
    qrCode?: string | null;
  }> {
    // Stop existing session for same ID if any
    if (this.sessions.has(config.sessionId)) {
      await this.stopSession(config.sessionId);
    }

    const provider = this.createProvider(config);

    const session: BridgeSession = {
      sessionId: config.sessionId,
      userId: config.userId,
      provider: config.provider,
      dashboardId: config.dashboardId,
      status: 'connecting',
      callbackUrl: config.callbackUrl,
      providerInstance: provider,
    };

    this.sessions.set(config.sessionId, session);

    try {
      await provider.start();
    } catch (err) {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : 'Failed to start';
      console.error(`[session-manager] Failed to start session ${config.sessionId} (dashboard=${config.dashboardId}):`, err);
    }

    return {
      sessionId: config.sessionId,
      status: session.status,
      qrCode: provider.getQrCode?.() ?? null,
    };
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    try {
      await session.providerInstance.stop();
    } catch (err) {
      console.error(`[session-manager] Error stopping session ${sessionId} (dashboard=${session.dashboardId}):`, err);
    }
    this.sessions.delete(sessionId);
    console.log(`[session-manager] Session ${sessionId} stopped (dashboard=${session.dashboardId})`);
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.stopSession(id).catch(() => {});
    }
  }

  getSession(sessionId: string): BridgeSession | undefined {
    return this.sessions.get(sessionId);
  }

  getDashboardId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.dashboardId;
  }

  listSessions(): Array<{
    sessionId: string;
    userId: string;
    provider: string;
    status: string;
  }> {
    return Array.from(this.sessions.values()).map(s => ({
      sessionId: s.sessionId,
      userId: s.userId,
      provider: s.provider,
      status: s.status,
    }));
  }

  /** Called by provider instances when a message arrives */
  async forwardMessage(sessionId: string, message: NormalizedMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn(`[session-manager] forwardMessage for unknown session ${sessionId} (no dashboard context)`);
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const resp = await fetch(session.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Token': this.bridgeToken,
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const respBody = await resp.text().catch(() => '');
        console.error(`[session-manager] Callback failed for session ${sessionId} (dashboard=${session.dashboardId}): ${resp.status} ${respBody.slice(0, 200)}`);
      }

      session.lastMessageAt = new Date();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error(`[session-manager] Callback timed out for session ${sessionId} (dashboard=${session.dashboardId})`);
      } else {
        console.error(`[session-manager] Callback error for session ${sessionId} (dashboard=${session.dashboardId}):`, err);
      }
    }
  }

  /** Called by provider instances when connection status changes */
  updateSessionStatus(
    sessionId: string,
    status: 'connecting' | 'connected' | 'disconnected' | 'error',
    error?: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = status;
    session.error = error;
    if (status === 'connected') {
      session.connectedAt = new Date();
    }
    console.log(`[session-manager] Session ${sessionId} (dashboard=${session.dashboardId}) status: ${status}${error ? ` (${error})` : ''}`);
  }

  private createProvider(config: StartSessionConfig): BridgeProvider {
    switch (config.provider) {
      case 'whatsapp':
        return new WhatsAppProvider(
          config.sessionId,
          config.userId,
          this.dataDir,
          this,
          config.config as import('./providers/whatsapp.js').HybridConfig | undefined,
          config.dashboardId,
        );
      default:
        throw new Error(`Unsupported provider: ${config.provider}`);
    }
  }
}
