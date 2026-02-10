// Copyright 2026 Rob Macrae. All rights reserved.
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
  async createSessiоn(dashboardId?: string, mcpToken?: string): Promise<SandboxSession> {
    const headers = new Headers(this.authHeaders());
    let body: string | undefined;

    // Pass dashboard_id and mcp_token to sandbox so it can proxy MCP calls
    if (dashboardId || mcpToken) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify({
        dashboard_id: dashboardId,
        mcp_token: mcpToken, // Scoped token for MCP proxy calls
      });
    }

    const fetchUrl = `${this.baseUrl}/sessions`;
    console.log(`[SandboxClient.createSession] POST ${fetchUrl} (baseUrl=${this.baseUrl}, hasToken=${Boolean(this.token)})`);
    let res: Response;
    try {
      res = await fetch(fetchUrl, {
        method: 'POST',
        headers,
        body,
      });
    } catch (fetchErr) {
      console.error(`[SandboxClient.createSession] fetch threw: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`);
      throw new Error(`Failed to create session: fetch error: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`);
    }
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '(no body)');
      console.error(`[SandboxClient.createSession] FAILED status=${res.status} statusText=${res.statusText} url=${fetchUrl} body=${errorBody}`);
      throw new Error(`Failed to create session: ${res.status} ${res.statusText} - ${errorBody}`);
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
    payload: {
      set?: Record<string, string>;
      secrets?: Record<string, { value: string; brokerProtected: boolean }>;
      approvedDomains?: Array<{
        secretName: string;
        domain: string;
        headerName: string;
        headerFormat: string;
      }>;
      unset?: string[];
      applyNow?: boolean;
    },
    machineId?: string
  ): Promise<void> {
    const headers = new Headers(this.authHeaders());
    headers.set('Content-Type', 'application/json');
    if (machineId) {
      headers.set('X-Sandbox-Machine-ID', machineId);
    }
    // Convert to snake_case for sandbox API
    const secretsSnakeCase = payload.secrets
      ? Object.fromEntries(
          Object.entries(payload.secrets).map(([name, config]) => [
            name,
            { value: config.value, broker_protected: config.brokerProtected },
          ])
        )
      : undefined;

    // Convert approved domains to snake_case
    const approvedDomainsSnakeCase = payload.approvedDomains?.map(ad => ({
      secret_name: ad.secretName,
      domain: ad.domain,
      header_name: ad.headerName,
      header_format: ad.headerFormat,
    }));

    const body = {
      set: payload.set,
      secrets: secretsSnakeCase,
      approved_domains: approvedDomainsSnakeCase,
      unset: payload.unset,
      apply_now: payload.applyNow,
    };
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/env`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[sandbox] Failed to update env: ${res.status} - ${errorText}`);
      throw new Error(`Failed to update env: ${res.status}`);
    }
  }

  // PTY management
  // REVISION: working-dir-v2-createpty-error-propagation
  async createPty(
    sessionId: string,
    creatorId?: string,
    command?: string,
    machineId?: string,
    options?: {
      // Control plane can optionally provide the PTY ID (for pre-generating integration tokens)
      ptyId?: string;
      // PTY token for integration policy gateway calls
      // This token is bound to this specific PTY (terminal_id)
      integrationToken?: string;
      // Relative path within workspace to start in
      workingDir?: string;
      // Schedule execution ID — set at creation time so callback is in place before process starts
      executionId?: string;
    }
  ): Promise<SandboxPty> {
    const shouldSendBody = Boolean(creatorId || command || options?.ptyId || options?.integrationToken || options?.workingDir || options?.executionId);
    const body = shouldSendBody
      ? JSON.stringify({
          creator_id: creatorId,
          command: command,
          // If control plane provides an ID, sandbox should use it
          pty_id: options?.ptyId,
          // Integration token bound to this PTY
          integration_token: options?.integrationToken,
          // Working directory relative to workspace root
          working_dir: options?.workingDir,
          // Execution ID for schedule tracking — stored before process starts
          execution_id: options?.executionId,
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
      const errorBody = await res.text().catch(() => '(no body)');
      console.error(`[createPty] FAILED status=${res.status} sessionId=${sessionId} command=${JSON.stringify(command)} machineId=${machineId} body=${errorBody}`);
      throw new Error(`Failed to create PTY: ${res.status} - ${errorBody}`);
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

  // Write text to an existing PTY via HTTP (bypasses turn-taking for system automation)
  // REVISION: server-side-cron-v1-write-pty
  async writePty(
    sessionId: string,
    ptyId: string,
    text: string,
    machineId?: string,
    executionId?: string,
  ): Promise<void> {
    const headers = new Headers(this.authHeaders());
    headers.set('Content-Type', 'application/json');
    if (machineId) {
      headers.set('X-Sandbox-Machine-ID', machineId);
    }
    if (executionId) {
      headers.set('X-Execution-ID', executionId);
    }
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/ptys/${ptyId}/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '(no body)');
      console.error(`[writePty] FAILED status=${res.status} sessionId=${sessionId} ptyId=${ptyId} body=${errorBody}`);
      throw new Error(`Failed to write to PTY: ${res.status}`);
    }
  }
}
