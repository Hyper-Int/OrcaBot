// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: tauri-bridge-v7-global-event-listen
const MODULE_REVISION = "tauri-bridge-v7-global-event-listen";
console.log(
  `[tauri-bridge] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import { DESKTOP_MODE } from "@/config/env";

// Use variable-based imports so Turbopack/webpack can't statically resolve them.
// These modules only exist in Tauri desktop builds, not in Cloudflare/web builds.
const TAURI_CORE = "@tauri-apps/api/core";
const TAURI_WEBVIEW = "@tauri-apps/api/webview";
const TAURI_DIALOG = "@tauri-apps/plugin-dialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<any>;

/**
 * Resolve Tauri's `invoke` in the desktop webview. Prefer the runtime globals
 * Tauri injects (withGlobalTauri → `window.__TAURI__.core.invoke`; and the
 * always-present `window.__TAURI_INTERNALS__.invoke`) over a dynamic
 * `import("@tauri-apps/api/core")`, which is a bare specifier the browser can't
 * resolve at runtime (it throws → every command would silently no-op). Returns
 * null on web/Cloudflare builds or if Tauri APIs are unavailable.
 */
async function getTauriInvoke(): Promise<TauriInvoke | null> {
  if (!DESKTOP_MODE || typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  if (typeof w.__TAURI__?.core?.invoke === "function") {
    return w.__TAURI__.core.invoke as TauriInvoke;
  }
  if (typeof w.__TAURI_INTERNALS__?.invoke === "function") {
    return ((cmd: string, args?: Record<string, unknown>) =>
      w.__TAURI_INTERNALS__.invoke(cmd, args ?? {})) as TauriInvoke;
  }
  try {
    const mod = await import(/* webpackIgnore: true */ TAURI_CORE);
    return mod.invoke as TauriInvoke;
  } catch {
    return null;
  }
}

// ---- Types ----

export interface WorkspaceInfo {
  path: string;
  exists: boolean;
}

export interface ImportResult {
  import_id: string;
  files_copied: number;
  bytes_copied: number;
  dest_path: string;
  errors: string[];
}

export interface ImportProgress {
  import_id: string;
  processed: number;
  total: number;
  current_file: string;
  phase: "scanning" | "copying" | "done" | "error";
}

export interface UpdateProgress {
  phase: "starting" | "downloading" | "installing" | "error";
  downloaded: number;
  total: number | null;
  message?: string;
}

// ---- Commands ----

/** Get the host workspace directory path. */
export async function getWorkspacePath(): Promise<WorkspaceInfo | null> {
  const invoke = await getTauriInvoke();
  if (!invoke) return null;
  return invoke("get_workspace_path") as Promise<WorkspaceInfo>;
}

/** The running app version (e.g. "0.5.0"); null on web/Cloudflare builds. */
export async function getAppVersion(): Promise<string | null> {
  const invoke = await getTauriInvoke();
  if (!invoke) return null;
  try {
    const v = (await invoke("get_app_version")) as string;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

export interface OrcabotAccount {
  email: string;
  name: string;
}

/**
 * Verify an orcabot.com personal access token via the native layer (no browser
 * CORS; the token is only sent to the fixed cloud URL). Resolves to the account
 * identity, or throws with a user-facing message. Desktop-only.
 */
export async function verifyOrcabotAccount(token: string): Promise<OrcabotAccount> {
  const invoke = await getTauriInvoke();
  if (!invoke) throw new Error("Sign-in is only available in the desktop app.");
  return invoke("verify_orcabot_account", { token }) as Promise<OrcabotAccount>;
}

// ---- Cloud account credential (dashboard sync) ----

export interface CloudAccount {
  email: string;
}

/** Persist the cloud PAT + email natively (host-only) for dashboard sync. */
export async function setCloudCredential(token: string, email: string): Promise<void> {
  const invoke = await getTauriInvoke();
  if (!invoke) return;
  await invoke("set_cloud_credential", { token, email });
}

/** The signed-in cloud account, or null if not connected. */
export async function getCloudAccount(): Promise<CloudAccount | null> {
  const invoke = await getTauriInvoke();
  if (!invoke) return null;
  try {
    return (await invoke("get_cloud_account")) as CloudAccount | null;
  } catch {
    return null;
  }
}

/** Forget the stored cloud credential. */
export async function clearCloudCredential(): Promise<void> {
  const invoke = await getTauriInvoke();
  if (!invoke) return;
  try {
    await invoke("clear_cloud_credential");
  } catch {
    /* ignore */
  }
}

/** List the signed-in user's cloud dashboards (raw JSON from api.orcabot.com). */
export async function listCloudDashboards(): Promise<unknown> {
  const invoke = await getTauriInvoke();
  if (!invoke) throw new Error("Cloud dashboards are only available in the desktop app.");
  return invoke("list_cloud_dashboards");
}

/** Reveal the host workspace directory in Finder/Explorer (desktop only). */
export async function revealWorkspace(): Promise<void> {
  const invoke = await getTauriInvoke();
  if (!invoke) return;
  try {
    await invoke("reveal_workspace");
  } catch {
    /* ignore — desktop-only convenience */
  }
}

/** Import a folder (or file) from source_path into the workspace. */
export async function importFolder(
  sourcePath: string,
  destSubpath?: string
): Promise<ImportResult> {
  const invoke = await getTauriInvoke();
  if (!invoke) throw new Error("Not in desktop mode");
  return invoke("import_folder", {
    sourcePath,
    destSubpath: destSubpath ?? null,
  }) as Promise<ImportResult>;
}

/**
 * Switch from the desktop GUI to the CLI surface: opens a terminal running
 * `orcabot cli` (same session) and hides the GUI. Desktop-only; no-op on web.
 * Returns true if the switch was triggered.
 */
export async function switchToCli(): Promise<boolean> {
  const invoke = await getTauriInvoke();
  if (!invoke) return false;
  await invoke("switch_to_cli");
  return true;
}

// ---- Desktop surface token ----
// Per-boot token that gates dev-auth to the trusted host frontend. Fetched once
// from the Tauri host and cached; the control plane requires the matching
// X-Orcabot-Surface header on desktop, so a process in the sandbox VM (which
// can't reach this command) can't spoof dev-auth. See desktop/CLAUDE.md.
let cachedSurfaceToken: string | null = null;
let surfaceTokenPromise: Promise<string | null> | null = null;

async function fetchSurfaceToken(): Promise<string | null> {
  const invoke = await getTauriInvoke();
  if (!invoke) return null;
  try {
    const t = (await invoke("get_surface_token")) as string;
    return typeof t === "string" && t ? t : null;
  } catch {
    return null;
  }
}

/**
 * The trusted loading screen (a local tauri:// page whose Tauri IPC always
 * works) hands the surface token to the frontend via ?surface= on the redirect,
 * because the remote-origin frontend can't rely on Tauri IPC in a packaged
 * build. Read it once and strip it from the URL so it doesn't linger.
 */
function readSurfaceTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("surface");
    if (t) {
      const url = new URL(window.location.href);
      url.searchParams.delete("surface");
      window.history.replaceState({}, "", url.toString());
      return t;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Fetch + cache the surface token once. Await before making authed requests. */
export async function ensureSurfaceToken(): Promise<string | null> {
  if (cachedSurfaceToken) return cachedSurfaceToken;
  if (!DESKTOP_MODE) return null;
  // Prefer the token handed off in the URL by the loading screen (robust even
  // when remote-origin Tauri IPC is unavailable); fall back to the IPC command.
  const fromUrl = readSurfaceTokenFromUrl();
  if (fromUrl) {
    cachedSurfaceToken = fromUrl;
    return fromUrl;
  }
  if (!surfaceTokenPromise) {
    surfaceTokenPromise = fetchSurfaceToken()
      .then((t) => {
        cachedSurfaceToken = t;
        // Do NOT cache a failed fetch. If the token wasn't available yet (the
        // Tauri IPC bridge can be unreachable during an early / headless pre-window
        // load), clear the promise so the next caller retries instead of forever
        // returning this poisoned null. HTTP masks the miss via the session cookie,
        // but cross-origin WebSockets get no cookie and depend on this token — so a
        // one-time early failure would otherwise wedge every WS for the whole session.
        if (!t) surfaceTokenPromise = null;
        return t;
      })
      .catch(() => {
        surfaceTokenPromise = null;
        return null;
      });
  }
  return surfaceTokenPromise;
}

/** Synchronously read the cached surface token (null until ensureSurfaceToken resolves). */
export function getCachedSurfaceToken(): string | null {
  return cachedSurfaceToken;
}

/**
 * Open an external URL. On desktop, opens the OS default browser (window.open is
 * a no-op inside the Tauri webview); on web, falls back to window.open. Used for
 * OAuth connect flows.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const invoke = await getTauriInvoke();
  if (invoke) {
    try {
      await invoke("open_url", { url });
      return;
    } catch {
      /* fall through to window.open */
    }
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Subscribe to the Tauri window regaining focus (the app becoming active again
 * after the OS browser). More reliable than the webview's own `focus` event
 * across an OS app-switch. Returns an unsubscribe function; no-op off desktop.
 */
export async function onAppFocus(cb: () => void): Promise<() => void> {
  if (!DESKTOP_MODE || typeof window === "undefined") return () => {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listen = (window as any).__TAURI__?.event?.listen;
    if (typeof listen === "function") {
      const unlisten = await listen("tauri://focus", () => cb());
      return typeof unlisten === "function" ? unlisten : () => {};
    }
  } catch {
    /* fall through — the interval + window focus fallback still runs */
  }
  return () => {};
}

/** Open a native folder picker dialog. Returns the selected path or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!DESKTOP_MODE) return null;
  try {
    const mod = await import(/* webpackIgnore: true */ TAURI_DIALOG);
    const selected = await mod.open({ directory: true, multiple: false });
    if (typeof selected === "string") return selected;
    return null;
  } catch {
    return null;
  }
}

// ---- Events ----

/**
 * Subscribe to a Rust-emitted (`app.emit`) event. Prefers the runtime-injected
 * `window.__TAURI__.event.listen` (present via withGlobalTauri) — the same global
 * onAppFocus uses — because the bare `import("@tauri-apps/api/webview")` specifier
 * does NOT resolve from the remote-origin packaged webview (it throws, the error
 * is swallowed, and the listener silently never fires). Falls back to the dynamic
 * import for dev builds where the specifier does resolve. No-op off desktop.
 */
async function listenGlobal<T>(
  event: string,
  callback: (payload: T) => void
): Promise<(() => void) | null> {
  if (!DESKTOP_MODE || typeof window === "undefined") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listen = (window as any).__TAURI__?.event?.listen;
    if (typeof listen === "function") {
      const unlisten = await listen(event, (e: { payload: T }) => callback(e.payload));
      return typeof unlisten === "function" ? unlisten : null;
    }
  } catch {
    /* fall through to the dynamic-import path */
  }
  try {
    const mod = await import(/* webpackIgnore: true */ TAURI_WEBVIEW);
    const unlisten = await mod
      .getCurrentWebview()
      .listen(event, (e: { payload: T }) => callback(e.payload));
    return unlisten;
  } catch {
    return null;
  }
}

/** Listen for import progress events emitted from the Rust backend. */
export async function onImportProgress(
  callback: (progress: ImportProgress) => void
): Promise<(() => void) | null> {
  return listenGlobal<ImportProgress>("folder-import-progress", callback);
}

/**
 * Listen for auto-update progress emitted from Rust (`update-progress`). Fires
 * once the user accepts the update (download start → per-MB progress → install),
 * so the UI can show a download bar. No-op off desktop.
 */
export async function onUpdateProgress(
  callback: (progress: UpdateProgress) => void
): Promise<(() => void) | null> {
  return listenGlobal<UpdateProgress>("update-progress", callback);
}

/** Listen for native drag-drop events on the Tauri webview. */
export async function onDragDrop(
  callback: (event: {
    type: "over" | "drop" | "cancel";
    paths?: string[];
    position?: { x: number; y: number };
  }) => void
): Promise<(() => void) | null> {
  if (!DESKTOP_MODE) return null;
  try {
    const mod = await import(/* webpackIgnore: true */ TAURI_WEBVIEW);
    const unlisten = await mod.getCurrentWebview().onDragDropEvent((event: {
      payload: {
        type: "over" | "drop" | "cancel";
        paths?: string[];
        position?: { x: number; y: number };
      };
    }) => {
      callback(event.payload);
    });
    return unlisten;
  } catch {
    return null;
  }
}
