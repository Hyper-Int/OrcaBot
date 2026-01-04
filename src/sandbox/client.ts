/**
 * Sandbox Client
 *
 * Communicates with the sandbox server (Go backend running on Fly.io or localhost).
 * This is the control plane's interface to the execution plane.
 */

export interface SandboxSession {
  id: string;
}

export interface SandboxPTY {
  id: string;
}

export interface SandboxAgent {
  id: string;
  state: 'running' | 'paused' | 'stopped';
}

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  mod_time: string;
  mode: string;
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

  // PTY management
  async listPTYs(sessionId: string): Promise<SandboxPTY[]> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys`);
    if (!res.ok) {
      throw new Error(`Failed to list PTYs: ${res.status}`);
    }
    const data = await res.json() as { ptys: SandboxPTY[] };
    return data.ptys;
  }

  async createPTY(sessionId: string): Promise<SandboxPTY> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`Failed to create PTY: ${res.status}`);
    }
    return res.json();
  }

  async deletePTY(sessionId: string, ptyId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys/${ptyId}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete PTY: ${res.status}`);
    }
  }

  // Get WebSocket URL for PTY
  getPTYWebSocketUrl(sessionId: string, ptyId: string, userId: string): string {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    return `${wsBase}/sessions/${sessionId}/ptys/${ptyId}/ws?user_id=${encodeURIComponent(userId)}`;
  }

  // Agent management
  async startAgent(sessionId: string): Promise<SandboxAgent> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/agent`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`Failed to start agent: ${res.status}`);
    }
    return res.json();
  }

  async getAgent(sessionId: string): Promise<SandboxAgent | null> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/agent`);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Failed to get agent: ${res.status}`);
    }
    return res.json();
  }

  async pauseAgent(sessionId: string): Promise<{ state: string }> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/agent/pause`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`Failed to pause agent: ${res.status}`);
    }
    return res.json();
  }

  async resumeAgent(sessionId: string): Promise<{ state: string }> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/agent/resume`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`Failed to resume agent: ${res.status}`);
    }
    return res.json();
  }

  async stopAgent(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/agent/stop`, {
      method: 'POST',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to stop agent: ${res.status}`);
    }
  }

  // Get WebSocket URL for Agent
  getAgentWebSocketUrl(sessionId: string, userId: string): string {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    return `${wsBase}/sessions/${sessionId}/agent/ws?user_id=${encodeURIComponent(userId)}`;
  }

  // Filesystem operations
  async listFiles(sessionId: string, path: string = '/'): Promise<FileInfo[]> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      throw new Error(`Failed to list files: ${res.status}`);
    }
    const data = await res.json() as { files: FileInfo[] };
    return data.files;
  }

  async readFile(sessionId: string, path: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      throw new Error(`Failed to read file: ${res.status}`);
    }
    return res.arrayBuffer();
  }

  async writeFile(sessionId: string, path: string, content: ArrayBuffer | string): Promise<void> {
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      body,
    });
    if (!res.ok) {
      throw new Error(`Failed to write file: ${res.status}`);
    }
  }

  async deleteFile(sessionId: string, path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete file: ${res.status}`);
    }
  }

  async statFile(sessionId: string, path: string): Promise<FileInfo> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/file/stat?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      throw new Error(`Failed to stat file: ${res.status}`);
    }
    return res.json();
  }
}
