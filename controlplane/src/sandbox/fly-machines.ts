// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: fly-provisioning-v1-machines-api-client
const MODULE_REVISION = 'fly-provisioning-v1-machines-api-client';
console.log(`[fly-machines] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/**
 * Fly Machines API Client
 *
 * Lightweight TypeScript wrapper for the Fly.io Machines REST API.
 * Used by the control plane to provision dedicated Fly machines per dashboard.
 * Runs inside Cloudflare Workers — uses only fetch(), no Node.js deps.
 *
 * Reference: sandbox/internal/sandbox/fly.go (Go implementation)
 * API docs: https://fly.io/docs/machines/api/
 */

const DEFAULT_FLY_API_URL = 'https://api.machines.dev';

// ── Types ────────────────────────────────────────────────────────────

export interface FlyVolume {
  id: string;
  name: string;
  state: string;
  size_gb: number;
  region: string;
  attached_machine_id: string | null;
  created_at: string;
}

export interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  private_ip: string;
  created_at: string;
  config?: { image?: string };
}

export interface FlyGuestConfig {
  cpu_kind: string;
  cpus: number;
  memory_mb: number;
}

export interface FlyServicePort {
  port: number;
  handlers: string[];
  force_https?: boolean;
}

export interface FlyServiceConcurrency {
  type: string;
  soft_limit: number;
  hard_limit: number;
}

export interface FlyService {
  protocol: string;
  internal_port: number;
  ports: FlyServicePort[];
  concurrency: FlyServiceConcurrency;
  autostart: boolean;
  autostop: string;
}

export interface FlyMount {
  volume: string;
  path: string;
}

export interface FlyCheck {
  type: string;
  port: number;
  path: string;
  interval: string;
  timeout: string;
  grace_period: string;
}

export interface FlyMachineConfig {
  image: string;
  guest: FlyGuestConfig;
  env?: Record<string, string>;
  services?: FlyService[];
  mounts?: FlyMount[];
  auto_destroy?: boolean;
  restart?: { policy: string };
  checks?: Record<string, FlyCheck>;
}

export interface FlyCreateMachineRequest {
  name?: string;
  region: string;
  config: FlyMachineConfig;
}

// ── Errors ───────────────────────────────────────────────────────────

export class FlyApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public responseBody?: string
  ) {
    super(message);
    this.name = 'FlyApiError';
  }
}

export class FlyMachineNotFoundError extends FlyApiError {
  constructor(machineId: string) {
    super(`Machine not found: ${machineId}`, 404);
    this.name = 'FlyMachineNotFoundError';
  }
}

export class FlyVolumeNotFoundError extends FlyApiError {
  constructor(volumeId: string) {
    super(`Volume not found: ${volumeId}`, 404);
    this.name = 'FlyVolumeNotFoundError';
  }
}

// ── Client ───────────────────────────────────────────────────────────

export class FlyMachinesClient {
  private appName: string;
  private apiToken: string;
  private baseUrl: string;

  constructor(appName: string, apiToken: string, baseUrl?: string) {
    this.appName = appName;
    this.apiToken = apiToken;
    this.baseUrl = (baseUrl || DEFAULT_FLY_API_URL).replace(/\/$/, '');
  }

  // ── Volumes ──────────────────────────────────────────────────────

  /**
   * Create a persistent volume for a dashboard's /workspace.
   * Volumes are region-specific and must match the machine's region.
   */
  async createVolume(name: string, region: string, sizeGb: number): Promise<FlyVolume> {
    const url = `${this.baseUrl}/v1/apps/${this.appName}/volumes`;
    const res = await this.request('POST', url, {
      name,
      region,
      size_gb: sizeGb,
      encrypted: true,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new FlyApiError(`Failed to create volume: ${res.status}`, res.status, body);
    }

    return res.json() as Promise<FlyVolume>;
  }

  /**
   * Delete a volume. The volume must not be attached to a running machine.
   */
  async deleteVolume(volumeId: string): Promise<void> {
    const url = `${this.baseUrl}/v1/apps/${this.appName}/volumes/${volumeId}`;
    const res = await this.request('DELETE', url);

    if (res.status === 404) {
      throw new FlyVolumeNotFoundError(volumeId);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new FlyApiError(`Failed to delete volume: ${res.status}`, res.status, body);
    }
  }

  // ── Machines ─────────────────────────────────────────────────────

  /**
   * Create a new Fly machine with the given configuration.
   * The machine starts automatically unless skip_launch is set.
   */
  async createMachine(config: FlyCreateMachineRequest): Promise<FlyMachine> {
    const url = `${this.baseUrl}/v1/apps/${this.appName}/machines`;
    const res = await this.request('POST', url, config);

    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new FlyApiError(`Failed to create machine: ${res.status}`, res.status, body);
    }

    return res.json() as Promise<FlyMachine>;
  }

  /**
   * Get current state of a machine.
   */
  async getMachine(machineId: string): Promise<FlyMachine> {
    const url = `${this.baseUrl}/v1/apps/${this.appName}/machines/${machineId}`;
    const res = await this.request('GET', url);

    if (res.status === 404) {
      throw new FlyMachineNotFoundError(machineId);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new FlyApiError(`Failed to get machine: ${res.status}`, res.status, body);
    }

    return res.json() as Promise<FlyMachine>;
  }

  /**
   * List all machines in the app.
   */
  async listMachines(): Promise<FlyMachine[]> {
    const url = `${this.baseUrl}/v1/apps/${this.appName}/machines`;
    const res = await this.request('GET', url);

    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new FlyApiError(`Failed to list machines: ${res.status}`, res.status, body);
    }

    return res.json() as Promise<FlyMachine[]>;
  }

  /**
   * Discover the image from an existing running machine in the app.
   * Returns undefined if no machines exist or none have a config.image.
   */
  async discoverImage(): Promise<string | undefined> {
    try {
      const machines = await this.listMachines();
      for (const m of machines) {
        if (m.config?.image) {
          return m.config.image;
        }
      }
    } catch {
      // Best-effort: fall back to configured image
    }
    return undefined;
  }

  /**
   * Start a stopped machine.
   */
  async startMachine(machineId: string): Promise<void> {
    const url = `${this.baseUrl}/v1/apps/${this.appName}/machines/${machineId}/start`;
    const res = await this.request('POST', url);

    if (res.status === 404) {
      throw new FlyMachineNotFoundError(machineId);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new FlyApiError(`Failed to start machine: ${res.status}`, res.status, body);
    }
  }

  /**
   * Stop a running machine.
   */
  async stopMachine(machineId: string): Promise<void> {
    const url = `${this.baseUrl}/v1/apps/${this.appName}/machines/${machineId}/stop`;
    const res = await this.request('POST', url);

    if (res.status === 404) {
      throw new FlyMachineNotFoundError(machineId);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new FlyApiError(`Failed to stop machine: ${res.status}`, res.status, body);
    }
  }

  /**
   * Destroy a machine. Use force=true to destroy even if running.
   */
  async destroyMachine(machineId: string, force?: boolean): Promise<void> {
    let url = `${this.baseUrl}/v1/apps/${this.appName}/machines/${machineId}`;
    if (force) {
      url += '?force=true';
    }
    const res = await this.request('DELETE', url);

    if (res.status === 404) {
      // Already destroyed — not an error
      return;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '(no body)');
      throw new FlyApiError(`Failed to destroy machine: ${res.status}`, res.status, body);
    }
  }

  /**
   * Wait for a machine to reach a specific state.
   * Tries Fly's server-side /wait endpoint first (efficient, no polling).
   * Falls back to polling getMachine if /wait returns 400 (can happen during transitions).
   */
  async waitForState(machineId: string, state: string, timeoutSec = 60): Promise<void> {
    // Fly's /wait endpoint max timeout is 60s
    const flyTimeout = Math.min(timeoutSec, 60);
    const url = `${this.baseUrl}/v1/apps/${this.appName}/machines/${machineId}/wait?state=${state}&timeout=${flyTimeout}`;
    const res = await this.request('GET', url, undefined, (timeoutSec + 5) * 1000);

    if (res.ok) return;

    if (res.status === 404) {
      throw new FlyMachineNotFoundError(machineId);
    }

    // /wait returned an error (often 400 during transitions) — fall back to polling
    const waitBody = await res.text().catch(() => '(no body)');
    console.log(`[fly-machines] /wait returned ${res.status} for machine ${machineId}, falling back to polling. Body: ${waitBody}`);

    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const machine = await this.getMachine(machineId);
        if (machine.state === state) return;
        if (machine.state === 'destroyed' || machine.state === 'failed') {
          throw new FlyApiError(
            `Machine ${machineId} entered terminal state '${machine.state}' while waiting for '${state}'`,
            400,
            waitBody
          );
        }
      } catch (e) {
        if (e instanceof FlyMachineNotFoundError) throw e;
        // Transient error — keep polling
      }
    }

    throw new FlyApiError(
      `Machine ${machineId} did not reach state '${state}' within ${timeoutSec}s (polled)`,
      408,
      waitBody
    );
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /**
   * Build the default machine configuration for a dashboard sandbox.
   */
  static buildMachineConfig(opts: {
    dashboardId: string;
    volumeId: string;
    image: string;
    region: string;
    env: Record<string, string>;
  }): FlyCreateMachineRequest {
    return {
      name: `orcabot-${opts.dashboardId.slice(0, 8)}-${crypto.randomUUID().slice(0, 6)}`,
      region: opts.region,
      config: {
        image: opts.image,
        guest: {
          cpu_kind: 'shared',
          cpus: 2,
          memory_mb: 4096,
        },
        env: {
          PORT: '8080',
          ...opts.env,
        },
        services: [
          {
            protocol: 'tcp',
            internal_port: 8080,
            ports: [
              { port: 443, handlers: ['http', 'tls'] },
              { port: 80, handlers: ['http'] },
            ],
            concurrency: {
              type: 'connections',
              soft_limit: 80,
              hard_limit: 100,
            },
            autostart: true,
            autostop: 'stop',
          },
        ],
        mounts: [
          {
            volume: opts.volumeId,
            path: '/workspace',
          },
        ],
        auto_destroy: false,
        restart: { policy: 'on-failure' },
        checks: {
          health: {
            type: 'http',
            port: 8080,
            path: '/health',
            interval: '15s',
            timeout: '5s',
            grace_period: '10s',
          },
        },
      },
    };
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async request(
    method: string,
    url: string,
    body?: unknown,
    timeoutMs = 30_000
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiToken}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
