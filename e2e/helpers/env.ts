// REVISION: e2e-env-v3-no-password-tier
const MODULE_REVISION = "e2e-env-v3-no-password-tier";
console.log(
  `[e2e-env] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

export type E2ETier = "smoke" | "google" | "gemini";

export const E2E_ENV_REQUIREMENTS: Record<E2ETier, readonly string[]> = {
  // Only what cannot be derived or defaulted. CONTROLPLANE_URL is derived from
  // ORCABOT_URL (helpers/controlplane-url.ts) and is an override, not a
  // requirement; E2E_USER_EMAIL / E2E_USER_NAME have working defaults. Demanding
  // those would break invocations that pass ORCABOT_URL alone and work fine.
  smoke: ["ORCABOT_URL"],
  // Account DATA for integration assertions — not login credentials. Browser
  // login uses a captured storageState (`npm run auth:capture`); no password is
  // stored or typed, because Playwright would serialize it into step titles.
  google: [
    "GOOGLE_TEST_EMAIL",
    "GOOGLE_GMAIL_TEST_EMAIL",
    "GOOGLE_CALENDAR_TEST_ID",
  ],
  gemini: ["GEMINI_API_KEY"],
};

export function getEnv(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

export function hasEnv(name: string): boolean {
  return Boolean(getEnv(name));
}

export function missingEnv(names: readonly string[]): string[] {
  return names.filter((name) => !hasEnv(name));
}

export function missingTierEnv(tier: E2ETier): string[] {
  return missingEnv(E2E_ENV_REQUIREMENTS[tier]);
}

export function tierReady(tier: E2ETier): boolean {
  return missingTierEnv(tier).length === 0;
}

export function describeMissingEnv(names: readonly string[]): string {
  const missing = missingEnv(names);
  return missing.length === 0
    ? ""
    : `Missing env: ${missing.join(", ")}. Set them in e2e/.env.test.local.`;
}

export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`Missing required env ${name}. Set it in e2e/.env.test.local.`);
  }
  return value;
}

export function requiredEnvReport() {
  return {
    smoke: {
      required: [...E2E_ENV_REQUIREMENTS.smoke],
      missing: missingTierEnv("smoke"),
      ready: tierReady("smoke"),
    },
    google: {
      required: [...E2E_ENV_REQUIREMENTS.google],
      missing: missingTierEnv("google"),
      ready: tierReady("google"),
    },
    gemini: {
      required: [...E2E_ENV_REQUIREMENTS.gemini],
      missing: missingTierEnv("gemini"),
      ready: tierReady("gemini"),
    },
  };
}
