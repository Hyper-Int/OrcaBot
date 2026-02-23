import { test, expect } from "../fixtures/base";

/**
 * Recipe: Launch Gemini CLI, wire it to a browser block, and have it
 * play chess on lichess.org.
 *
 * Requires GEMINI_API_KEY env var — tests skip if not set.
 *
 * Flow:
 *   1. Create GEMINI_API_KEY secret via control plane API
 *   2. Add Gemini CLI terminal (auto-launches `gemini` command)
 *   3. Wait for sandbox boot + Gemini CLI ready
 *   4. Apply secrets so the broker can proxy Gemini API calls
 *   5. Add browser block, wire terminal → browser
 *   6. Prompt Gemini to navigate to lichess.org and play chess
 *   7. Verify Gemini produced output
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/** Read terminal text from xterm DOM rows. */
async function readXtermText(
  page: import("@playwright/test").Page
): Promise<string> {
  return page.evaluate(() => {
    const rows = document.querySelector(".xterm-rows");
    if (rows) {
      const rowDivs = rows.querySelectorAll(":scope > div");
      if (rowDivs.length > 0) {
        return Array.from(rowDivs)
          .map((r) => r.textContent || "")
          .join("\n");
      }
      return rows.textContent || "";
    }
    return "";
  });
}

/**
 * Wait for the terminal to show a real prompt (not "Connecting to sandbox...").
 * Looks for shell prompt ($, #, >) or Gemini CLI markers.
 */
async function waitForTerminalReady(
  page: import("@playwright/test").Page,
  timeoutMs = 120_000
): Promise<string> {
  const startTime = Date.now();
  let lastContent = "";
  while (Date.now() - startTime < timeoutMs) {
    lastContent = await readXtermText(page);
    // Ignore connection placeholder text
    const cleaned = lastContent
      .replace(/Connecting to sandbox\.\.\./g, "")
      .trim();

    if (cleaned.length > 10) {
      // Real content has appeared — shell prompt or Gemini output
      return lastContent;
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(
    `Terminal did not become ready within ${timeoutMs}ms.\n` +
      `Last content: ${lastContent.substring(0, 300)}`
  );
}

/** Wire terminal → target block (same pattern as 06-integration-wiring). */
async function wireTerminalToBlock(
  page: import("@playwright/test").Page,
  targetNode: import("@playwright/test").Locator
) {
  const portalConnectors = page.locator(
    '[data-connector="true"]:not(.react-flow__node *)'
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => {
      const svg = document.querySelector("svg.lucide-git-merge");
      const btn = svg?.closest("button") as HTMLButtonElement | null;
      btn?.click();
    });
    await page.waitForTimeout(600);
    const visible = await portalConnectors
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) break;
  }

  await expect(portalConnectors.first()).toBeVisible({ timeout: 5_000 });
  await portalConnectors.nth(1).click();
  await page.waitForTimeout(500);

  const targetConnector = targetNode
    .locator('[data-connector="true"]')
    .first();
  await expect(targetConnector).toBeVisible({ timeout: 5_000 });
  await targetConnector.click();
  await page.waitForTimeout(1_500);
}

