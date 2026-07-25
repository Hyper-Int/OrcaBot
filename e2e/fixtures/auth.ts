// REVISION: e2e-auth-v3-storage-state
import { type Page, expect } from "@playwright/test";
import { generateUserId } from "../helpers/api";
import { getEnv, requireEnv } from "../helpers/env";

const MODULE_REVISION = "e2e-auth-v3-storage-state";
console.log(
  `[e2e-auth] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

const DEFAULT_NAME = getEnv("E2E_USER_NAME", "E2E Test User")!;
const DEFAULT_EMAIL = getEnv("E2E_USER_EMAIL", "e2e-test@orcabot.test")!;
const GOOGLE_TEST_EMAIL = getEnv("GOOGLE_TEST_EMAIL");
const GOOGLE_TEST_PASSWORD = getEnv("GOOGLE_TEST_PASSWORD");

/**
 * Control plane URL for API calls.
 * Default: localhost:8787 (matches frontend/src/config/env.ts for localhost target).
 */
const CONTROLPLANE_URL =
  requireEnv("CONTROLPLANE_URL");

function googleAuthConfigured(): boolean {
  return Boolean(GOOGLE_TEST_EMAIL && GOOGLE_TEST_PASSWORD);
}

async function devAuthAvailable(page: Page): Promise<boolean> {
  const response = await page.request.post(`${CONTROLPLANE_URL}/auth/dev/session`, {
    headers: {
      "X-User-ID": generateUserId(DEFAULT_EMAIL),
      "X-User-Email": DEFAULT_EMAIL,
      "X-User-Name": DEFAULT_NAME,
    },
  });

  if (response.status() === 204) {
    return true;
  }

  return false;
}

async function isAlreadyAuthenticated(page: Page): Promise<boolean> {
  await page.goto("/dashboards", { waitUntil: "domcontentloaded" });

  const onDashboards = await page
    .waitForURL(/\/dashboards(?:$|\?)/, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  if (!onDashboards) {
    return false;
  }

  const dashboardsVisible = await page
    .getByText("New Dashboard")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  return dashboardsVisible;
}

/**
 * Log in by creating a server-side session directly via the control plane API,
 * then injecting the session cookie and auth state into the browser.
 *
 * This avoids a race condition in the frontend's login flow where the
 * AuthBootstrapper's background GET /users/me fires before the POST
 * /auth/dev/session returns, causing it to call logout().
 *
 * Use this for any test that just needs to be logged in.
 */
export async function devModeLogin(
  page: Page,
  name = DEFAULT_NAME,
  email = DEFAULT_EMAIL
): Promise<void> {
  const userId = generateUserId(email);

  // Step 1: Create server-side session via direct API call
  const response = await page.request.post(
    `${CONTROLPLANE_URL}/auth/dev/session`,
    {
      headers: {
        "X-User-ID": userId,
        "X-User-Email": email,
        "X-User-Name": name,
      },
    }
  );

  if (response.status() !== 204) {
    throw new Error(
      `Failed to create dev session: ${response.status()} ${await response.text()}`
    );
  }

  // Step 2: Extract session cookie from the response
  const setCookieHeader = response.headers()["set-cookie"] || "";
  const sessionMatch = setCookieHeader.match(/orcabot_session=([^;]+)/);
  if (!sessionMatch) {
    throw new Error(
      `No session cookie in response. Set-Cookie: ${setCookieHeader}`
    );
  }

  // Step 3: Inject the session cookie into the browser context
  const cpUrl = new URL(CONTROLPLANE_URL);
  await page.context().addCookies([
    {
      name: "orcabot_session",
      value: sessionMatch[1],
      domain: cpUrl.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  // Step 4: Set zustand auth state in localStorage so the frontend
  // considers us authenticated on page load
  const authState = JSON.stringify({
    state: {
      user: {
        id: userId,
        name: name.trim(),
        email: email.trim().toLowerCase(),
        createdAt: new Date().toISOString(),
      },
      isAuthenticated: true,
      isAdmin: false,
      subscription: null,
    },
    version: 0,
  });

  // Navigate to origin first so we can set localStorage
  await page.goto("/", { waitUntil: "commit" });
  await page.evaluate(
    (state) => localStorage.setItem("orcabot-auth", state),
    authState
  );

  // Step 5: Navigate to dashboards (full load with auth state already set)
  await page.goto("/dashboards");

  // Step 6: Wait for the dashboards page to stabilize
  await waitForDashboardsPage(page);
}

async function googlePopupLogin(page: Page): Promise<void> {
  if (!GOOGLE_TEST_EMAIL || !GOOGLE_TEST_PASSWORD) {
    throw new Error(
      "Google OAuth credentials are not configured. Set GOOGLE_TEST_EMAIL and GOOGLE_TEST_PASSWORD in e2e/.env."
    );
  }

  await page.goto("/");

  const signInTrigger = page
    .getByRole("link", { name: /^sign in$/i })
    .or(page.getByRole("link", { name: /get started free/i }))
    .or(page.getByRole("button", { name: /get started free/i }))
    .first();

  await signInTrigger.waitFor({ state: "visible", timeout: 20_000 });

  const popupPromise = page.waitForEvent("popup", { timeout: 20_000 });
  await signInTrigger.click();
  const popup = await popupPromise;

  await popup.waitForLoadState("domcontentloaded", { timeout: 20_000 });

  // Google account chooser may show either an email field or an account tile.
  const emailField = popup.locator('input[type="email"]').first();
  const accountTile = popup.getByText(GOOGLE_TEST_EMAIL, { exact: false }).first();

  if (await emailField.isVisible().catch(() => false)) {
    await emailField.fill(GOOGLE_TEST_EMAIL);
    await popup.getByRole("button", { name: /^next$/i }).click();
  } else if (await accountTile.isVisible().catch(() => false)) {
    await accountTile.click();
  }

  const passwordField = popup
    .locator('input[name="Passwd"]:not([aria-hidden="true"])')
    .first();
  await passwordField.waitFor({ state: "visible", timeout: 30_000 });
  await passwordField.fill(GOOGLE_TEST_PASSWORD);
  await popup.getByRole("button", { name: /^next$/i }).click();

  // Consent / continue screens vary slightly by account state.
  const continueButton = popup
    .getByRole("button", { name: /continue|allow/i })
    .first();
  if (await continueButton.isVisible().catch(() => false)) {
    await continueButton.click();
  }

  // Popup callback posts a message back to the opener and closes.
  await popup.waitForEvent("close", { timeout: 60_000 }).catch(async () => {
    // Some browsers keep the popup open on the completion page briefly.
    await popup.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  });

  await waitForDashboardsPage(page);
}

export async function login(
  page: Page,
  name = DEFAULT_NAME,
  email = DEFAULT_EMAIL
): Promise<void> {
  if (await isAlreadyAuthenticated(page)) {
    return;
  }

  if (googleAuthConfigured()) {
    await googlePopupLogin(page);
    return;
  }

  if (await devAuthAvailable(page)) {
    await devModeLogin(page, name, email);
    return;
  }

  throw new Error(
    "No usable login strategy found. Either set GOOGLE_TEST_EMAIL and GOOGLE_TEST_PASSWORD in e2e/.env, or run against an instance with dev auth enabled."
  );
}

/**
 * Log in via the dev mode UI form on the splash page.
 *
 * This tests the actual UI login flow. It handles the AuthBootstrapper
 * race condition by intercepting the background /users/me validation
 * call during login.
 *
 * Use this specifically for testing the login UI itself.
 */
export async function devModeLoginViaUI(
  page: Page,
  name = DEFAULT_NAME,
  email = DEFAULT_EMAIL
): Promise<void> {
  if (await isAlreadyAuthenticated(page)) {
    return;
  }

  if (googleAuthConfigured()) {
    await googlePopupLogin(page);
    return;
  }

  await page.goto("/");

  // Wait for auth to resolve (login buttons appear)
  const devLoginBtn = page.getByRole("button", { name: /dev mode login/i });
  await devLoginBtn.waitFor({ state: "visible", timeout: 15_000 });

  // If already authenticated, we may see "Go to Dashboards" instead
  const alreadyLoggedIn = await page
    .getByRole("button", { name: /go to dashboards|open dashboards/i })
    .first()
    .isVisible()
    .catch(() => false);

  if (alreadyLoggedIn) {
    await page
      .getByRole("button", { name: /go to dashboards|open dashboards/i })
      .first()
      .click();
    await waitForDashboardsPage(page);
    return;
  }

  // Intercept the AuthBootstrapper's background /users/me call during login
  // to prevent the race condition where it calls logout() before the
  // POST /auth/dev/session returns the session cookie.
  let interceptActive = true;
  await page.route(`${CONTROLPLANE_URL}/users/me`, async (route) => {
    if (interceptActive) {
      // Abort the background validation to prevent the logout race
      await route.abort();
    } else {
      await route.continue();
    }
  });

  // Click "Dev mode login" button
  await devLoginBtn.click();

  // Fill in the dev mode form
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("your@email.com").fill(email);

  // Submit the form
  await page.getByRole("button", { name: /continue/i }).click();

  // Wait for navigation to /dashboards
  await expect(page).toHaveURL(/\/dashboards/, { timeout: 20_000 });

  // Re-enable /users/me validation
  interceptActive = false;
  await page.unroute(`${CONTROLPLANE_URL}/users/me`);

  // Wait for the page to be stable
  await waitForDashboardsPage(page);
}

/**
 * Wait for the /dashboards page to fully load and stabilize.
 * This means the URL is /dashboards AND the page shows dashboard content
 * (e.g., "New Dashboard" heading), not the splash/login page.
 */
async function waitForDashboardsPage(page: Page): Promise<void> {
  // First wait for URL
  await expect(page).toHaveURL(/\/dashboards/, { timeout: 20_000 });

  // Then wait for dashboard-specific content to confirm we're stable
  // (the "New Dashboard" section heading is always on the dashboard picker)
  await expect(
    page.getByText("New Dashboard").first()
  ).toBeVisible({ timeout: 10_000 });
}

/**
 * Log out from the current page.
 */
export async function logout(page: Page): Promise<void> {
  // The logout button is in the header, look for it by accessible name or icon
  const logoutBtn = page
    .getByRole("button", { name: /log\s?out/i })
    .or(page.locator('button:has(svg[class*="log-out"])'));
  await logoutBtn.first().click();

  // Should redirect back to splash / login — wait for the "Dev mode login"
  // or "Continue with Google" button to appear, confirming we're logged out
  await expect(
      page
        .getByRole("button", { name: /dev mode login/i })
        .or(page.getByRole("link", { name: /^sign in$/i }))
        .or(page.getByRole("button", { name: /continue with google/i }))
        .or(page.getByRole("button", { name: /get started/i }))
        .first()
  ).toBeVisible({ timeout: 10_000 });
}
