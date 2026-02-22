import { test, expect } from "../fixtures/base";

test.describe("Recipe: Terminal Block", () => {
  test.beforeEach(async ({ page, auth }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await auth.login();
  });

  test("should add a terminal block to the canvas", async ({
    page,
    dashboard,
    terminal,
  }) => {
    await dashboard.create("E2E-Terminal-Add");
    await terminal.add();

    // Terminal block should be visible with xterm container
    await expect(page.locator(".xterm")).toBeVisible();
  });

  test("should connect to sandbox and show shell prompt", async ({
    page,
    dashboard,
    terminal,
  }) => {
    await dashboard.create("E2E-Terminal-Connect");
    await terminal.add();

    // Wait for sandbox to boot and terminal to connect
    // This is the key integration test — exercises Fly machine boot,
    // session creation, WebSocket connection, and PTY initialization
    await terminal.waitForPrompt();

    // Verify terminal has meaningful content
    const content = await page
      .locator(".xterm-rows")
      .first()
      .textContent();
    expect(content).toBeTruthy();
    expect(content!.trim().length).toBeGreaterThan(0);
  });
});
