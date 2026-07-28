// REVISION: e2e-capture-auth-v1-manual-storage-state
/**
 * Capture a logged-in browser session for the e2e suite.
 *
 * Replaces automating Google's password form, which cannot be done safely:
 * Playwright puts action parameters into step titles (`Fill "<password>" ...`),
 * and those titles are serialized into the HTML report even for passing tests,
 * independently of trace/video settings.
 *
 * Here you log in by hand — SSO, 2FA, hardware key, whatever the account needs —
 * and only the resulting cookies/localStorage are written to disk. No password
 * is ever typed by Playwright, so none can reach an artifact.
 *
 *   npm run auth:capture
 *   ORCABOT_URL=https://dev.orcabot.com npm run auth:capture
 *
 * The output path matches what playwright.config.ts loads by default; override
 * with E2E_STORAGE_STATE on both capture and run.
 *
 * The saved file IS credential material (live session cookies). e2e/.auth/ is
 * gitignored — keep it that way, and re-run this when the session expires.
 *
 * Plain .mjs on purpose: the suite has no TypeScript runner, and this must work
 * with nothing installed beyond the existing devDependencies.
 */
import { chromium } from "@playwright/test";
import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const MODULE_REVISION = "e2e-capture-auth-v1-manual-storage-state";
console.log(
  `[e2e-capture-auth] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Same precedence as playwright.config.ts: the real environment always wins.
const PRESET_ENV_KEYS = new Set(Object.keys(process.env));
for (const file of [".env.test", ".env", ".env.test.local"]) {
  const path = resolve(E2E_DIR, file);
  if (!existsSync(path)) continue;
  for (const [key, value] of Object.entries(dotenv.parse(readFileSync(path)))) {
    if (PRESET_ENV_KEYS.has(key)) continue;
    process.env[key] = value;
  }
}

const ORCABOT_URL = process.env.ORCABOT_URL;
if (!ORCABOT_URL) {
  console.error(
    "ORCABOT_URL is required.\n" +
      "Example: ORCABOT_URL=https://dev.orcabot.com npm run auth:capture"
  );
  process.exit(1);
}

const storageStatePath =
  process.env.E2E_STORAGE_STATE || resolve(E2E_DIR, ".auth/orcabot-user.json");

async function main() {
  console.log(`\nOpening ${ORCABOT_URL} …`);
  console.log("Log in in the browser window. Leave it open until you land on");
  console.log("the dashboards page — the session saves automatically.\n");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(ORCABOT_URL, { waitUntil: "domcontentloaded" });

  // Wait for the dashboards route, however the user gets there. Generous
  // timeout: a human may need to fetch a 2FA code.
  const LOGIN_TIMEOUT_MS = 5 * 60_000;
  try {
    await page.waitForURL(/\/dashboards/, { timeout: LOGIN_TIMEOUT_MS });
  } catch {
    console.error(
      "\nTimed out waiting for /dashboards — nothing was saved.\n" +
        "Re-run and complete the login within 5 minutes."
    );
    await browser.close();
    process.exit(1);
  }

  // Let the app settle so the auth state is fully written before we snapshot.
  await page
    .getByRole("heading", { name: "New Dashboard", exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => {
      console.warn(
        "Reached /dashboards but the dashboard list did not render; saving anyway."
      );
    });

  mkdirSync(dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
  await browser.close();

  console.log(`\nSaved session to ${storageStatePath}`);
  console.log("Treat it as a credential — it is gitignored; do not commit or share it.");
  console.log("The suite will now pick it up automatically.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
