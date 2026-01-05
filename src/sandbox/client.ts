/**
 * Sandbox Client
 *
 * Communicates with the sandbox server (Go backend running on Fly.io or localhost).
 * This is the control plane's interface to the execution plane.
 */

export interface SandboxSession {
  id: string;
}

export class SandboxClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    // Remove trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, '');
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

  // Session management
  async createSession(): Promise<SandboxSession> {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`Failed to create session: ${res.status}`);
    }
    return res.json();
  }

  async deleteSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete session: ${res.status}`);
    }
  }
}
