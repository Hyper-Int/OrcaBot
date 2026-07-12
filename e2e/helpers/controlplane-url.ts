/**
 * Resolve the control-plane base URL for the harness.
 *
 * The browser target is `ORCABOT_URL` (the frontend origin), but the control
 * plane is a *different* origin on the hosted instances — mirroring
 * frontend/src/config/env.ts's `API_URL_BY_TARGET`:
 *   localhost:3000        -> http://localhost:8787
 *   dev.orcabot.com       -> https://api.dev.orcabot.com
 *   orcabot.com           -> https://orcabot-controlplane.orcabot.workers.dev
 *
 * `devModeLogin` and the `api` fixture used to hardcode a `localhost:8787`
 * default, so pointing only `ORCABOT_URL` at a hosted instance silently sent
 * auth/API calls to localhost (connection refused). Deriving the control-plane
 * URL from `ORCABOT_URL` makes a single knob work; `CONTROLPLANE_URL` still
 * overrides for anything non-standard (e.g. a self-hosted split origin).
 */
export function deriveControlPlaneUrl(siteUrl?: string): string {
  if (!siteUrl) return "http://localhost:8787";

  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    return "http://localhost:8787";
  }

  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "http://localhost:8787";
  }
  if (host === "dev.orcabot.com") return "https://api.dev.orcabot.com";
  if (host === "orcabot.com" || host === "www.orcabot.com") {
    return "https://orcabot-controlplane.orcabot.workers.dev";
  }
  // Unknown host: assume the control plane is same-origin. Override with
  // CONTROLPLANE_URL if it lives elsewhere.
  return url.origin;
}

/** The resolved control-plane URL: explicit override, else derived from ORCABOT_URL. */
export const CONTROLPLANE_URL =
  process.env.CONTROLPLANE_URL || deriveControlPlaneUrl(process.env.ORCABOT_URL);
