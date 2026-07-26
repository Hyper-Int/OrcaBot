// REVISION: e2e-auth-flow-v2-ui-login-skip
import { test, expect } from "../fixtures/base";
import { devLoginFormVisible, googleAuthConfigured } from "../fixtures/auth";

const MODULE_REVISION = "e2e-auth-flow-v2-ui-login-skip";
console.log(
  `[e2e-auth-flow] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

test.describe("Recipe: Authentication Flow", () => {
  test("should log in via API and reach dashboards", async ({
    page,
    auth,
    diagnostics,
  }) => {
    await auth.login();
    await expect(page).toHaveURL(/\/dashboards/);
    await diagnostics.collector.assertNoSevereIssues();
  });

  // The dev-mode login form was removed from the splash page in "Add new splash
  // page" (#193) — `loginDevMode` now only runs for desktop auto-login, so on
  // most builds the only UI login left is the Google popup. Skip only when
  // NEITHER strategy is available, rather than deleting the coverage.
  test("should log in via the UI", async ({ page, auth, diagnostics }) => {
    // Must navigate first: the page starts on about:blank, where no locator can
    // ever be visible and the check would skip unconditionally.
    await page.goto("/");

    test.skip(
      !(await devLoginFormVisible(page)) && !googleAuthConfigured(),
      "No dev-mode login form on this build and no Google credentials configured."
    );

    await auth.loginViaUI();
    await expect(page).toHaveURL(/\/dashboards/);
    await diagnostics.collector.assertNoSevereIssues();
  });

  test("should persist auth across page reload", async ({
    page,
    auth,
    diagnostics,
  }) => {
    await auth.login();
    await page.reload();
    // Should still be on dashboards after reload
    await expect(page).toHaveURL(/\/dashboards/);
    await diagnostics.collector.assertNoSevereIssues();
  });

  test("should log out and redirect to splash", async ({
    page,
    auth,
    diagnostics,
  }) => {
    await auth.login();
    await auth.logout();
    // Should be back at splash page with login options visible. The splash CTAs
    // are links ("Sign In", "Get Started Free"), not buttons.
    await expect(
      page
        .getByRole("button", { name: /dev mode login/i })
        .or(page.getByRole("link", { name: /^sign in$/i }))
        .or(page.getByRole("link", { name: /get started/i }))
        .or(page.getByRole("button", { name: /get started/i }))
        .first()
    ).toBeVisible({ timeout: 10_000 });
    await diagnostics.collector.assertNoSevereIssues();
  });
});
