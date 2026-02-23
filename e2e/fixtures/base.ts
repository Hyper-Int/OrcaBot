import { test as base, expect } from "@playwright/test";
import { devModeLogin, devModeLoginViaUI, logout } from "./auth";
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

/**
 * Extended test with auth, dashboard, terminal, and api fixtures.
 * Import { test, expect } from this file in all recipe specs.
 */
export const test = base.extend<{
  auth: AuthFixture;
  dashboard: DashboardFixture;
  terminal: TerminalFixture;
  api: APIFixture;
}>({
  auth: async ({ page }, use) => {
    await use({
      login: (opts) => devModeLogin(page, opts?.name, opts?.email),
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
    const cpUrl = process.env.CONTROLPLANE_URL || "http://localhost:8787";
    if (trackedIds.length > 0) {
      const email =
        process.env.E2E_USER_EMAIL || "e2e-test@orcabot.test";
      const name = process.env.E2E_USER_NAME || "E2E Test User";
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
    const email = process.env.E2E_USER_EMAIL || "e2e-test@orcabot.test";
    const name = process.env.E2E_USER_NAME || "E2E Test User";
    const cpUrl = process.env.CONTROLPLANE_URL || "http://localhost:8787";
    const client = new OrcabotAPI(page.request, cpUrl, email, name);
    await use({ client });
  },
});

export { expect };
