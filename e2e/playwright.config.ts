import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { resolve } from "path";

// Load env vars from .env.test (API keys, ORCABOT_URL, etc.)
dotenv.config({ path: resolve(__dirname, ".env.test") });

const ORCABOT_URL = process.env.ORCABOT_URL;
if (!ORCABOT_URL) {
  throw new Error(
    "ORCABOT_URL environment variable is required.\n" +
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
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
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
