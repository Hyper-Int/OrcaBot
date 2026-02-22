import { type Page, expect } from "@playwright/test";

/**
 * Dismiss the "Welcome to Orcabot" onboarding dialog if it appears.
 * This dialog shows on first visit to a dashboard canvas and blocks
 * interaction with the toolbar and canvas underneath.
 */
async function dismissOnboardingDialog(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /welcome/i });

  try {
    await dialog.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    // No onboarding dialog appeared, nothing to dismiss
    return;
  }

  // Click the "Close" button inside the dialog
  const closeBtn = dialog.getByRole("button", { name: /close/i });
  await closeBtn.click();

  // Wait for dialog to disappear
  await dialog.waitFor({ state: "hidden", timeout: 3_000 });
}

/**
 * Create a blank dashboard via the UI.
 * Assumes the user is already logged in and on /dashboards.
 * Returns the dashboard ID extracted from the URL.
 */
export async function createDashboard(
  page: Page,
  name?: string
): Promise<string> {
  const dashboardName = name ?? `E2E-${Date.now()}`;

  // Make sure we're on the dashboards page
  if (!page.url().includes("/dashboards")) {
    await page.goto("/dashboards");
  }
  await page.waitForLoadState("networkidle");

  // Click the "Blank" template card
  await page.getByText("Blank", { exact: true }).first().click();

  // Dialog should open
  await expect(page.getByRole("dialog")).toBeVisible();

  // Fill in dashboard name
  await page.getByPlaceholder("Dashboard name").fill(dashboardName);

  // Click Create button
  await page.getByRole("button", { name: "Create" }).click();

  // Wait for navigation to the new dashboard
  await expect(page).toHaveURL(/\/dashboards\/[\w-]+/, { timeout: 15_000 });

  // Extract dashboard ID from URL
  const match = page.url().match(/\/dashboards\/([\w-]+)/);
  const dashboardId = match?.[1] ?? "";
  if (!dashboardId) {
    throw new Error(`Failed to extract dashboard ID from URL: ${page.url()}`);
  }

  // Wait for canvas to appear
  await page.locator(".react-flow").waitFor({ timeout: 30_000 });

  // Dismiss onboarding dialog if it appears
  await dismissOnboardingDialog(page);

  return dashboardId;
}

/**
 * Navigate to a dashboard by ID and wait for canvas to load.
 */
export async function gotoDashboard(
  page: Page,
  dashboardId: string
): Promise<void> {
  await page.goto(`/dashboards/${dashboardId}`);
  await page.locator(".react-flow").waitFor({ timeout: 30_000 });

  // Dismiss onboarding dialog if it appears
  await dismissOnboardingDialog(page);
}

/**
 * Delete a dashboard via the UI from the dashboards list page.
 * Hovers the card to reveal the delete button, clicks it, and confirms.
 */
export async function deleteDashboardViaUI(
  page: Page,
  dashboardName: string
): Promise<void> {
  if (!page.url().endsWith("/dashboards")) {
    await page.goto("/dashboards");
  }
  await page.waitForLoadState("networkidle");

  // Find the dashboard card by name and hover to reveal actions
  const card = page.getByText(dashboardName).first();
  await card.hover();

  // Look for a delete/trash button near this card
  const row = card.locator("xpath=ancestor::div[contains(@class,'group')]");
  const deleteBtn = row.locator('button:has(svg)').last();
  await deleteBtn.click();

  // Confirm deletion in dialog
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: /delete/i }).click();

  // Wait for dialog to close
  await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5_000 });
}
