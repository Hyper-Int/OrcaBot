// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: open-auth-popup-v1
// Shared opener for OAuth "connect" popups.
//
// Why this exists: on desktop we open a named, centered popup window. On mobile
// Safari a FIXED window name is a footgun — iOS treats `window.open(url, name)`
// as "find-or-create by name" and does NOT auto-close popup tabs. So the OAuth
// callback tab from a previous connect lingers in the tab list carrying that
// name, and the next connect click makes Safari FOCUS that stale tab instead of
// opening a fresh one — dropping the user on an unexpected page. Opening a plain
// unnamed `_blank` tab (no features string, opener preserved) sidesteps the
// whole name-reuse mechanism while keeping postMessage/BroadcastChannel-based
// completion working.

const MODULE_REVISION = "open-auth-popup-v1";
if (typeof window !== "undefined") {
  console.log(`[open-auth-popup] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

export interface AuthPopupOptions {
  width?: number;
  height?: number;
  /**
   * Desktop only: open with `noopener,noreferrer`. Ignored on mobile, where we
   * always keep the opener so the OAuth callback's postMessage can reach us.
   */
  noopener?: boolean;
}

/** True on touch / coarse-pointer devices (phones, most tablets). */
export function isCoarsePointerDevice(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia?.("(pointer: coarse)").matches || window.innerWidth < 768;
  } catch {
    return window.innerWidth < 768;
  }
}

/**
 * Open an OAuth connect popup. Returns the opened window (or null) so callers
 * that poll `popup.closed` keep working. `name` is used only on desktop.
 */
export function openAuthPopup(url: string, name: string, opts: AuthPopupOptions = {}): Window | null {
  if (isCoarsePointerDevice()) {
    // Fresh, unnamed tab every time → Safari can't reuse/focus a stale one.
    // No features string (mobile ignores geometry and it can trigger a reused
    // popup surface). Opener kept intact for postMessage completion.
    return window.open(url, "_blank");
  }
  const w = opts.width ?? 520;
  const h = opts.height ?? 680;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
  const features = `width=${w},height=${h},left=${left},top=${top}${
    opts.noopener ? ",noopener,noreferrer" : ""
  }`;
  return window.open(url, name, features);
}
