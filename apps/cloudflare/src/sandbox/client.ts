/**
 * Sandbox Client
 *
 * Communicates with the sandbox server (Go backend running on Fly.io or localhost).
 * This is the control plane's interface to the execution plane.
 */

export interface SandboxSession {
  id: string;
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
  async createSession(): Promise<SandboxSession> {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`Failed to create session: ${res.status}`);
    }
    return res.json();
  }

  async deleteSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete session: ${res.status}`);
    }
  }

  // PTY management
  async createPty(sessionId: string, creatorId?: string): Promise<SandboxPty> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        ...(creatorId ? { 'Content-Type': 'application/json' } : undefined),
      },
      body: creatorId ? JSON.stringify({ creator_id: creatorId }) : undefined,
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
