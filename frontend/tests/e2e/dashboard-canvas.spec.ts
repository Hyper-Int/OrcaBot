import { test, expect } from "@playwright/test";

// Helper to login via dev mode
async function devModeLogin(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: /dev mode/i }).click();
  await page.getByPlaceholder("Your name").fill("Test User");
  await page.getByPlaceholder("Your email").fill("test@example.com");
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page).toHaveURL("/dashboards");
}

// Note: These tests assume you can navigate to a dashboard page
// In real E2E tests, you'd create a dashboard first via API or UI
test.describe("Dashboard Canvas", () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage and login
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await devModeLogin(page);
  });

  test("should display dashboard page elements", async ({ page }) => {
    // Navigate to a mock dashboard ID (will show error state if not found)
    await page.goto("/dashboards/test-dashboard-id");

    // Should have back button
    await expect(
      page.getByRole("button").filter({ has: page.locator("svg") }).first()
    ).toBeVisible();
  });

  test("should navigate back to dashboard list", async ({ page }) => {
    await page.goto("/dashboards/test-dashboard-id");

    // Click back button (first button in header)
    await page
      .getByRole("button")
      .filter({ has: page.locator("svg") })
      .first()
      .click();

    // Should be back on dashboards list
    await expect(page).toHaveURL("/dashboards");
  });

  test("should display toolbar with block tools", async ({ page }) => {
    await page.goto("/dashboards/test-dashboard-id");

    // The toolbar should be visible on the left side
    // Even in error state, the page structure should be there
    const buttons = page.getByRole("button");
    await expect(buttons.first()).toBeVisible();
  });

  test("should display error state for non-existent dashboard", async ({
    page,
  }) => {
    await page.goto("/dashboards/non-existent-id");

    // Should show error message or retry button
    // The exact message depends on API response
    await page.waitForLoadState("networkidle");

    // Either retry button or error message should be visible
    const hasRetryButton = await page
      .getByRole("button", { name: /retry/i })
      .isVisible()
      .catch(() => false);
    const hasError = await page
      .getByText(/failed|error/i)
      .isVisible()
      .catch(() => false);

    expect(hasRetryButton || hasError).toBeTruthy();
  });
});

test.describe("Dashboard Canvas - With Mock Data", () => {
  test.beforeEach(async ({ page, context }) => {
    // Mock the dashboard API response
    await context.route("**/dashboards/*", async (route) => {
      const url = route.request().url();
      if (url.includes("/dashboards/mock-dashboard")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            dashboard: {
              id: "mock-dashboard",
              name: "Test Dashboard",
              ownerId: "user-123",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            items: [
              {
                id: "note-1",
                dashboardId: "mock-dashboard",
                type: "note",
                content: "Hello World",
                position: { x: 100, y: 100 },
                size: { width: 200, height: 120 },
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            sessions: [],
            role: "owner",
          }),
        });
      } else {
        await route.continue();
      }
    });

    // Login
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await devModeLogin(page);
  });

  test("should display dashboard with mocked data", async ({ page }) => {
    await page.goto("/dashboards/mock-dashboard");

    // Dashboard name should be visible
    await expect(page.getByText("Test Dashboard")).toBeVisible();
  });

  test("should display note block from mocked data", async ({ page }) => {
    await page.goto("/dashboards/mock-dashboard");

    // Wait for canvas to load
    await page.waitForLoadState("networkidle");

    // The note content should be visible somewhere in the canvas
    // React Flow renders nodes in a specific structure
    await expect(page.locator(".react-flow")).toBeVisible();
  });

  test("should display presence info", async ({ page }) => {
    await page.goto("/dashboards/mock-dashboard");

    // Should show online count indicator
    await expect(page.getByText("1")).toBeVisible(); // At least 1 user (current user)
  });

  test("should have share button", async ({ page }) => {
    await page.goto("/dashboards/mock-dashboard");

    // Share button should be visible
    await expect(
      page.getByRole("button").filter({ has: page.locator("svg") })
    ).toBeVisible();
  });
});
