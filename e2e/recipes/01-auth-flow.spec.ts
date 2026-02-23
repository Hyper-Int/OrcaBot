import { test, expect } from "../fixtures/base";

test.describe("Recipe: Authentication Flow", () => {
  test("should log in via API and reach dashboards", async ({
    page,
    auth,
  }) => {
    await auth.login();
    await expect(page).toHaveURL(/\/dashboards/);
  });

  test("should log in via dev mode UI form", async ({
    page,
    auth,
  }) => {
    await auth.loginViaUI();
    await expect(page).toHaveURL(/\/dashboards/);
  });

  test("should persist auth across page reload", async ({ page, auth }) => {
    await auth.login();
    await page.reload();
    // Should still be on dashboards after reload
    await expect(page).toHaveURL(/\/dashboards/);
  });

  test("should log out and redirect to splash", async ({ page, auth }) => {
    await auth.login();
    await auth.logout();
    // Should be back at splash page with login options visible
    await expect(
      page
        .getByRole("button", { name: /dev mode login/i })
        .or(page.getByRole("button", { name: /get started/i }))
        .first()
    ).toBeVisible({ timeout: 10_000 });
  });
});
