// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: bridge-client-v2-outbound-send
const MODULE_REVISION = 'bridge-client-v2-outbound-send';
console.log(`[bridge-client] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * HTTP client for control plane → bridge communication.
 *
 * The bridge service maintains persistent WebSocket/long-poll connections
 * to messaging platforms (WhatsApp personal via Baileys, Matrix via /sync)
 * and forwards inbound messages to the control plane webhook endpoint.
 */

interface StartSessionResponse {
  sessionId: string;
  status: string;
  qrCode?: string | null;
}

interface SessionStatusResponse {
  sessionId: string;
  userId: string;
  provider: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

interface QrResponse {
  status: string;
  qrCode?: string | null;
}

export class BridgeClient {
  constructor(
    private bridgeUrl: string,
    private internalToken: string,
  ) {}

  private async bridgeFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.bridgeUrl.replace(/\/$/, '')}${path}`;
    const headers = new Headers(options.headers);
    headers.set('X-Bridge-Token', this.internalToken);
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...options, headers });
  }

  async startSession(config: {
    sessionId: string;
    userId: string;
    provider: string;
    callbackUrl: string;
    config?: Record<string, unknown>;
  }): Promise<StartSessionResponse> {
    const resp = await this.bridgeFetch('/sessions', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Bridge startSession failed: ${resp.status} ${body}`);
    }
    return resp.json() as Promise<StartSessionResponse>;
  }

  async stopSession(sessionId: string): Promise<void> {
    const resp = await this.bridgeFetch(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Bridge stopSession failed: ${resp.status}`);
    }
  }

  async getStatus(sessionId: string): Promise<SessionStatusResponse | null> {
    const resp = await this.bridgeFetch(`/sessions/${encodeURIComponent(sessionId)}/status`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Bridge getStatus failed: ${resp.status}`);
    return resp.json() as Promise<SessionStatusResponse>;
  }

  async getQrCode(sessionId: string): Promise<QrResponse | null> {
    const resp = await this.bridgeFetch(`/sessions/${encodeURIComponent(sessionId)}/qr`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Bridge getQrCode failed: ${resp.status}`);
    return resp.json() as Promise<QrResponse>;
  }

  async sendMessage(sessionId: string, jid: string, text: string): Promise<{ ok: boolean; messageId?: string }> {
    const resp = await this.bridgeFetch(`/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ jid, text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Bridge sendMessage failed: ${resp.status} ${body}`);
    }
    return resp.json() as Promise<{ ok: boolean; messageId?: string }>;
  }
}
