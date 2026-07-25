import { test, expect } from "../fixtures/base";
import { readTerminalText, SHELL_PROMPT_RE } from "../fixtures/terminal";

/**
 * Recipe 09 — First-PTY connect flake loop.
 *
 * Reproduces the flaky first terminal on a fresh dashboard, where one of four
 * things happens on that early PTY:
 *   A. looks stuck on "Connecting to sandbox..." but a keypress reveals the
 *      prompt   -> the WS is connected, the initial prompt just never rendered
 *   B. the block disappears after a second and doesn't come back
 *   C. it gets stuck and never resolves
 *   D. it works normally
 *
 * A single `waitForPrompt` run can't see this — the outcome is a race that only
 * shows up as a *rate*. So this loops N fresh dashboards (each a brand-new VM +
 * first PTY), and for each one, WITHOUT sending any input, classifies the
 * outcome:
 *   - "ok"             : a real shell prompt appeared input-free            (D)
 *   - "ok-after-enter" : blank until we pressed Enter, then a prompt showed (A)
 *   - "stuck"          : never showed a prompt, even after Enter            (C)
 *   - "gone"           : the .xterm block vanished mid-connect              (B)
 *
 * Only "ok" is a pass. The Enter probe is what distinguishes A (connected but
 * unrendered) from C (never connected) — the exact split in the bug report.
 *
 * Tunable via env: FIRST_CONNECT_ITERATIONS (default 10),
 * FIRST_CONNECT_TIMEOUT_MS (default 45000). This is a slow, resource-heavy
 * measurement suite (one VM boot per iteration) — run it deliberately, not in
 * the fast lane.
 */

const ITERATIONS = Number(process.env.FIRST_CONNECT_ITERATIONS || 10);
const PROMPT_TIMEOUT = Number(process.env.FIRST_CONNECT_TIMEOUT_MS || 45_000);

type Outcome = "ok" | "ok-after-enter" | "stuck" | "gone" | "error";

test.describe("Recipe: First-PTY connect (flake loop)", () => {
  test.beforeEach(async ({ page, auth }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await auth.login();
  });

  test(`first PTY on a fresh dashboard connects cleanly (${ITERATIONS}x)`, async ({
    page,
    dashboard,
    terminal,
    api,
  }) => {
    // Each iteration boots a VM; give the whole loop generous headroom.
    test.setTimeout((PROMPT_TIMEOUT + 40_000) * ITERATIONS + 60_000);

    const results: { i: number; outcome: Outcome; ms: number }[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = Date.now();
      let outcome: Outcome = "stuck";
      let id = "";

      try {
        // Always return to the dashboards list first. After an API delete the
        // browser is left on a stale /dashboards/<id> URL, and createDashboard's
        // guard (`!url.includes("/dashboards")`) treats that as "already on the
        // list" and never re-navigates to the template picker.
        await page.goto("/dashboards");
        id = await dashboard.create(`E2E-FirstConnect-${i}-${Date.now()}`);
        await terminal.add();

        // Poll for a real prompt WITHOUT sending any input.
        while (Date.now() - t0 < PROMPT_TIMEOUT) {
          if ((await page.locator(".xterm").count()) === 0) {
            outcome = "gone"; // symptom B — the block unmounted mid-connect
            break;
          }
          if (SHELL_PROMPT_RE.test(await readTerminalText(page))) {
            outcome = "ok"; // symptom D — clean input-free connect
            break;
          }
          await page.waitForTimeout(1_000);
        }

        // If still blank, probe whether a keypress reveals the prompt. Enter
        // fixing it == symptom A (connected, initial prompt never rendered);
        // Enter NOT fixing it == symptom C (never really connected).
        if (outcome === "stuck" && (await page.locator(".xterm").count()) > 0) {
          await page.locator(".xterm-screen").first().click();
          await page.waitForTimeout(200);
          await page.keyboard.press("Enter");
          const t1 = Date.now();
          while (Date.now() - t1 < 8_000) {
            if (SHELL_PROMPT_RE.test(await readTerminalText(page))) {
              outcome = "ok-after-enter";
              break;
            }
            await page.waitForTimeout(500);
          }
        }
      } catch (err) {
        // One bad iteration must not abort the whole measurement.
        outcome = "error";
        // eslint-disable-next-line no-console
        console.log(
          `[first-connect] iter ${i} threw: ${
            (err as Error).message.split("\n")[0]
          }`
        );
      } finally {
        // Release the VM/session before the next iteration so only one is live.
        if (id) {
          try {
            await api.client.deleteDashboard(id);
          } catch {
            // dashboard-fixture auto-cleanup catches it at teardown
          }
        }
      }

      results.push({ i, outcome, ms: Date.now() - t0 });
    }

    // Report a rate — the whole point is to measure, not just pass/fail once.
    const tally = results.reduce<Record<string, number>>((a, r) => {
      a[r.outcome] = (a[r.outcome] || 0) + 1;
      return a;
    }, {});
    const clean = results.filter((r) => r.outcome === "ok").length;
    // eslint-disable-next-line no-console
    console.log(
      `[first-connect] ${clean}/${ITERATIONS} clean input-free connects; tally=${JSON.stringify(
        tally
      )}`
    );
    // eslint-disable-next-line no-console
    console.table(results);

    // Every non-"ok" outcome is a first-PTY UX failure (A/B/C all count).
    const failures = results.filter((r) => r.outcome !== "ok");
    expect(
      failures,
      `first-PTY flakes (${failures.length}/${ITERATIONS}): ${JSON.stringify(
        tally
      )}`
    ).toHaveLength(0);
  });
});
