// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
"use client";

import { openExternalUrl, ensureSurfaceToken, onAppFocus } from "@/lib/tauri-bridge";
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
  let timer: ReturnType<typeof setInterval> | null = null;
  let unlistenTauriFocus: (() => void) | null = null;

  const cleanup = () => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (unlistenTauriFocus) {
      unlistenTauriFocus();
      unlistenTauriFocus = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };

  const check = async () => {
    if (stopped) return;
    if (Date.now() - start > timeoutMs) {
      cleanup();
      return;
    }
    try {
      if (await checkConnected()) {
        cleanup();
        onConnected();
      }
    } catch {
      /* transient — keep polling */
    }
  };

  // Re-check the moment the app regains focus — the OS browser is foreground
  // while the user authorizes, and background webviews throttle setInterval.
  const onFocus = () => void check();
  const onVisibility = () => {
    if (typeof document !== "undefined" && !document.hidden) void check();
  };

  timer = setInterval(() => void check(), intervalMs);
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
  }
  // Native Tauri focus event — fires reliably when the app becomes active again
  // after the OS browser, unlike the webview's own focus event.
  void onAppFocus(() => void check()).then((unlisten) => {
    if (stopped) unlisten();
    else unlistenTauriFocus = unlisten;
  });

  return cleanup;
}
