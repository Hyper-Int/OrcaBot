import { test, expect } from "@playwright/test";

test.describe("Authentication", () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage before each test
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
  });

  test("should redirect to login when not authenticated", async ({ page }) => {
    await page.goto("/dashboards");
    await expect(page).toHaveURL("/login");
  });

  test("should display login page with branding", async ({ page }) => {
    await page.goto("/login");

    // Check for branding
    await expect(page.getByText("Hyper")).toBeVisible();
    await expect(
      page.getByText("Terminal-first, multiplayer agentic coding")
    ).toBeVisible();

    // Check for login options
    await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /dev mode/i })).toBeVisible();
  });

  test("should allow dev mode login", async ({ page }) => {
    await page.goto("/login");

    // Click dev mode login
    await page.getByRole("button", { name: /dev mode/i }).click();

    // Fill in dev mode form
    await page.getByPlaceholder("Your name").fill("Test User");
    await page.getByPlaceholder("Your email").fill("test@example.com");

    // Submit
    await page.getByRole("button", { name: /continue/i }).click();

    // Should redirect to dashboards
    await expect(page).toHaveURL("/dashboards");
  });

  test("should persist auth after dev mode login", async ({ page }) => {
    await page.goto("/login");

    // Dev mode login
    await page.getByRole("button", { name: /dev mode/i }).click();
    await page.getByPlaceholder("Your name").fill("Test User");
    await page.getByPlaceholder("Your email").fill("test@example.com");
    await page.getByRole("button", { name: /continue/i }).click();

    // Wait for redirect
    await expect(page).toHaveURL("/dashboards");

    // Refresh page
    await page.reload();

    // Should still be on dashboards (authenticated)
    await expect(page).toHaveURL("/dashboards");
  });

  test("should allow logout", async ({ page }) => {
    // First login
    await page.goto("/login");
    await page.getByRole("button", { name: /dev mode/i }).click();
    await page.getByPlaceholder("Your name").fill("Test User");
    await page.getByPlaceholder("Your email").fill("test@example.com");
    await page.getByRole("button", { name: /continue/i }).click();
    await expect(page).toHaveURL("/dashboards");

    // Find and click logout button
    await page.getByRole("button", { name: /logout/i }).click();

    // Should redirect to login
    await expect(page).toHaveURL("/login");
  });

  test("dev mode form should require name and email", async ({ page }) => {
    await page.goto("/login");

    // Click dev mode login
    await page.getByRole("button", { name: /dev mode/i }).click();

    // Try to submit without filling form
    const continueButton = page.getByRole("button", { name: /continue/i });

    // Button should be disabled when fields are empty
    await expect(continueButton).toBeDisabled();

    // Fill only name
    await page.getByPlaceholder("Your name").fill("Test User");
    await expect(continueButton).toBeDisabled();

    // Fill only email (clear name first)
    await page.getByPlaceholder("Your name").clear();
    await page.getByPlaceholder("Your email").fill("test@example.com");
    await expect(continueButton).toBeDisabled();

    // Fill both
    await page.getByPlaceholder("Your name").fill("Test User");
    await expect(continueButton).toBeEnabled();
  });
});
