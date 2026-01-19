// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Sandbox Client
 *
 * Communicates with the sandbox server (Go backend running on Fly.io or localhost).
 * This is the control plane's interface to the execution plane.
 */

export interface SandboxSession {
  id: string;
  machineId?: string;
}

export interface SandboxPty {
  id: string;
}

export class SandboxClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token?: string) {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token || '';
  }

  // Health check
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  private authHeaders(): HeadersInit {
    if (!this.token) {
      return {};
    }
    return { 'X-Internal-Token': this.token };
  }

  // Session management
  async createSessiоn(): Promise<SandboxSession> {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Failed to create session: ${res.status}`);
    }
    const data = await res.json() as { id: string; machine_id?: string };
    return {
      id: data.id,
      machineId: data.machine_id,
    };
  }

  async deleteSession(sessionId: string, machineId?: string): Promise<void> {
    const headers = new Headers(this.authHeaders());
    if (machineId) {
      headers.set('X-Sandbox-Machine-ID', machineId);
    }
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers,
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete session: ${res.status}`);
    }
  }

  // Environment management
  async updateEnv(
    sessionId: string,
    payload: { set?: Record<string, string>; unset?: string[]; applyNow?: boolean },
    machineId?: string
  ): Promise<void> {
    const headers = new Headers(this.authHeaders());
    headers.set('Content-Type', 'application/json');
    if (machineId) {
      headers.set('X-Sandbox-Machine-ID', machineId);
    }
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/env`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Failed to update env: ${res.status}`);
    }
  }

  // PTY management
  async createPty(sessionId: string, creatorId?: string, command?: string, machineId?: string): Promise<SandboxPty> {
    const shouldSendBody = Boolean(creatorId || command);
    const body = shouldSendBody
      ? JSON.stringify({
          creator_id: creatorId,
          command: command,
        })
      : undefined;
    const headers = new Headers(this.authHeaders());
    if (machineId) {
      headers.set('X-Sandbox-Machine-ID', machineId);
    }
    if (shouldSendBody) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      throw new Error(`Failed to create PTY: ${res.status}`);
    }
    return res.json();
  }

  async deletePty(sessionId: string, ptyId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys/${ptyId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete PTY: ${res.status}`);
    }
  }
}
