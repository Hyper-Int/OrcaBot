// REVISION: e2e-base-v1-diagnostics-env
import { test as base, expect } from "@playwright/test";
import { login, devModeLoginViaUI, logout } from "./auth";
import {
  createDashboard,
  gotoDashboard,
  deleteDashboardViaUI,
} from "./dashboard";
import {
  addTerminal,
  waitForPrompt,
  typeCommand,
  waitForOutput,
} from "./terminal";
import { OrcabotAPI } from "../helpers/api";
import { createDiagnostics, type E2EDiagnostics } from "../helpers/diagnostics";
import { requireEnv, requiredEnvReport } from "../helpers/env";

const MODULE_REVISION = "e2e-base-v1-diagnostics-env";
console.log(
  `[e2e-base] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

/** Bundled auth helpers available in every test */
export interface AuthFixture {
  /** API-based login (fast, reliable — bypasses UI) */
  login: (opts?: { name?: string; email?: string }) => Promise<void>;
  /** UI-based login (slower — tests the actual form flow) */
  loginViaUI: (opts?: { name?: string; email?: string }) => Promise<void>;
  logout: () => Promise<void>;
}

/** Bundled dashboard helpers with auto-cleanup */
export interface DashboardFixture {
  create: (name?: string) => Promise<string>;
  goto: (id: string) => Promise<void>;
  deleteViaUI: (name: string) => Promise<void>;
  /** Track a dashboard ID for auto-cleanup in teardown */
  track: (id: string) => void;
}

/** Bundled terminal helpers */
export interface TerminalFixture {
  add: (type?: "terminal" | "claude-code" | "gemini-cli" | "codex") => Promise<void>;
  waitForPrompt: (timeoutMs?: number) => Promise<void>;
  typeCommand: (command: string) => Promise<void>;
  waitForOutput: (text: string | RegExp, timeoutMs?: number) => Promise<void>;
}

/** API client for direct control plane calls */
export interface APIFixture {
  client: OrcabotAPI;
}

/** Run-level diagnostics attached to every test */
export interface DiagnosticsFixture {
  collector: E2EDiagnostics;
}

/**
 * Extended test with auth, dashboard, terminal, and api fixtures.
 * Import { test, expect } from this file in all recipe specs.
 */
export const test = base.extend<{
  auth: AuthFixture;
  dashboard: DashboardFixture;
  terminal: TerminalFixture;
  api: APIFixture;
  diagnostics: DiagnosticsFixture;
}>({
  diagnostics: [
    async ({ page }, use, testInfo) => {
      const collector = await createDiagnostics(page);
      await use({ collector });
      await collector.attach(testInfo);
    },
    { auto: true },
  ],

  auth: async ({ page }, use) => {
    await use({
      login: (opts) => login(page, opts?.name, opts?.email),
      loginViaUI: (opts) => devModeLoginViaUI(page, opts?.name, opts?.email),
      logout: () => logout(page),
    });
  },

  dashboard: async ({ page, baseURL }, use) => {
    const trackedIds: string[] = [];

    await use({
      create: async (name) => {
        const id = await createDashboard(page, name);
        trackedIds.push(id);
        return id;
      },
      goto: (id) => gotoDashboard(page, id),
      deleteViaUI: (name) => deleteDashboardViaUI(page, name),
      track: (id) => trackedIds.push(id),
    });

    // Auto-cleanup: attempt API-based delete for all tracked dashboards
    const cpUrl = requireEnv("CONTROLPLANE_URL");
    if (trackedIds.length > 0) {
      const email = requireEnv("E2E_USER_EMAIL");
      const name = requireEnv("E2E_USER_NAME");
      const api = new OrcabotAPI(page.request, cpUrl, email, name);
      for (const id of trackedIds) {
        try {
          await api.deleteDashboard(id);
        } catch {
          // Ignore cleanup failures — dashboard may already be deleted
        }
      }
    }
  },

  terminal: async ({ page }, use) => {
    await use({
      add: (type) => addTerminal(page, type),
      waitForPrompt: (t) => waitForPrompt(page, t),
      typeCommand: (cmd) => typeCommand(page, cmd),
      waitForOutput: (text, t) => waitForOutput(page, text, t),
    });
  },

  api: async ({ page }, use) => {
    const email = requireEnv("E2E_USER_EMAIL");
    const name = requireEnv("E2E_USER_NAME");
    const cpUrl = requireEnv("CONTROLPLANE_URL");
    const client = new OrcabotAPI(page.request, cpUrl, email, name);
    await use({ client });
  },
});

test.beforeAll(() => {
  const report = requiredEnvReport();
  if (!report.smoke.ready) {
    throw new Error(
      `Smoke-tier E2E env is incomplete. Missing: ${report.smoke.missing.join(
        ", "
      )}. Set them in e2e/.env.test.local.`
    );
  }
});

export { expect };
