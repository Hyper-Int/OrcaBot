// REVISION: e2e-config-v3-env-precedence-and-trace-safety
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const MODULE_REVISION = "e2e-config-v3-env-precedence-and-trace-safety";
console.log(
  `[e2e-config] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

/**
 * Environment precedence, highest first:
 *   1. the real environment — `ORCABOT_URL=... npx playwright test`, CI vars
 *   2. .env.test.local  (personal overrides, gitignored)
 *   3. .env             (personal defaults, gitignored)
 *   4. .env.test        (shared defaults)
 *
 * Applied by hand rather than with dotenv's `override: true`, which replaces
 * values already in process.env. That would silently beat an inline
 * ORCABOT_URL — pointing a run at the wrong instance despite the documented
 * invocation below — and could also overwrite injected credentials or `CI`
 * itself, which drives `forbidOnly` and `retries`.
 */
const ENV_FILES_LOWEST_FIRST = [".env.test", ".env", ".env.test.local"];
const PRESET_ENV_KEYS = new Set(Object.keys(process.env));

for (const file of ENV_FILES_LOWEST_FIRST) {
  const path = resolve(__dirname, file);
  if (!existsSync(path)) continue;
  const parsed = dotenv.parse(readFileSync(path));
  for (const [key, value] of Object.entries(parsed)) {
    // Never touch a key the real environment already set.
    if (PRESET_ENV_KEYS.has(key)) continue;
    // Later files outrank earlier ones.
    process.env[key] = value;
  }
}

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

/**
 * Password-based Google login types GOOGLE_TEST_PASSWORD into the login popup.
 *
 * Playwright records action parameters — including the string passed to
 * locator.fill() — into the trace, so with traces retained on failure any
 * failure after that point would persist the password inside trace.zip, which
 * then travels wherever CI artifacts go. Capturing a credential is worse than
 * losing a trace, so artifact capture is disabled while this strategy is armed.
 *
 * Prefer E2E_STORAGE_STATE (saved browser session) or E2E_API_TOKEN (PAT), which
 * need no password and keep full tracing.
 */
const passwordLoginEnabled = Boolean(
  process.env.GOOGLE_TEST_EMAIL && process.env.GOOGLE_TEST_PASSWORD
);

if (passwordLoginEnabled) {
  console.warn(
    "[e2e-config] GOOGLE_TEST_PASSWORD is set — traces and video are DISABLED " +
      "so the password cannot be recorded into artifacts. Use E2E_STORAGE_STATE " +
      "or E2E_API_TOKEN to keep full debugging output."
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
    trace: passwordLoginEnabled ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: passwordLoginEnabled ? "off" : "retain-on-failure",
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
