import { test, expect } from "../fixtures/base";

test.describe("Recipe: Dashboard CRUD", () => {
  test.beforeEach(async ({ page, auth }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await auth.login();
  });

  test("should create a blank dashboard", async ({ page, dashboard }) => {
    const id = await dashboard.create("E2E-Blank-Test");

    // Should be on the dashboard page with canvas visible
    await expect(page).toHaveURL(new RegExp(`/dashboards/${id}`));
    await expect(page.locator(".react-flow")).toBeVisible();
  });

  test("should show created dashboard in the list", async ({
    page,
    dashboard,
  }) => {
    const name = `E2E-List-${Date.now()}`;
    await dashboard.create(name);

    // Go back to dashboard list
    await page.goto("/dashboards");
    await page.waitForLoadState("networkidle");

    // Should see the dashboard we just created
    await expect(page.getByText(name)).toBeVisible();
  });

  test("should navigate back to dashboard list from canvas", async ({
    page,
    dashboard,
  }) => {
    await dashboard.create("E2E-Nav-Test");

    // Click the back button (first button in header with an SVG icon)
    await page
      .getByRole("button")
      .filter({ has: page.locator("svg") })
      .first()
      .click();

    await expect(page).toHaveURL(/\/dashboards$/);
  });
});
