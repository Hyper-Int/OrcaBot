// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Folder, Cloud, Github, Box, HardDrive } from "lucide-react";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import { Button } from "@/components/ui";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  listSessionFiles,
  deleteSessionFile,
  getGoogleDriveIntegration,
  getGoogleDriveSyncStatus,
  syncGoogleDrive,
  syncGoogleDriveLargeFiles,
  unlinkGoogleDriveFolder,
  type GoogleDriveIntegration,
  type GoogleDriveSyncStatus,
} from "@/lib/api/cloudflare";
import type { SessionFileEntry } from "@/lib/api/cloudflare";
import { useAuthStore } from "@/stores/auth-store";
import { API } from "@/config/env";

interface WorkspaceData extends Record<string, unknown> {
  size: { width: number; height: number };
  sessionId?: string;
  dashboardId?: string;
  connectorMode?: boolean;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
}

type WorkspaceNode = Node<WorkspaceData, "workspace">;

type IntegrationProvider = "google-drive" | "github" | "box" | "onedrive";

export function WorkspaceBlock({ id, data, selected }: NodeProps<WorkspaceNode>) {
  const { user } = useAuthStore();
  const sessionId = data.sessionId;
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set(["/"]));
  const [fileEntries, setFileEntries] = React.useState<Record<string, SessionFileEntry[]>>({});
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [driveIntegration, setDriveIntegration] = React.useState<GoogleDriveIntegration | null>(null);
  const [driveStatus, setDriveStatus] = React.useState<GoogleDriveSyncStatus | null>(null);
  const [driveSyncing, setDriveSyncing] = React.useState(false);
  const [drivePickerOpen, setDrivePickerOpen] = React.useState(false);
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const apiOrigin = React.useMemo(() => new URL(API.cloudflare.base).origin, []);

  const openIntegration = React.useCallback(
    (provider: IntegrationProvider) => {
      if (!user) return;
      if (provider === "box" || provider === "onedrive") {
        return;
      }
      if (provider === "google-drive") {
        setDrivePickerOpen(true);
        return;
      }
      const url = new URL(`${API.cloudflare.base}/integrations/github/connect`);
      url.searchParams.set("user_id", user.id);
      url.searchParams.set("user_email", user.email);
      url.searchParams.set("user_name", user.name);
      if (data.dashboardId) {
        url.searchParams.set("dashboard_id", data.dashboardId);
      }
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    },
    [data.dashboardId, user]
  );

  const handleDriveConnect = React.useCallback(() => {
    if (!user) return;
    const url = new URL(`${API.cloudflare.base}/integrations/google/drive/connect`);
    url.searchParams.set("user_id", user.id);
    url.searchParams.set("user_email", user.email);
    url.searchParams.set("user_name", user.name);
    url.searchParams.set("mode", "popup");
    if (data.dashboardId) {
      url.searchParams.set("dashboard_id", data.dashboardId);
    }
    const width = 520;
    const height = 680;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
    window.open(
      url.toString(),
      "orcabot-drive-auth",
      `width=${width},height=${height},left=${left},top=${top},noopener,noreferrer`
    );
  }, [data.dashboardId, user]);

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

  const loadDriveIntegration = React.useCallback(async () => {
    if (!user) return;
    try {
      const integration = await getGoogleDriveIntegration(data.dashboardId);
      setDriveIntegration(integration);
    } catch {
      setDriveIntegration(null);
    }
  }, [data.dashboardId, user]);

  const loadDriveStatus = React.useCallback(async () => {
    if (!user || !data.dashboardId) return;
    try {
      const status = await getGoogleDriveSyncStatus(data.dashboardId);
      setDriveStatus(status);
      setDriveSyncing(status.status === "syncing_cache" || status.status === "syncing_workspace");
    } catch {
      setDriveStatus(null);
      setDriveSyncing(false);
    }
  }, [data.dashboardId, user]);

  React.useEffect(() => {
    void loadDriveIntegration();
    void loadDriveStatus();
  }, [loadDriveIntegration, loadDriveStatus]);

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

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin && event.origin !== apiOrigin) {
        return;
      }
      const payload = event.data as { type?: string; folder?: { dashboardId?: string } };
      if (payload?.type === "drive-auth-complete") {
        void loadDriveIntegration();
        return;
      }
      if (payload?.type === "drive-linked") {
        setDrivePickerOpen(false);
        void loadDriveIntegration();
        void loadDriveStatus();
        const dashboardId = payload.folder?.dashboardId || data.dashboardId;
        if (dashboardId) {
          void syncGoogleDrive(dashboardId).catch(() => undefined);
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [apiOrigin, loadDriveIntegration, loadDriveStatus]);

  React.useEffect(() => {
    if (!driveSyncing) return;
    const interval = setInterval(() => {
      void loadDriveStatus();
    }, 2500);
    return () => clearInterval(interval);
  }, [driveSyncing, loadDriveStatus]);

  const handleSyncDrive = React.useCallback(async () => {
    if (!data.dashboardId) return;
    setDriveSyncing(true);
    void loadDriveStatus();
    void syncGoogleDrive(data.dashboardId)
      .then(() => loadDriveStatus())
      .catch((error) => {
        setFileError(error instanceof Error ? error.message : "Failed to sync Drive");
        void loadDriveStatus();
      });
  }, [data.dashboardId, loadDriveStatus]);

  const handleSyncLargeFiles = React.useCallback(async () => {
    if (!data.dashboardId || !driveStatus?.largeFiles?.length) return;
    const totalBytes = driveStatus.largeFiles.reduce((sum, file) => sum + (file.size || 0), 0);
    const totalMb = Math.round(totalBytes / (1024 * 1024));
    const ok = window.confirm(
      `This will sync ${driveStatus.largeFiles.length} large file(s) (~${totalMb} MB). Continue?`
    );
    if (!ok) return;
    setDriveSyncing(true);
    void loadDriveStatus();
    void syncGoogleDriveLargeFiles(
      data.dashboardId,
      driveStatus.largeFiles.map((file) => file.id)
    )
      .then(() => loadDriveStatus())
      .catch((error) => {
        setFileError(error instanceof Error ? error.message : "Failed to sync large files");
        void loadDriveStatus();
      });
  }, [data.dashboardId, driveStatus, loadDriveStatus]);

  const handleUnlinkDrive = React.useCallback(async () => {
    if (!data.dashboardId) return;
    const ok = window.confirm("Unlink this Drive folder from the dashboard?");
    if (!ok) return;
    try {
      await unlinkGoogleDriveFolder(data.dashboardId);
      setDriveStatus(null);
      await loadDriveIntegration();
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Failed to unlink Drive");
    }
  }, [data.dashboardId, loadDriveIntegration]);

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

  const driveCacheProgress = driveStatus?.totalBytes
    ? Math.min(100, Math.round(((driveStatus.cacheSyncedBytes || 0) / driveStatus.totalBytes) * 100))
    : 0;
  const driveWorkspaceProgress = driveStatus?.totalBytes
    ? Math.min(100, Math.round(((driveStatus.workspaceSyncedBytes || 0) / driveStatus.totalBytes) * 100))
    : 0;
  const driveFolderLabel = driveStatus?.folder?.name || driveIntegration?.folder?.name || null;
  const drivePickerUrl = React.useMemo(() => {
    const url = new URL(`${API.cloudflare.base}/integrations/google/drive/picker`);
    if (data.dashboardId) {
      url.searchParams.set("dashboard_id", data.dashboardId);
    }
    if (user) {
      url.searchParams.set("user_id", user.id);
      url.searchParams.set("user_email", user.email);
      url.searchParams.set("user_name", user.name);
    }
    return url.toString();
  }, [data.dashboardId, user]);

  return (
    <BlockWrapper
      selected={selected}
      className="p-0 flex flex-col overflow-visible"
      minWidth={460}
      minHeight={110}
      includeHandles={false}
    >
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--border)] bg-[var(--background)]">
        <span title="Workspace icon">
          <Folder className="w-3.5 h-3.5 text-[var(--foreground-subtle)]" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--foreground-muted)]" title="Workspace files and integrations">
          Workspace
        </span>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-h-0 border-r border-[var(--border)] bg-white text-[var(--foreground)] dark:bg-[var(--background)]">
          {(driveIntegration?.connected || sessionId) ? (
            <div className="h-full overflow-auto">
              {driveIntegration?.connected && (
                <div className="px-2 py-2 border-b border-[var(--border)]">
                  <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--foreground-muted)]">
                    <span className="truncate" title={driveFolderLabel || "Drive linked"}>
                      Drive: {driveFolderLabel || "Not linked"}
                    </span>
                    <div className="flex items-center gap-2">
                      {driveStatus?.connected && (
                        <button
                          type="button"
                          onClick={handleUnlinkDrive}
                          className="text-[10px] text-[var(--status-error)] hover:underline nodrag"
                        >
                          Unlink
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openIntegration("google-drive")}
                        className="text-[10px] text-[var(--accent-primary)] hover:underline nodrag"
                      >
                        Change
                      </button>
                    </div>
                  </div>
                  {driveStatus?.connected && (
                    <div className="mt-2 space-y-1 text-[10px] text-[var(--foreground-muted)]">
                      <div className="flex items-center justify-between">
                        <span>Status: {driveStatus.status || "idle"}</span>
                        <button
                          type="button"
                          onClick={handleSyncDrive}
                          className="text-[10px] text-[var(--accent-primary)] hover:underline nodrag"
                        >
                          Sync
                        </button>
                      </div>
                      <div className="h-1.5 bg-[var(--background-elevated)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent-primary)]"
                          style={{ width: `${driveCacheProgress}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Cache: {driveCacheProgress}%</span>
                        <span>Workspace: {driveWorkspaceProgress}%</span>
                      </div>
                      {driveStatus.largeFiles && driveStatus.largeFiles.length > 0 && (
                        <button
                          type="button"
                          onClick={handleSyncLargeFiles}
                          className="text-[10px] text-[var(--status-warning)] hover:underline nodrag"
                        >
                          Sync {driveStatus.largeFiles.length} large file(s)
                        </button>
                      )}
                      {driveStatus.syncError && (
                        <div className="text-[10px] text-[var(--status-error)]">
                          {driveStatus.syncError}
                        </div>
                      )}
                    </div>
                  )}
                  {!driveStatus?.connected && (
                    <div className="mt-2 text-[10px] text-[var(--foreground-muted)]">
                      Choose a folder to link this dashboard.
                    </div>
                  )}
                </div>
              )}
              {fileError && (
                <div className="px-2 py-1 text-[10px] text-[var(--status-error)]">
                  {fileError}
                </div>
              )}
              {sessionId && showFiles ? (
                renderFileTree("/", 0)
              ) : (
                <div className="px-2 py-2 text-[10px] text-[var(--foreground-muted)]">
                  {sessionId ? "Files will appear here." : "Start a terminal to load."}
                </div>
              )}
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
      <ConnectionHandles
        nodeId={id}
        visible={connectorsVisible}
        onConnectorClick={data.onConnectorClick}
      />
      <Dialog open={drivePickerOpen} onOpenChange={setDrivePickerOpen}>
        <DialogContent className="max-w-3xl h-[540px] p-0">
          <DialogTitle className="sr-only">Google Drive</DialogTitle>
          {driveIntegration?.connected ? (
            <iframe
              title="Google Drive Picker"
              src={drivePickerUrl}
              className="w-full h-full border-0"
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 bg-[var(--background)] p-6 text-center">
              <div className="text-sm font-semibold text-[var(--foreground)]">Connect Google Drive</div>
              <div className="text-xs text-[var(--foreground-muted)]">
                Sign in once to select a folder and sync it into this workspace.
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDriveConnect}
                className="nodrag"
              >
                Connect Drive
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </BlockWrapper>
  );
}

export default WorkspaceBlock;
