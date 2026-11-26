// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: session-liveness-api-v1-before-restart
const MODULE_REVISION = "session-liveness-api-v1-before-restart";
console.log(`[session-liveness-api] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { API } from "@/config/env";
import { apiGet, ApiError } from "../client";

/**
 * Is this terminal's process still running on the sandbox? Asked before the page
 * replaces a terminal whose connection dropped: a backgrounded tab loses its socket
 * while the terminal is fine, and replacing it kills what was running.
 *
 * true = running (reconnect to it); false = gone (replace it); null = couldn't tell
 * (offline, control plane or sandbox not answering): never replace on null. Never throws.
 */
export async function getSessionLiveness(sessionId: string, timeoutMs = 8000): Promise<boolean | null> {
  console.log(`[getSessionLiveness] called at ${new Date().toISOString()} (${sessionId})`);
  try {
    const res = await Promise.race([
      apiGet<{ alive?: boolean | null; reason?: string }>(`${API.cloudflare.base}/sessions/${sessionId}/alive`),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!res) return null;
    console.log(`[getSessionLiveness] ${sessionId}: alive=${res.alive} (${res.reason ?? ""})`);
    return typeof res.alive === "boolean" ? res.alive : null;
  } catch (e) {
    // 404: the session row is gone (deleted), so nothing of it is running.
    if (e instanceof ApiError && e.status === 404) return false;
    console.warn("[getSessionLiveness] couldn't tell", e);
    return null;
  }
}