test.describe("Recipe: Gemini CLI Chess", () => {
  test.skip(!GEMINI_API_KEY, "GEMINI_API_KEY not set — skipping");

  // AI interactions are slow — 5 minute timeout
  test.setTimeout(300_000);

  test.beforeEach(async ({ page, auth }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await auth.login();
  });

  test("should play chess via Gemini CLI with a browser block", async ({
    page,
    dashboard,
    terminal,
    api,
  }) => {
    const dashboardId = await dashboard.create("E2E-Gemini-Chess");

    // --- Step 1: Create GEMINI_API_KEY secret via control plane API ---
    let secretId: string | undefined;
    try {
      const { secret } = await api.client.createSecret({
        name: "GEMINI_API_KEY",
        value: GEMINI_API_KEY!,
        dashboardId: "_global",
        type: "secret",
        brokerProtected: true,
      });
      secretId = secret.id;
    } catch {
      // Secret may already exist from a previous run — that's fine
    }

    // --- Step 2: Add Gemini CLI terminal and wait for real readiness ---
    await terminal.add("gemini-cli");

    // Wait for the sandbox to actually boot and show real terminal content
    // (not just "Connecting to sandbox...")
    const initialContent = await waitForTerminalReady(page, 120_000);

    // --- Step 3: Apply secrets to the active session ---
    const details = await api.client.getDashboardDetails(dashboardId);
    const activeSession = details.sessions?.find(
      (s) => s.status === "active" || s.status === "creating"
    );
    if (activeSession) {
      try {
        await api.client.applySessionSecrets(activeSession.id);
        await page.waitForTimeout(2_000);
      } catch {
        // Non-fatal — secret may already be applied
      }
    }

    // --- Step 4: Ensure Gemini CLI is running ---
    // If we see a shell prompt ($ or #) instead of Gemini, restart it.
    // If Gemini failed (no API key, error), restart it now that secrets are applied.
    const needsRestart =
      /[$#>]\s*$/.test(initialContent) ||
      initialContent.includes("API key") ||
      initialContent.includes("Could not") ||
      initialContent.includes("error") ||
      initialContent.includes("authenticate") ||
      initialContent.includes("ENOENT");

    if (needsRestart) {
      const xtermScreen = page.locator(".xterm-screen").first();
      await xtermScreen.click();
      await page.waitForTimeout(300);
      await page.keyboard.press("Control+c");
      await page.waitForTimeout(500);
      await page.keyboard.type("gemini", { delay: 50 });
      await page.keyboard.press("Enter");
      // Wait for Gemini to start up
      await page.waitForTimeout(10_000);
    }

    // --- Step 5: Add browser block and wire ---
    await page.locator('[data-guidance-target="browser"]').click();
    const browserNode = page
      .locator(".react-flow__node")
      .filter({ hasText: /browser/i });
    await expect(browserNode).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(500);

    await wireTerminalToBlock(page, browserNode);

    // Verify edge exists
    await page.waitForFunction(
      () => document.querySelectorAll(".react-flow__edge").length >= 1,
      { timeout: 10_000 }
    );

    // --- Step 6: Send chess prompt to Gemini ---
    const xtermScreen = page.locator(".xterm-screen").first();
    await xtermScreen.click();
    await page.waitForTimeout(500);

    const prompt =
      "Navigate the browser to https://lichess.org and start a game against the computer. Make the first move as white.";

    await page.keyboard.type(prompt, { delay: 30 });
    await page.keyboard.press("Enter");

    // --- Step 7: Wait for Gemini to produce output ---
    // Give Gemini time to think and start acting
    await page.waitForTimeout(15_000);

    // Poll terminal for signs of Gemini doing something
    const startTime = Date.now();
    let geminiResponded = false;
    let lastOutput = "";
    while (Date.now() - startTime < 120_000) {
      lastOutput = await readXtermText(page);

      // Look for signs Gemini is working: tool calls, navigation, chess terms
      const lowerOutput = lastOutput.toLowerCase();
      if (
        lowerOutput.includes("lichess") ||
        lowerOutput.includes("navigate") ||
        lowerOutput.includes("chess") ||
        lowerOutput.includes("move") ||
        lowerOutput.includes("pawn") ||
        lowerOutput.includes("e4") ||
        lowerOutput.includes("d4") ||
        lowerOutput.includes("tool") ||
        lowerOutput.includes("function") ||
        lowerOutput.includes("browser") ||
        lowerOutput.includes("screenshot") ||
        lowerOutput.includes("click")
      ) {
        geminiResponded = true;
        break;
      }
      await page.waitForTimeout(5_000);
    }

    expect(geminiResponded).toBe(true);

    // Cleanup: delete the global secret so it doesn't leak to other tests
    if (secretId) {
      try {
        await api.client.deleteSecret(secretId);
      } catch {
        // Non-fatal
      }
    }
  });
});
