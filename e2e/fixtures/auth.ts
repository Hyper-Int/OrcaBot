// REVISION: e2e-auth-v4-pat-and-derived-cp-url
import {
  type Page,
  expect,
  request as playwrightRequest,
  test as baseTest,
} from "@playwright/test";
import { generateUserId } from "../helpers/api";
import { getEnv } from "../helpers/env";
// The control-plane origin is derived from ORCABOT_URL (with CONTROLPLANE_URL as
// an override) so a single knob points the whole harness at an instance.
import { CONTROLPLANE_URL } from "../helpers/controlplane-url";

const MODULE_REVISION = "e2e-auth-v4-pat-and-derived-cp-url";
console.log(
  `[e2e-auth] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

const DEFAULT_NAME = getEnv("E2E_USER_NAME", "E2E Test User")!;
const DEFAULT_EMAIL = getEnv("E2E_USER_EMAIL", "e2e-test@orcabot.test")!;
const GOOGLE_TEST_EMAIL = getEnv("GOOGLE_TEST_EMAIL");
const GOOGLE_TEST_PASSWORD = getEnv("GOOGLE_TEST_PASSWORD");

/** Whether password-based Google login is configured (see also the trace guard). */
export function googleAuthConfigured(): boolean {
  return Boolean(GOOGLE_TEST_EMAIL && GOOGLE_TEST_PASSWORD);
}

/**
 * Whether the splash page is currently offering the dev-mode login form.
 *
 * Shared by devModeLoginViaUI and the UI-login spec so the test's skip decision
 * and the helper's strategy choice can never disagree. Waits briefly rather
 * than checking instantly, because the splash renders its login controls only
 * after auth resolves. The caller must already be on a real page — on
 * about:blank this is always false.
 */
export async function devLoginFormVisible(
  page: Page,
  timeoutMs = 8_000
): Promise<boolean> {
  return page
    .getByRole("button", { name: /dev mode login/i })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

/**
 * Refuse to type the password while Playwright is recording a trace.
 *
 * Traces capture action parameters, so a fill() of the password ends up inside
 * trace.zip and travels with CI artifacts. playwright.config.ts already forces
 * trace off when GOOGLE_TEST_PASSWORD is set, but `--trace on` from the CLI
 * overrides config — so check the effective mode here too and fail loudly
 * rather than leak the credential into an artifact.
 */
function assertTracingDisabled(): void {
  let traceMode: string | undefined;
  try {
    const trace = baseTest.info().project.use.trace;
    traceMode = typeof trace === "string" ? trace : trace?.mode;
  } catch {
    // Not inside a running test (or no project config) — nothing to check.
    return;
  }

  if (traceMode && traceMode !== "off") {
    throw new Error(
      `Refusing to type GOOGLE_TEST_PASSWORD while tracing is enabled (trace="${traceMode}").\n` +
        "Playwright records fill() parameters, so the password would be stored in trace.zip.\n" +
        "Run without --trace, or authenticate with E2E_STORAGE_STATE / E2E_API_TOKEN instead."
    );
  }
}

/** Cached across a worker — whether dev auth is usable can't change mid-run. */
let devAuthAvailableCache: boolean | undefined;

/**
 * Probe whether the target honors dev auth.
 *
 * Deliberately uses an ISOLATED request context, not `page.request`: the latter
 * shares the browser context's cookie jar, so probing would mint a real session
 * as a side effect and silently pre-authenticate the very UI login flow that
 * devModeLoginViaUI is meant to exercise.
 *
 * Accepts any 2xx: the endpoint returned 204 historically but now returns 200
 * with a JSON body ({id, email}). A 403 means either DEV_AUTH_ENABLED is off
 * (E79406) or a SURFACE_TOKEN is provisioned and we aren't the trusted surface
 * (E79407) — both mean "not usable", so fall through to another strategy.
 */
async function devAuthAvailable(): Promise<boolean> {
  if (devAuthAvailableCache !== undefined) {
    return devAuthAvailableCache;
  }

  const probe = await playwrightRequest.newContext();
  try {
    const response = await probe.post(`${CONTROLPLANE_URL}/auth/dev/session`, {
      headers: devAuthHeaders(DEFAULT_EMAIL, DEFAULT_NAME),
    });
    devAuthAvailableCache = response.ok();
  } catch {
    // Unreachable control plane — treat as unavailable and let the caller
    // fall through to another strategy (or fail with a clearer message).
    devAuthAvailableCache = false;
  } finally {
    await probe.dispose();
  }

  return devAuthAvailableCache;
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

  const dashboardsVisible = await dashboardsHeading(page)
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

  return dashboardsVisible;
}

/**
 * The "New Dashboard" section heading — the marker that we're on the dashboard
 * picker rather than the splash page.
 *
 * Must be an exact heading match. A bare getByText("New Dashboard") is a
 * case-insensitive SUBSTRING match, so it also matches the splash page's "Sign
 * in and create a new dashboard — a shared workspace" — which made
 * isAlreadyAuthenticated() return true while logged out, silently skipping
 * login and failing the test later with a confusing URL assertion.
 */
function dashboardsHeading(page: Page) {
  return page
    .getByRole("heading", { name: "New Dashboard", exact: true })
    .first();
}

/**
 * Headers that identify us to dev auth.
 *
 * `X-Orcabot-Surface` is only required when the target provisions a
 * SURFACE_TOKEN (desktop builds); on cloud/local-dev it is unset and ignored.
 */
function devAuthHeaders(email: string, name: string): Record<string, string> {
  const headers: Record<string, string> = {
    "X-User-ID": generateUserId(email),
    "X-User-Email": email,
    "X-User-Name": name,
  };
  const surfaceToken = getEnv("E2E_SURFACE_TOKEN");
  if (surfaceToken) {
    headers["X-Orcabot-Surface"] = surfaceToken;
  }
  return headers;
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
    { headers: devAuthHeaders(email, name) }
  );

  // Any 2xx is success. This used to require exactly 204; the endpoint now
  // returns 200 with a JSON body, which made every dev login fail here.
  if (!response.ok()) {
    throw new Error(
      `Failed to create dev session: ${response.status()} ${await response.text()}`
    );
  }

  // Dev auth is email-keyed server-side: if a user with this email already
  // exists, the control plane reconciles to ITS id and ignores our generated
  // one. Prefer the resolved id for the injected auth state, or the frontend's
  // /users/me sync sees a mismatch and lands on an empty dashboard list.
  const resolvedUserId = await response
    .json()
    .then((body: { id?: string }) => body?.id)
    .catch(() => undefined);
  const effectiveUserId = resolvedUserId || userId;

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
        id: effectiveUserId,
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

  // Check before doing any work, so a misconfigured run fails fast.
  assertTracingDisabled();

  await page.goto("/");

  // Both the header "Sign In" link and the "Get Started Free" CTA point at /go
  // but have an onClick that opens the Google popup (window.open on
  // /auth/google/login?mode=popup) instead of navigating.
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

/**
 * Log in using whichever strategy the target instance supports.
 *
 * Order matters — cheapest and least brittle first:
 *   1. Already authenticated (a saved storageState, see E2E_STORAGE_STATE)
 *   2. Dev auth (local / dev instances)
 *   3. Driving Google's real login UI — LAST RESORT. It needs a real password
 *      in the environment and is subject to bot detection, so prefer capturing
 *      a storageState once (or using a PAT for API-only work) over relying on
 *      it in CI.
 */
export async function login(
  page: Page,
  name = DEFAULT_NAME,
  email = DEFAULT_EMAIL
): Promise<void> {
  if (await isAlreadyAuthenticated(page)) {
    return;
  }

  if (await devAuthAvailable()) {
    await devModeLogin(page, name, email);
    return;
  }

  if (googleAuthConfigured()) {
    await googlePopupLogin(page);
    return;
  }

  throw new Error(
    "No usable login strategy found. Either capture a browser session into " +
      "e2e/.auth/orcabot-user.json (see E2E_STORAGE_STATE), set GOOGLE_TEST_EMAIL " +
      "and GOOGLE_TEST_PASSWORD, or run against an instance with dev auth enabled."
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

  await page.goto("/");

  // Choose the strategy from what the page actually renders, not from whether
  // dev auth is reachable: an instance can accept dev auth over the API while
  // the splash offers only Google, and waiting for a form that will never
  // appear just burns the timeout.
  const devLoginBtn = page.getByRole("button", { name: /dev mode login/i });
  if (!(await devLoginFormVisible(page))) {
    if (googleAuthConfigured()) {
      await googlePopupLogin(page);
      return;
    }
    throw new Error(
      "No UI login strategy available: this build has no dev-mode login form, " +
        "and GOOGLE_TEST_EMAIL / GOOGLE_TEST_PASSWORD are not set."
    );
  }

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
  await expect(dashboardsHeading(page)).toBeVisible({ timeout: 10_000 });
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
      .or(page.getByRole("button", { name: /continue with google/i }))
      .or(page.getByRole("link", { name: /^sign in$/i }))
      .or(page.getByRole("link", { name: /get started/i }))
      .or(page.getByRole("button", { name: /get started/i }))
      .first()
  ).toBeVisible({ timeout: 10_000 });
}
