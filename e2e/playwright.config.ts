// REVISION: e2e-config-v4-storage-state-only-ui-auth
import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const MODULE_REVISION = "e2e-config-v4-storage-state-only-ui-auth";
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

/**
 * Pre-authenticated browser session, captured by `npm run auth:capture`.
 *
 * This is the ONLY way to log the browser in on an instance without dev auth.
 * E2E_API_TOKEN is not an alternative here: a PAT authenticates direct
 * control-plane API calls (the `api` fixture) and cannot establish a browser
 * session. Automating Google's password form is deliberately unsupported — see
 * the note at the top of fixtures/auth.ts.
 *
 * Full artifact capture stays on precisely because no password is ever typed.
 */
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
    // "retain-on-failure" records EVERY test and discards the passing ones, so
    // the cost lands on all of them. Measured per-test on this suite:
    //   no artifacts        ~17s   (6.4m / 23 tests)
    //   trace + video       ~50s   (19.3m / 23 tests)
    //   trace only          ~45s   (14.3m / 19 tests)
    // So the trace is the expensive part; dropping video recovered little. Kept
    // anyway because a failure here is usually a slow/racy UI state that a trace
    // explains and a video does not.
    //
    // If this wall clock becomes the bottleneck, switch to "on-first-retry" and
    // set retries: 1 — traces then cost nothing on a first-attempt pass, at the
    // price of reporting flakes as "flaky" rather than failing them.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
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
