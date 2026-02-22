import type { APIRequestContext } from "@playwright/test";

/**
 * Generate a stable user ID from email — mirrors frontend/src/stores/auth-store.ts:52
 */
export function generateUserId(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    const char = email.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `dev-${Math.abs(hash).toString(36)}`;
}

/**
 * Direct control plane API calls for test setup/teardown.
 * Uses the same header-based auth as the frontend's dev mode.
 */
export class OrcabotAPI {
  private userId: string;

  constructor(
    private request: APIRequestContext,
    private baseURL: string,
    private userEmail: string,
    private userName: string
  ) {
    this.userId = generateUserId(userEmail);
  }

  private headers() {
    return {
      "Content-Type": "application/json",
      "X-User-ID": this.userId,
      "X-User-Email": this.userEmail,
      "X-User-Name": this.userName,
    };
  }

  async listDashboards(): Promise<{ dashboards: Array<{ id: string; name: string }> }> {
    const res = await this.request.get(`${this.baseURL}/dashboards`, {
      headers: this.headers(),
    });
    return res.json();
  }

  async deleteDashboard(id: string): Promise<void> {
    await this.request.delete(`${this.baseURL}/dashboards/${id}`, {
      headers: this.headers(),
    });
  }

  /** Delete all dashboards whose name starts with a given prefix */
  async cleanupDashboards(prefix = "E2E-"): Promise<void> {
    try {
      const { dashboards } = await this.listDashboards();
      for (const d of dashboards || []) {
        if (d.name.startsWith(prefix)) {
          try {
            await this.deleteDashboard(d.id);
          } catch {
            // Ignore individual cleanup failures
          }
        }
      }
    } catch {
      // Ignore if listing fails
    }
  }

  /** Get dashboard details including items and active sessions */
  async getDashboardDetails(id: string): Promise<{
    dashboard: { id: string; name: string };
    items: Array<{ id: string; type: string; content: string }>;
    sessions: Array<{ id: string; itemId: string; status: string }>;
  }> {
    const res = await this.request.get(`${this.baseURL}/dashboards/${id}`, {
      headers: this.headers(),
    });
    return res.json();
  }

  /** Create a secret (encrypted, stored in control plane) */
  async createSecret(opts: {
    name: string;
    value: string;
    dashboardId?: string;
    type?: "secret" | "env_var";
    brokerProtected?: boolean;
  }): Promise<{ secret: { id: string; name: string } }> {
    const res = await this.request.post(`${this.baseURL}/secrets`, {
      headers: this.headers(),
      data: {
        name: opts.name,
        value: opts.value,
        dashboardId: opts.dashboardId ?? "_global",
        type: opts.type ?? "secret",
        brokerProtected: opts.brokerProtected ?? true,
      },
    });
    return res.json();
  }

  /** Delete a secret by ID */
  async deleteSecret(id: string): Promise<void> {
    await this.request.delete(`${this.baseURL}/secrets/${id}`, {
      headers: this.headers(),
    });
  }

  /** Apply all secrets to an active session's sandbox */
  async applySessionSecrets(sessionId: string): Promise<void> {
    await this.request.post(
      `${this.baseURL}/sessions/${sessionId}/apply-secrets`,
      { headers: this.headers() }
    );
  }
}
