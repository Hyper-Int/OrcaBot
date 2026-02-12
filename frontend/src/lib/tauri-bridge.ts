// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: tauri-bridge-v4-bundler-safe
const MODULE_REVISION = "tauri-bridge-v4-bundler-safe";
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
 * Dynamically import Tauri invoke to avoid breaking web/Cloudflare builds.
 * Returns null if not in desktop mode or if Tauri APIs are unavailable.
 */
async function getTauriInvoke(): Promise<TauriInvoke | null> {
  if (!DESKTOP_MODE) return null;
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
