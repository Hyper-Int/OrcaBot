// REVISION: e2e-auth-flow-v2-ui-login-skip
import { test, expect } from "../fixtures/base";
import { devLoginFormVisible } from "../fixtures/auth";

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
  // page" (#193) — `loginDevMode` now only runs for desktop auto-login. The only
  // other UI login is Google, which is deliberately not automated (it would put
  // the password into Playwright step titles, and those reach the HTML report).
  // So this covers the dev-mode form where it exists, and skips where it doesn't
  // rather than being deleted.
  test("should log in via the UI", async ({ page, auth, diagnostics }) => {
    // Must navigate first: the page starts on about:blank, where no locator can
    // ever be visible and the check would skip unconditionally.
    await page.goto("/");

    test.skip(
      !(await devLoginFormVisible(page)),
      "This build has no dev-mode login form; Google login is not automated."
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
