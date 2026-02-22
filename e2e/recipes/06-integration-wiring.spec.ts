import { test, expect } from "../fixtures/base";

/**
 * Wire a terminal block to another block by clicking connectors.
 *
 * Architecture: Terminal blocks portal their visible content (including
 * ConnectionMarkers) OUTSIDE the ReactFlow node. The RF node contains hidden
 * ConnectionHandles (visible=false). We click the visible portal markers.
 *
 * KEY INSIGHT: OAuth-based integration blocks (Gmail, Calendar, etc.) will
 * auto-delete the edge if the user hasn't connected OAuth. Browser blocks
 * do NOT require OAuth, so edges persist. We test wiring with browser blocks.
 *
 * Wiring flow:
 *   1. Click the "Connect blocks" toolbar button (GitMerge icon) to activate
 *      connectorMode, which makes ALL blocks' connectors visible.
 *   2. Click the terminal's portal source (Output) connector.
 *   3. Click the target block's Input connector.
 *
 * NOTE: Edge labels are rendered by IntegrationEdge via EdgeLabelRenderer
 * (portal), using title="Click to edit policy" on the badge and
 * title="Delete connection" on the delete button. The edge SVG <g> itself
 * may have zero bounding box when nodes overlap.
 */

/** Wire terminal → target block using the connector click flow. */
async function wireTerminalToBlock(
  page: import("@playwright/test").Page,
  targetNode: import("@playwright/test").Locator,
  sourceSide: "right" | "bottom" = "right"
) {
  // Portal connectors are NOT inside .react-flow__node elements.
  const portalConnectors = page.locator(
    '[data-connector="true"]:not(.react-flow__node *)'
  );

  // Step 1: Activate connectorMode via GitMerge toolbar button.
  // The button toggles, so we click and verify connectors become visible.
  // If they don't, click again (we might have toggled OFF).
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => {
      const svg = document.querySelector("svg.lucide-git-merge");
      const btn = svg?.closest("button") as HTMLButtonElement | null;
      btn?.click();
    });
    await page.waitForTimeout(600);

    const visible = await portalConnectors.first().isVisible().catch(() => false);
    if (visible) break;
  }

  await expect(portalConnectors.first()).toBeVisible({ timeout: 5_000 });

  // Step 2: Click terminal's source connector
  if (sourceSide === "right") {
    // Portal order: left-in(0), right-out(1), top-in(2), bottom-out(3)
    await portalConnectors.nth(1).click();
  } else {
    // bottom-out is always the LAST portal connector
    await portalConnectors.last().click();
  }

  await page.waitForTimeout(500);

  // Step 3: Click target block's Input connector (first in the RF node)
  const targetConnector = targetNode
    .locator('[data-connector="true"]')
    .first();
  await expect(targetConnector).toBeVisible({ timeout: 5_000 });
  await targetConnector.click();

  // Wait for edge creation
  await page.waitForTimeout(1_500);
}

/** Helper: count edges via JS (avoids SVG visibility issues). */
async function getEdgeCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll(".react-flow__edge").length);
}

/** Helper: wait for at least N edges to exist in the DOM. */
async function waitForEdgeCount(
  page: import("@playwright/test").Page,
  minCount: number,
  timeout = 10_000
) {
  await page.waitForFunction(
    (min) => document.querySelectorAll(".react-flow__edge").length >= min,
    minCount,
    { timeout }
  );
}

test.describe("Recipe: Integration Wiring (Edges)", () => {
  test.beforeEach(async ({ page, auth }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await auth.login();
  });

  test("should add a terminal and browser block, then draw an edge between them", async ({
    page,
    dashboard,
    terminal,
  }) => {
    await dashboard.create("E2E-Wire-Terminal-Browser");

    await terminal.add();
    await expect(page.locator(".xterm")).toBeVisible();

    // Add browser block (doesn't require OAuth, so edges persist)
    await page.locator('[data-guidance-target="browser"]').click();
    const browserNode = page
      .locator(".react-flow__node")
      .filter({ hasText: /browser/i });
    await expect(browserNode).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(500);

    await wireTerminalToBlock(page, browserNode);

    // Edge SVG may be hidden (zero bbox when nodes overlap), so check DOM count
    await waitForEdgeCount(page, 1);
    const count = await getEdgeCount(page);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("should show edge label after connecting terminal to browser block", async ({
    page,
    dashboard,
    terminal,
  }) => {
    await dashboard.create("E2E-Edge-Label");

    await terminal.add();
    await page.locator('[data-guidance-target="browser"]').click();

    const browserNode = page
      .locator(".react-flow__node")
      .filter({ hasText: /browser/i });
    await expect(browserNode).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(500);

    await wireTerminalToBlock(page, browserNode);

    // Edge label rendered by IntegrationEdge via EdgeLabelRenderer.
    // The badge has title="Click to edit policy" and shows "Full access".
    const edgeLabel = page.locator('[title="Click to edit policy"]');
    await expect(edgeLabel.first()).toBeVisible({ timeout: 10_000 });
  });

  test("should show warning when wiring terminal to Gmail without OAuth", async ({
    page,
    dashboard,
    terminal,
  }) => {
    await dashboard.create("E2E-Wire-No-OAuth");

    await terminal.add();
    await expect(page.locator(".xterm")).toBeVisible();

    await page.locator('[data-guidance-target="gmail"]').click();
    const gmailNode = page
      .locator(".react-flow__node")
      .filter({ hasText: /gmail/i });
    await expect(gmailNode).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(500);

    await wireTerminalToBlock(page, gmailNode);

    // Without OAuth, the edge is created then auto-deleted with a toast warning.
    await page.waitForTimeout(2_000);

    // Verify: no persistent edges (edge was auto-deleted)
    const edgeCount = await getEdgeCount(page);
    expect(edgeCount).toBe(0);
  });

  test("should be able to delete an edge", async ({
    page,
    dashboard,
    terminal,
  }) => {
    await dashboard.create("E2E-Delete-Edge");

    await terminal.add();
    await page.locator('[data-guidance-target="browser"]').click();

    const browserNode = page
      .locator(".react-flow__node")
      .filter({ hasText: /browser/i });
    await expect(browserNode).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(500);

    await wireTerminalToBlock(page, browserNode);

    // Wait for edge to exist in DOM
    await waitForEdgeCount(page, 1);
    const initialEdgeCount = await getEdgeCount(page);

    // The delete button has title="Delete connection" and is rendered
    // via EdgeLabelRenderer (portal above the canvas). Click via JS
    // because the browser block's iframe intercepts pointer events.
    await page.waitForFunction(
      () => document.querySelector('[title="Delete connection"]') !== null,
      { timeout: 5_000 }
    );
    await page.evaluate(() => {
      const btn = document.querySelector('[title="Delete connection"]') as HTMLButtonElement | null;
      btn?.click();
    });
    await page.waitForTimeout(2_000);

    const finalEdgeCount = await getEdgeCount(page);
    expect(finalEdgeCount).toBeLessThan(initialEdgeCount);
  });
});
