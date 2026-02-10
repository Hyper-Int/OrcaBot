// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: folder-import-hook-v4-ignore-when-idle
const MODULE_REVISION = "folder-import-hook-v4-ignore-when-idle";
console.log(
  `[useFolderImport] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

import * as React from "react";
import { DESKTOP_MODE } from "@/config/env";
import {
  importFolder,
  pickFolder,
  onImportProgress,
  onDragDrop,
  type ImportProgress,
  type ImportResult,
} from "@/lib/tauri-bridge";

export interface FolderImportState {
  isImporting: boolean;
  progress: ImportProgress | null;
  error: string | null;
  lastResult: ImportResult | null;
  isDragOver: boolean;
}

export function useFolderImport(destSubpath?: string) {
  const [state, setState] = React.useState<FolderImportState>({
    isImporting: false,
    progress: null,
    error: null,
    lastResult: null,
    isDragOver: false,
  });

  // Ref guard to prevent concurrent imports — avoids stale closure issues
  const importingRef = React.useRef(false);
  // Track active import_id so we only process progress events for the current import
  const activeImportIdRef = React.useRef<string | null>(null);

  // Listen for progress events from Rust
  React.useEffect(() => {
    if (!DESKTOP_MODE) return;
    let unlisten: (() => void) | null = null;
    onImportProgress((progress) => {
      // Ignore all events when this window has no active import — prevents
      // cross-window broadcasts or stale events from flipping UI state
      if (!importingRef.current && !activeImportIdRef.current) {
        return;
      }
      // If we're actively importing but haven't locked onto an import_id yet,
      // capture it from the first progress event we receive
      if (importingRef.current && !activeImportIdRef.current) {
        activeImportIdRef.current = progress.import_id;
      }
      // Ignore events from a different (stale) import
      if (activeImportIdRef.current && progress.import_id !== activeImportIdRef.current) {
        return;
      }
      setState((prev) => ({
        ...prev,
        progress,
        isImporting: progress.phase !== "done" && progress.phase !== "error",
        error: progress.phase === "error" ? progress.current_file : null,
      }));
      if (progress.phase === "done" || progress.phase === "error") {
        importingRef.current = false;
        activeImportIdRef.current = null;
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const handleImport = React.useCallback(
    async (sourcePath: string) => {
      // Use ref guard — not subject to stale closures
      if (importingRef.current) return;
      importingRef.current = true;
      setState((prev) => ({
        ...prev,
        isImporting: true,
        error: null,
        progress: null,
        lastResult: null,
      }));
      try {
        const result = await importFolder(sourcePath, destSubpath);
        importingRef.current = false;
        activeImportIdRef.current = null;
        setState((prev) => ({
          ...prev,
          isImporting: false,
          lastResult: result,
          progress: null,
          error:
            result.errors.length > 0
              ? `${result.errors.length} file(s) failed to copy`
              : null,
        }));
      } catch (err) {
        importingRef.current = false;
        activeImportIdRef.current = null;
        setState((prev) => ({
          ...prev,
          isImporting: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [destSubpath]
  );

  // Listen for drag-drop events from Tauri
  React.useEffect(() => {
    if (!DESKTOP_MODE) return;
    let unlisten: (() => void) | null = null;
    onDragDrop((event) => {
      if (event.type === "over") {
        setState((prev) => ({ ...prev, isDragOver: true }));
      } else if (event.type === "drop" && event.paths?.length) {
        setState((prev) => ({ ...prev, isDragOver: false }));
        handleImport(event.paths[0]);
      } else {
        setState((prev) => ({ ...prev, isDragOver: false }));
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [handleImport]);

  const handlePickFolder = React.useCallback(async () => {
    const path = await pickFolder();
    if (path) {
      await handleImport(path);
    }
  }, [handleImport]);

  const clearError = React.useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    handlePickFolder,
    handleImport,
    clearError,
    isDesktop: DESKTOP_MODE,
  };
}
