"use client";

import * as React from "react";
import { type NodeProps, type Node, Handle, Position } from "@xyflow/react";
import { Folder, Cloud, Github, Box, HardDrive } from "lucide-react";
import { BlockWrapper } from "./BlockWrapper";
import { Button } from "@/components/ui";
import { listSessionFiles, deleteSessionFile } from "@/lib/api/cloudflare";
import type { SessionFileEntry } from "@/lib/api/cloudflare";
import { useAuthStore } from "@/stores/auth-store";
import { API } from "@/config/env";

interface WorkspaceData extends Record<string, unknown> {
  size: { width: number; height: number };
  sessionId?: string;
}

type WorkspaceNode = Node<WorkspaceData, "workspace">;

type IntegrationProvider = "google-drive" | "github" | "box" | "onedrive";

export function WorkspaceBlock({ data, selected }: NodeProps<WorkspaceNode>) {
  const { user } = useAuthStore();
  const sessionId = data.sessionId;
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set(["/"]));
  const [fileEntries, setFileEntries] = React.useState<Record<string, SessionFileEntry[]>>({});
  const [fileError, setFileError] = React.useState<string | null>(null);

  const openIntegration = React.useCallback(
    (provider: IntegrationProvider) => {
      if (!user) return;
      if (provider === "box" || provider === "onedrive") {
        return;
      }
      const path = provider === "google-drive"
        ? "/integrations/google/drive/connect"
        : "/integrations/github/connect";
      const url = new URL(`${API.cloudflare.base}${path}`);
      url.searchParams.set("user_id", user.id);
      url.searchParams.set("user_email", user.email);
      url.searchParams.set("user_name", user.name);
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    },
    [user]
  );

  const loadFiles = React.useCallback(
    async (path: string) => {
      if (!sessionId) return;
      try {
        const entries = await listSessionFiles(sessionId, path);
        entries.sort((a, b) => {
          if (a.is_dir && !b.is_dir) return -1;
          if (!a.is_dir && b.is_dir) return 1;
          return a.name.localeCompare(b.name);
        });
        setFileEntries((prev) => ({ ...prev, [path]: entries }));
        setFileError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to load files";
        setFileError(message);
      }
    },
    [sessionId]
  );

  React.useEffect(() => {
    setExpandedPaths(new Set(["/"]));
    setFileEntries({});
    setFileError(null);
    if (sessionId) {
      loadFiles("/");
    }
  }, [sessionId, loadFiles]);

  const togglePath = React.useCallback(
    (path: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          if (!fileEntries[path]) {
            loadFiles(path);
          }
        }
        return next;
      });
    },
    [fileEntries, loadFiles]
  );

  const handleDeletePath = React.useCallback(
    async (path: string, parentPath: string) => {
      if (!sessionId) return;
      try {
        await deleteSessionFile(sessionId, path);
        loadFiles(parentPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete";
        setFileError(message);
      }
    },
    [loadFiles, sessionId]
  );

  const renderFileTree = React.useCallback(
    (path: string, depth = 0) => {
      const entries = fileEntries[path] || [];
      return entries.map((entry) => {
        const isExpanded = expandedPaths.has(entry.path);
        const isDir = entry.is_dir;
        return (
          <div key={entry.path}>
            <div
              className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] hover:bg-[var(--background-elevated)] rounded"
              style={{ paddingLeft: `${depth * 10 + 8}px` }}
            >
              <div className="flex items-center gap-1 min-w-0">
                {isDir ? (
                  <button
                    type="button"
                    onClick={() => togglePath(entry.path)}
                    className="text-[10px] text-[var(--foreground-muted)] nodrag"
                    aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
                  >
                    {isExpanded ? "▾" : "▸"}
                  </button>
                ) : (
                  <span className="text-[10px] text-[var(--foreground-subtle)]">—</span>
                )}
                <span className="truncate text-[var(--foreground)]">{entry.name}</span>
              </div>
              {!isDir && (
                <button
                  type="button"
                  onClick={() => handleDeletePath(entry.path, path)}
                  className="text-[10px] text-[var(--status-error)] hover:text-[var(--status-error)] nodrag"
                >
                  Delete
                </button>
              )}
            </div>
            {isDir && isExpanded && (
              <div>{renderFileTree(entry.path, depth + 1)}</div>
            )}
          </div>
        );
      });
    },
    [expandedPaths, fileEntries, handleDeletePath, togglePath]
  );

  React.useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(() => {
      const paths = Array.from(expandedPaths);
      paths.forEach((path) => loadFiles(path));
    }, 2500);

    return () => clearInterval(interval);
  }, [expandedPaths, loadFiles, sessionId]);

  const rootEntries = fileEntries["/"] || [];
  const showFiles = rootEntries.length > 0;

  return (
    <BlockWrapper
      selected={selected}
      className="p-0 overflow-hidden flex flex-col"
      minWidth={460}
      minHeight={110}
      includeHandles={false}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
        <Folder className="w-3.5 h-3.5 text-[var(--foreground-subtle)]" />
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
          Workspace
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-h-0 border-r border-[var(--border)] bg-white text-[var(--foreground)] dark:bg-[var(--background)]">
          {sessionId && showFiles ? (
            <div className="h-full overflow-auto">
              {fileError && (
                <div className="px-2 py-1 text-[10px] text-[var(--status-error)]">
                  {fileError}
                </div>
              )}
              {renderFileTree("/", 0)}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[10px] text-[var(--foreground-muted)] px-3 text-center">
              {sessionId ? "Files will appear here." : "Start a terminal to load."}
            </div>
          )}
        </div>
        <div className="w-36 bg-[var(--background)] px-2 py-2">
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openIntegration("google-drive")}
              disabled={!user}
              className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
              title="Connect Google Drive"
            >
              <Cloud className="w-4 h-4" />
              <span>Drive</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openIntegration("github")}
              disabled={!user}
              className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
              title="Connect GitHub"
            >
              <Github className="w-4 h-4" />
              <span>GitHub</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openIntegration("box")}
              disabled
              className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
              title="Box integration coming soon"
            >
              <Box className="w-4 h-4" />
              <span>Box</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => openIntegration("onedrive")}
              disabled
              className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
              title="OneDrive integration coming soon"
            >
              <HardDrive className="w-4 h-4" />
              <span>OneDrive</span>
            </Button>
          </div>
        </div>
      </div>
    </BlockWrapper>
  );
}

export default WorkspaceBlock;
