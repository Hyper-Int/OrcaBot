// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
"use client";

import { openExternalUrl, ensureSurfaceToken } from "@/lib/tauri-bridge";
import { getAuthHeaders } from "@/stores/auth-store";

export interface BrowserOAuthConnect {
  /** The provider connect URL (omit mode=popup on desktop — the callback shows a
   *  plain success page since there's no popup to postMessage back to). */
  url: string;
  /** Poll target: resolves true once the provider is connected. */
  checkConnected: () => Promise<boolean>;
  /** Called once when the connection is detected. */
  onConnected: () => void;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Desktop-safe OAuth connect: open the provider URL in the OS default browser
 * and poll the integration status until it reports connected. This replaces the
 * `window.open` popup + `postMessage`/popup-close handshake, which can't work in
 * the Tauri webview (window.open is a no-op, and the OS browser can't postMessage
 * back to the app). Returns a cancel function.
 */
export function connectViaBrowser(opts: BrowserOAuthConnect): () => void {
  const {
    url,
    checkConnected,
    onConnected,
    intervalMs = 2500,
    timeoutMs = 300000,
  } = opts;

  // A top-level browser navigation can't send dev-auth / surface HEADERS, so
  // pass identity + surface token as query params (the control plane's dev-auth
  // and surface gate both accept the query-param form). Ensure the token is
  // loaded first so it's present.
  void (async () => {
    await ensureSurfaceToken();
    let target = url;
    try {
      const h = getAuthHeaders();
      const u = new URL(url);
      if (h["X-User-ID"]) u.searchParams.set("user_id", h["X-User-ID"]);
      if (h["X-User-Email"]) u.searchParams.set("user_email", h["X-User-Email"]);
      if (h["X-User-Name"]) u.searchParams.set("user_name", h["X-User-Name"]);
      if (h["X-Orcabot-Surface"]) u.searchParams.set("surface", h["X-Orcabot-Surface"]);
      target = u.toString();
    } catch {
      /* fall back to the plain url */
    }
    void openExternalUrl(target);
  })();

  const start = Date.now();
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    if (Date.now() - start > timeoutMs) {
      clearInterval(timer);
      return;
    }
    try {
      if (await checkConnected()) {
        clearInterval(timer);
        if (!stopped) onConnected();
      }
    } catch {
      /* transient — keep polling */
    }
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
