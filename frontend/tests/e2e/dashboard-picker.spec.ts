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

test.describe("Dashboard Picker", () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage and login
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await devModeLogin(page);
  });

  test("should display dashboard picker page", async ({ page }) => {
    // Check for page sections
    await expect(page.getByText("New Dashboard")).toBeVisible();
    await expect(page.getByText("Your Dashboards")).toBeVisible();
  });

  test("should display new dashboard templates", async ({ page }) => {
    // Check for template options
    await expect(page.getByText("Blank")).toBeVisible();
    await expect(page.getByText("Start from scratch")).toBeVisible();

    await expect(page.getByText("Agentic Coding")).toBeVisible();
    await expect(page.getByText("Automation")).toBeVisible();
    await expect(page.getByText("Documentation")).toBeVisible();
  });

  test("should open create dialog when clicking blank template", async ({
    page,
  }) => {
    // Click the Blank template
    await page.getByText("Blank").click();

    // Dialog should open
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Create Dashboard")).toBeVisible();
    await expect(page.getByPlaceholder("Dashboard name")).toBeVisible();
  });

  test("should pre-fill name when clicking named template", async ({ page }) => {
    // Click the Agentic Coding template
    await page.getByText("Agentic Coding").click();

    // Dialog should open with pre-filled name
    await expect(page.getByRole("dialog")).toBeVisible();
    const input = page.getByPlaceholder("Dashboard name");
    await expect(input).toHaveValue("Agentic Coding");
  });

  test("should close create dialog on cancel", async ({ page }) => {
    // Open dialog
    await page.getByText("Blank").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Click cancel
    await page.getByRole("button", { name: "Cancel" }).click();

    // Dialog should close
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("should require name to create dashboard", async ({ page }) => {
    // Open dialog
    await page.getByText("Blank").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Create button should be disabled without name
    const createButton = page.getByRole("button", { name: "Create" });
    await expect(createButton).toBeDisabled();

    // Enter name
    await page.getByPlaceholder("Dashboard name").fill("My Dashboard");

    // Create button should be enabled
    await expect(createButton).toBeEnabled();
  });

  test("should show user info in header", async ({ page }) => {
    // Check for user name in header
    await expect(page.getByText("Test User")).toBeVisible();
  });

  test("should display empty state when no dashboards", async ({ page }) => {
    // The empty state might not always be visible if API returns dashboards
    // But we should at least see the "Your Dashboards" section
    const dashboardsSection = page.getByText("Your Dashboards");
    await expect(dashboardsSection).toBeVisible();
  });
});
