import { test, expect } from "../fixtures/base";

test.describe("Recipe: Integration Blocks on Canvas", () => {
  test.beforeEach(async ({ page, auth }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await auth.login();
  });

  test("should add a Gmail block from the toolbar", async ({
    page,
    dashboard,
  }) => {
    await dashboard.create("E2E-Gmail-Block");

    // Click the Gmail toolbar button
    await page.locator('[data-guidance-target="gmail"]').click();

    // A new node should appear on the canvas
    // React Flow renders nodes as divs inside .react-flow__nodes
    // Wait for the node to be present
    await expect(
      page.locator(".react-flow__node").filter({ hasText: /gmail/i })
    ).toBeVisible({ timeout: 5_000 });
  });

  test("should add a Calendar block from the toolbar", async ({
    page,
    dashboard,
  }) => {
    await dashboard.create("E2E-Calendar-Block");

    await page.locator('[data-guidance-target="calendar"]').click();

    await expect(
      page.locator(".react-flow__node").filter({ hasText: /calendar/i })
    ).toBeVisible({ timeout: 5_000 });
  });

  test("should add a Slack block from the toolbar", async ({
    page,
    dashboard,
  }) => {
    await dashboard.create("E2E-Slack-Block");

    await page.locator('[data-guidance-target="slack"]').click();

    await expect(
      page.locator(".react-flow__node").filter({ hasText: /slack/i })
    ).toBeVisible({ timeout: 5_000 });
  });

  test("should add multiple integration blocks to the same canvas", async ({
    page,
    dashboard,
  }) => {
    await dashboard.create("E2E-Multi-Integration");

    // Add Gmail
    await page.locator('[data-guidance-target="gmail"]').click();
    await expect(
      page.locator(".react-flow__node").filter({ hasText: /gmail/i })
    ).toBeVisible({ timeout: 5_000 });

    // Add Slack
    await page.locator('[data-guidance-target="slack"]').click();
    await expect(
      page.locator(".react-flow__node").filter({ hasText: /slack/i })
    ).toBeVisible({ timeout: 5_000 });

    // Add Discord
    await page.locator('[data-guidance-target="discord"]').click();
    await expect(
      page.locator(".react-flow__node").filter({ hasText: /discord/i })
    ).toBeVisible({ timeout: 5_000 });

    // Should have at least 3 nodes on the canvas
    const nodeCount = await page.locator(".react-flow__node").count();
    expect(nodeCount).toBeGreaterThanOrEqual(3);
  });

  test("should add a Note block alongside integration blocks", async ({
    page,
    dashboard,
  }) => {
    await dashboard.create("E2E-Mixed-Blocks");

    // Add a note
    await page.locator('[data-guidance-target="note"]').click();
    await expect(
      page.locator(".react-flow__node").filter({ hasText: /note/i })
    ).toBeVisible({ timeout: 5_000 });

    // Add Gmail
    await page.locator('[data-guidance-target="gmail"]').click();
    await expect(
      page.locator(".react-flow__node").filter({ hasText: /gmail/i })
    ).toBeVisible({ timeout: 5_000 });

    // Both should coexist
    const nodeCount = await page.locator(".react-flow__node").count();
    expect(nodeCount).toBeGreaterThanOrEqual(2);
  });

  test("should delete an integration block via context menu", async ({
    page,
    dashboard,
  }) => {
    await dashboard.create("E2E-Delete-Integration");

    // Add Gmail block
    await page.locator('[data-guidance-target="gmail"]').click();
    const gmailNode = page
      .locator(".react-flow__node")
      .filter({ hasText: /gmail/i });
    await expect(gmailNode).toBeVisible({ timeout: 5_000 });

    // Select the node by clicking on it
    await gmailNode.click();

    // Press Delete or Backspace to remove the selected node
    await page.keyboard.press("Backspace");

    // Gmail node should be gone (or there should be a confirmation)
    // Give a moment for deletion or dialog to appear
    await page.waitForTimeout(1_000);

    // Check if it was deleted or if a confirmation dialog appeared
    const dialogVisible = await page
      .getByRole("dialog")
      .isVisible()
      .catch(() => false);

    if (dialogVisible) {
      // Confirm deletion
      await page.getByRole("button", { name: /delete/i }).click();
    }

    // The gmail node should now be gone
    await expect(gmailNode).not.toBeVisible({ timeout: 5_000 });
  });
});
