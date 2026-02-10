// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: import-progress-bar-v3-processed-field

import * as React from "react";
import { Loader2, CheckCircle, AlertCircle, X } from "lucide-react";
import type { ImportProgress, ImportResult } from "@/lib/tauri-bridge";

interface ImportProgressBarProps {
  progress: ImportProgress | null;
  error: string | null;
  isImporting: boolean;
  lastResult: ImportResult | null;
  onDismissError?: () => void;
}

export function ImportProgressBar({
  progress,
  error,
  isImporting,
  lastResult,
  onDismissError,
}: ImportProgressBarProps) {
  const [showSuccess, setShowSuccess] = React.useState(false);

  // Show success toast briefly when import completes
  React.useEffect(() => {
    if (lastResult && !isImporting && !error) {
      setShowSuccess(true);
      const timer = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [lastResult, isImporting, error]);

  if (!isImporting && !error && !showSuccess) return null;

  const percent =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 bg-[var(--background)] border border-[var(--border)] rounded-lg shadow-lg p-3">
      {error ? (
        <div className="flex items-center gap-2 text-xs text-[var(--status-error)]">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="truncate flex-1">Import failed: {error}</span>
          {onDismissError && (
            <button
              onClick={onDismissError}
              className="shrink-0 hover:opacity-70"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ) : showSuccess && lastResult ? (
        <div className="flex items-center gap-2 text-xs text-[var(--status-success)]">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span className="truncate">
            Imported {lastResult.files_copied} file
            {lastResult.files_copied !== 1 ? "s" : ""}
            {lastResult.errors.length > 0 && (
              <span className="text-[var(--status-warning)]">
                {" "}({lastResult.errors.length} failed)
              </span>
            )}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-xs text-[var(--foreground)]">
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            <span className="truncate">
              {progress?.phase === "scanning"
                ? "Scanning folder..."
                : `Importing: ${progress?.processed ?? 0}/${progress?.total ?? "?"} files`}
            </span>
          </div>
          <div className="mt-2 h-1.5 bg-[var(--background-elevated)] rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--accent-primary)] rounded-full transition-all duration-200"
              style={{ width: `${percent}%` }}
            />
          </div>
          {progress?.current_file && (
            <div className="mt-1 text-[10px] text-[var(--foreground-muted)] truncate">
              {progress.current_file}
            </div>
          )}
        </>
      )}
    </div>
  );
}
