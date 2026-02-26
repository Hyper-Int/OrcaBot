// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: sandbox-client-v2-fetch-timeouts
const sandboxClientRevision = "sandbox-client-v2-fetch-timeouts";
console.log(`[sandbox-client] REVISION: ${sandboxClientRevision} loaded at ${new Date().toISOString()}`);

/**
 * Sandbox Client
 *
 * Communicates with the sandbox server (Go backend running on Fly.io or localhost).
 * This is the control plane's interface to the execution plane.
 */

// Default timeout for sandbox requests. Prevents indefinite hangs when Fly proxy
// can't route to a machine (Fly-Replay loop to a destroyed machine = PR04 error).
const SANDBOX_FETCH_TIMEOUT_MS = 15_000;

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
    if (!this.token) {
      console.error(`[SandboxClient] WARNING: no auth token provided — all requests will be unauthenticated`);
    } else {
      console.log(`[SandboxClient] initialized with token (len=${this.token.length}, prefix=${this.token.slice(0, 4)})`);
    }
  }

  /** Fetch with an AbortController timeout to prevent indefinite hangs. */
  private async timedFetch(url: string, init?: RequestInit, timeoutMs = SANDBOX_FETCH_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Health check (optionally pinned to a specific Fly machine)
  // REVISION: session-recovery-v2-fast-health-check
  async health(machineId?: string, timeoutMs?: number): Promise<boolean> {
    try {
      const headers: HeadersInit = {};
      if (machineId) {
        headers['X-Sandbox-Machine-ID'] = machineId;
      }
      const res = await this.timedFetch(`${this.baseUrl}/health`, { headers }, timeoutMs);
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
  // REVISION: fly-provisioning-v2-egress-opt-in
  async createSessiоn(dashboardId?: string, mcpToken?: string, machineId?: string, egressEnabled?: boolean): Promise<SandboxSession> {
    const headers = new Headers(this.authHeaders());
    let body: string | undefined;

    // Pin to a specific Fly machine (for per-dashboard provisioning)
    if (machineId) {
      headers.set('X-Sandbox-Machine-ID', machineId);
    }

    // Pass dashboard_id, mcp_token, and egress opt-in to sandbox
    if (dashboardId || mcpToken || egressEnabled) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify({
        dashboard_id: dashboardId,
        mcp_token: mcpToken, // Scoped token for MCP proxy calls
        ...(egressEnabled ? { egress_enabled: true } : {}),
      });
    }

    const fetchUrl = `${this.baseUrl}/sessions`;
    let res: Response;
    try {
      res = await this.timedFetch(fetchUrl, {
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
    const res = await this.timedFetch(`${this.baseUrl}/sessions/${sessionId}`, {
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
    const res = await this.timedFetch(`${this.baseUrl}/sessions/${sessionId}/env`, {
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
  // REVISION: session-recovery-v1-list-ptys
  async listPtys(sessionId: string, machineId?: string, timeoutMs?: number): Promise<SandboxPty[]> {
    const headers = new Headers(this.authHeaders());
    if (machineId) {
      headers.set('X-Sandbox-Machine-ID', machineId);
    }
    const res = await this.timedFetch(`${this.baseUrl}/sessions/${sessionId}/ptys`, {
      method: 'GET',
      headers,
    }, timeoutMs);
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '(no body)');
      throw new Error(`Failed to list PTYs: ${res.status} - ${errorBody}`);
    }
    const payload = await res.json() as { ptys?: SandboxPty[] };
    return Array.isArray(payload.ptys) ? payload.ptys : [];
  }

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
      // Per-session egress proxy opt-in
      egressEnabled?: boolean;
    }
  ): Promise<SandboxPty> {
    const shouldSendBody = Boolean(creatorId || command || options?.ptyId || options?.integrationToken || options?.workingDir || options?.executionId || options?.egressEnabled);
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
          // Egress proxy opt-in (enables proxy for entire session)
          ...(options?.egressEnabled ? { egress_enabled: true } : {}),
        })
      : undefined;
    const headers = new Headers(this.authHeaders());
    if (machineId) {
      headers.set('X-Sandbox-Machine-ID', machineId);
    }
    if (shouldSendBody) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await this.timedFetch(`${this.baseUrl}/sessions/${sessionId}/ptys`, {
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
    const res = await this.timedFetch(`${this.baseUrl}/sessions/${sessionId}/ptys/${ptyId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete PTY: ${res.status}`);
    }
  }

  // Write text to an existing PTY via HTTP (bypasses turn-taking for system automation)
  // When execute=true, uses ExecuteSystem (text + 50ms delay + CR) for agentic terminals.
  // When execute=false, uses WriteSystem (text + CR concatenated) for raw shell writes.
  // REVISION: messaging-v1-execute-param
  async writePty(
    sessionId: string,
    ptyId: string,
    text: string,
    machineId?: string,
    executionId?: string,
    execute?: boolean,
  ): Promise<void> {
    const headers = new Headers(this.authHeaders());
    headers.set('Content-Type', 'application/json');
    if (machineId) {
      headers.set('X-Sandbox-Machine-ID', machineId);
    }
    if (executionId) {
      headers.set('X-Execution-ID', executionId);
    }
    const res = await this.timedFetch(`${this.baseUrl}/sessions/${sessionId}/ptys/${ptyId}/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, execute: execute ?? false }),
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '(no body)');
      console.error(`[writePty] FAILED status=${res.status} sessionId=${sessionId} ptyId=${ptyId} body=${errorBody}`);
      throw new Error(`Failed to write to PTY: ${res.status}`);
    }
  }

}
