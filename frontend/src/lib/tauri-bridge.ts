// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: tauri-bridge-v3-processed-field
const MODULE_REVISION = "tauri-bridge-v3-processed-field";
console.log(
  `[tauri-bridge] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import { DESKTOP_MODE } from "@/config/env";

/**
 * Dynamically import Tauri invoke to avoid breaking web/Cloudflare builds.
 * Returns null if not in desktop mode or if Tauri APIs are unavailable.
 */
async function getTauriInvoke() {
  if (!DESKTOP_MODE) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke;
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
  return invoke<WorkspaceInfo>("get_workspace_path");
}

/** Import a folder (or file) from source_path into the workspace. */
export async function importFolder(
  sourcePath: string,
  destSubpath?: string
): Promise<ImportResult> {
  const invoke = await getTauriInvoke();
  if (!invoke) throw new Error("Not in desktop mode");
  return invoke<ImportResult>("import_folder", {
    sourcePath,
    destSubpath: destSubpath ?? null,
  });
}

/** Open a native folder picker dialog. Returns the selected path or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  if (!DESKTOP_MODE) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
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
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const unlisten = await getCurrentWebview().listen<ImportProgress>(
      "folder-import-progress",
      (event) => callback(event.payload)
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
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload as {
        type: "over" | "drop" | "cancel";
        paths?: string[];
        position?: { x: number; y: number };
      };
      callback(payload);
    });
    return unlisten;
  } catch {
    return null;
  }
}
