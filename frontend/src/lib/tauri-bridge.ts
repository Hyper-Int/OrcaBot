// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: tauri-bridge-v5-global-invoke
const MODULE_REVISION = "tauri-bridge-v5-global-invoke";
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

// ---- Commands ----

/** Get the host workspace directory path. */
export async function getWorkspacePath(): Promise<WorkspaceInfo | null> {
  const invoke = await getTauriInvoke();
  if (!invoke) return null;
  return invoke("get_workspace_path") as Promise<WorkspaceInfo>;
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

/** Fetch + cache the surface token once. Await before making authed requests. */
export async function ensureSurfaceToken(): Promise<string | null> {
  if (cachedSurfaceToken) return cachedSurfaceToken;
  if (!DESKTOP_MODE) return null;
  if (!surfaceTokenPromise) {
    surfaceTokenPromise = fetchSurfaceToken().then((t) => {
      cachedSurfaceToken = t;
      return t;
    });
  }
  return surfaceTokenPromise;
}

/** Synchronously read the cached surface token (null until ensureSurfaceToken resolves). */
export function getCachedSurfaceToken(): string | null {
  return cachedSurfaceToken;
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

/** Listen for import progress events emitted from the Rust backend. */
export async function onImportProgress(
  callback: (progress: ImportProgress) => void
): Promise<(() => void) | null> {
  if (!DESKTOP_MODE) return null;
  try {
    const mod = await import(/* webpackIgnore: true */ TAURI_WEBVIEW);
    const unlisten = await mod.getCurrentWebview().listen(
      "folder-import-progress",
      (event: { payload: ImportProgress }) => callback(event.payload)
    );
    return unlisten;
  } catch {
    return null;
  }
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
