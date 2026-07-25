// REVISION: e2e-config-v2-env-fallback
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

const MODULE_REVISION = "e2e-config-v2-env-fallback";
console.log(
  `[e2e-config] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

// Load committed/shared defaults first, then local fallbacks.
dotenv.config({ path: resolve(__dirname, ".env.test") });
dotenv.config({ path: resolve(__dirname, ".env") });
dotenv.config({
  path: resolve(__dirname, ".env.test.local"),
  override: true,
});

const ORCABOT_URL = process.env.ORCABOT_URL;
const storageStatePath =
  process.env.E2E_STORAGE_STATE || resolve(__dirname, ".auth/orcabot-user.json");
const storageState = existsSync(storageStatePath) ? storageStatePath : undefined;

if (!ORCABOT_URL) {
  throw new Error(
    "ORCABOT_URL environment variable is required.\n" +
      "Set it in e2e/.env, e2e/.env.test.local, or pass it inline.\n" +
      "Example: ORCABOT_URL=https://app.orcabot.com npx playwright test"
  );
}

export default defineConfig({
  testDir: "./recipes",
  outputDir: "./test-results",

  /* Run sequentially — tests share a real instance */
  fullyParallel: false,
  workers: 1,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 1 : 0,

  /* 2 minutes per test (sandbox boot can be slow) */
  timeout: 120_000,

  expect: {
    /* 30s for assertions (WebSocket connections, sandbox boot) */
    timeout: 30_000,
  },

  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "./playwright-report" }],
  ],

  use: {
    baseURL: ORCABOT_URL,
    storageState,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  /* No webServer — we test against an already-running instance */
});
