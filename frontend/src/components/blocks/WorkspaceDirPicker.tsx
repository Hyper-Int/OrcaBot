// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: workspace-dir-picker-v1
// Drill-down folder picker for choosing a terminal's working directory. Mirrors
// the left WorkspaceSidebar tree (lazy-loads children via listSessionFiles), but
// shows folders only and reports the chosen path as a workspace-relative string.
// Built to replace the free-text path field, which mangled leading slashes on
// mobile and forced users to type exact paths.

import * as React from "react";
import { ChevronDown, ChevronRight, Folder, Home, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { listSessionFiles, type SessionFileEntry } from "@/lib/api/cloudflare/files";

const MODULE_REVISION = "workspace-dir-picker-v1";
if (typeof window !== "undefined") {
  console.log(`[workspace-dir-picker] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

const HIDDEN_SYSTEM_ENTRY_NAMES = new Set(["lost+found"]);
function isHiddenSystemEntry(entry: Pick<SessionFileEntry, "name" | "path">): boolean {
  return (
    HIDDEN_SYSTEM_ENTRY_NAMES.has(entry.name) ||
    entry.path === "/lost+found" ||
    entry.path.startsWith("/lost+found/")
  );
}

// The files API tolerates a leading slash, but workingDir is stored
// workspace-relative (see TerminalContentState). Normalize both ways here so the
// tree and the persisted value stay in sync.
function toRelative(path: string): string {
  return path.replace(/^\/+/, "");
}

export interface WorkspaceDirPickerProps {
  sessionId: string | undefined;
  /** Currently-selected working dir, workspace-relative (e.g. "github/myproject"). Empty = root. */
  value: string;
  /** Called with the new workspace-relative path when the user picks a folder. */
  onSelect: (relativePath: string) => void;
  /** When false (default), dot-prefixed folders (e.g. ".git") are hidden. */
  showHidden?: boolean;
  className?: string;
}

export function WorkspaceDirPicker({ sessionId, value, onSelect, showHidden = false, className }: WorkspaceDirPickerProps) {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set(["/"]));
  const [entriesByPath, setEntriesByPath] = React.useState<Record<string, SessionFileEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);

  const selectedRel = toRelative(value);

  const loadDir = React.useCallback(
    async (path: string) => {
      if (!sessionId) return;
      setLoadingPaths((prev) => new Set(prev).add(path));
      try {
        const entries = (await listSessionFiles(sessionId, path)).filter(
          (e) => e.is_dir && !isHiddenSystemEntry(e)
        );
        entries.sort((a, b) => a.name.localeCompare(b.name));
        setEntriesByPath((prev) => ({ ...prev, [path]: entries }));
        setError(null);
      } catch {
        setError("Couldn't load workspace folders");
      } finally {
        setLoadingPaths((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [sessionId]
  );

  // (Re)load the root whenever the session changes.
  React.useEffect(() => {
    setEntriesByPath({});
    setExpanded(new Set(["/"]));
    if (sessionId) loadDir("/");
  }, [sessionId, loadDir]);

  const toggle = React.useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!entriesByPath[path]) loadDir(path);
        }
        return next;
      });
    },
    [entriesByPath, loadDir]
  );

  const renderTree = React.useCallback(
    (path: string, depth: number): React.ReactNode => {
      const entries = (entriesByPath[path] || []).filter(
        (e) => showHidden || !e.name.startsWith(".")
      );
      return entries.map((entry) => {
        const isExpanded = expanded.has(entry.path);
        const rel = toRelative(entry.path);
        const isSelected = selectedRel !== "" && rel === selectedRel;
        const isLoading = loadingPaths.has(entry.path);
        return (
          <div key={entry.path}>
            <div
              className={cn(
                "flex items-center gap-1 pr-2 py-1 text-[11px] cursor-pointer select-none nodrag",
                isSelected
                  ? "bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
                  : "hover:bg-[var(--background-elevated)] text-[var(--foreground)]"
              )}
              style={{ paddingLeft: `${depth * 12 + 4}px` }}
              onClick={() => onSelect(rel)}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(entry.path);
                }}
                className={cn(
                  "flex items-center shrink-0",
                  isSelected ? "text-[var(--accent-primary)]" : "text-[var(--foreground-muted)]"
                )}
                aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
              >
                {isLoading ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : isExpanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
              </button>
              <Folder
                className={cn(
                  "w-3 h-3 shrink-0",
                  isSelected ? "text-[var(--accent-primary)]" : "text-[var(--foreground-muted)]"
                )}
              />
              <span className="truncate">{entry.name}</span>
            </div>
            {isExpanded && renderTree(entry.path, depth + 1)}
          </div>
        );
      });
    },
    [entriesByPath, expanded, loadingPaths, onSelect, selectedRel, showHidden, toggle]
  );

  if (!sessionId) {
    return (
      <div className={cn("text-[10px] text-[var(--foreground-muted)] px-1 py-2", className)}>
        Start the terminal to browse workspace folders.
      </div>
    );
  }

  const rootLoading = loadingPaths.has("/") && !entriesByPath["/"];
  const rootEntries = (entriesByPath["/"] || []).filter(
    (e) => showHidden || !e.name.startsWith(".")
  );

  return (
    <div
      className={cn(
        "border border-[var(--border)] rounded bg-[var(--background)] max-h-56 overflow-y-auto nodrag",
        className
      )}
    >
      {/* Workspace root option */}
      <div
        className={cn(
          "flex items-center gap-1 px-2 py-1 text-[11px] cursor-pointer select-none nodrag border-b border-[var(--border)]",
          selectedRel === ""
            ? "bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
            : "hover:bg-[var(--background-elevated)] text-[var(--foreground)]"
        )}
        onClick={() => onSelect("")}
      >
        <Home className="w-3 h-3 shrink-0" />
        <span className="truncate">workspace root</span>
      </div>
      <div className="py-1">
        {rootLoading ? (
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--foreground-muted)] px-2 py-1">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="text-[10px] text-[var(--status-error)] px-2 py-1">{error}</div>
        ) : rootEntries.length === 0 ? (
          <div className="text-[10px] text-[var(--foreground-muted)] px-2 py-1">No folders in workspace.</div>
        ) : (
          renderTree("/", 0)
        )}
      </div>
    </div>
  );
}
