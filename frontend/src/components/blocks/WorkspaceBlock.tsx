// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { type NodeProps, type Node } from "@xyflow/react";
import { Folder, Cloud, Github, Box, HardDrive, Loader2 } from "lucide-react";
import { BlockWrapper } from "./BlockWrapper";
import { ConnectionHandles } from "./ConnectionHandles";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  listSessionFiles,
  deleteSessionFile,
  getGoogleDriveIntegration,
  getGoogleDriveSyncStatus,
  getGoogleDriveManifest,
  syncGoogleDrive,
  unlinkGoogleDriveFolder,
  getGithubIntegration,
  getGithubManifest,
  getGithubSyncStatus,
  listGithubRepos,
  setGithubRepo,
  unlinkGithubRepo,
  getBoxIntegration,
  getBoxManifest,
  getBoxSyncStatus,
  listBoxFolders,
  setBoxFolder,
  unlinkBoxFolder,
  getOnedriveIntegration,
  getOnedriveManifest,
  getOnedriveSyncStatus,
  listOnedriveFolders,
  setOnedriveFolder,
  unlinkOnedriveFolder,
  type GoogleDriveIntegration,
  type GoogleDriveSyncStatus,
  type GoogleDriveManifest,
  type GithubIntegration,
  type GithubRepo,
  type GithubSyncStatus,
  type BoxIntegration,
  type BoxFolder,
  type BoxSyncStatus,
  type OnedriveIntegration,
  type OnedriveFolder,
  type OnedriveSyncStatus,
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
  const [githubIntegration, setGithubIntegration] = React.useState<GithubIntegration | null>(null);
  const [githubStatus, setGithubStatus] = React.useState<GithubSyncStatus | null>(null);
  const [githubSyncing, setGithubSyncing] = React.useState(false);
  const [githubPickerOpen, setGithubPickerOpen] = React.useState(false);
  const [githubRepos, setGithubRepos] = React.useState<GithubRepo[]>([]);
  const [githubLoading, setGithubLoading] = React.useState(false);
  const [githubSelected, setGithubSelected] = React.useState<GithubRepo | null>(null);
  const [githubImporting, setGithubImporting] = React.useState(false);
  const [boxIntegration, setBoxIntegration] = React.useState<BoxIntegration | null>(null);
  const [boxStatus, setBoxStatus] = React.useState<BoxSyncStatus | null>(null);
  const [boxPickerOpen, setBoxPickerOpen] = React.useState(false);
  const [boxFolders, setBoxFolders] = React.useState<BoxFolder[]>([]);
  const [boxPath, setBoxPath] = React.useState<BoxFolder[]>([]);
  const [boxParentId, setBoxParentId] = React.useState("0");
  const [boxLoading, setBoxLoading] = React.useState(false);
  const [onedriveIntegration, setOnedriveIntegration] = React.useState<OnedriveIntegration | null>(null);
  const [onedriveStatus, setOnedriveStatus] = React.useState<OnedriveSyncStatus | null>(null);
  const [onedrivePickerOpen, setOnedrivePickerOpen] = React.useState(false);
  const [onedriveFolders, setOnedriveFolders] = React.useState<OnedriveFolder[]>([]);
  const [onedrivePath, setOnedrivePath] = React.useState<OnedriveFolder[]>([]);
  const [onedriveParentId, setOnedriveParentId] = React.useState("root");
  const [onedriveLoading, setOnedriveLoading] = React.useState(false);
  const previewFetchRef = React.useRef(0);
  const connectorsVisible = selected || Boolean(data.connectorMode);
  const apiOrigin = React.useMemo(() => new URL(API.cloudflare.base).origin, []);
  const allowDelete = Boolean(sessionId);

  const openIntegration = React.useCallback(
    (provider: IntegrationProvider) => {
      if (!user) return;
      if (provider === "google-drive") {
        setDrivePickerOpen(true);
        return;
      }
      if (provider === "github") {
        setGithubPickerOpen(true);
        return;
      }
      if (provider === "box") {
        setBoxPickerOpen(true);
        return;
      }
      if (provider === "onedrive") {
        setOnedrivePickerOpen(true);
      }
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

  const handleGithubConnect = React.useCallback(() => {
    if (!user) return;
    const url = new URL(`${API.cloudflare.base}/integrations/github/connect`);
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
      "orcabot-github-auth",
      `width=${width},height=${height},left=${left},top=${top},noopener,noreferrer`
    );
  }, [data.dashboardId, user]);

  const handleBoxConnect = React.useCallback(() => {
    if (!user) return;
    const url = new URL(`${API.cloudflare.base}/integrations/box/connect`);
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
      "orcabot-box-auth",
      `width=${width},height=${height},left=${left},top=${top},noopener,noreferrer`
    );
  }, [data.dashboardId, user]);

  const handleOnedriveConnect = React.useCallback(() => {
    if (!user) return;
    const url = new URL(`${API.cloudflare.base}/integrations/onedrive/connect`);
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
      "orcabot-onedrive-auth",
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

  const buildDrivePreviewEntries = React.useCallback((manifest: GoogleDriveManifest) => {
    const entryMap: Record<string, SessionFileEntry[]> = {};
    const addEntry = (parent: string, entry: SessionFileEntry) => {
      entryMap[parent] = entryMap[parent] ?? [];
      entryMap[parent].push(entry);
    };
    const ensureDir = (dirPath: string) => {
      if (dirPath === "/") return;
      const parent = dirPath.split("/").slice(0, -1).join("/") || "/";
      const name = dirPath.split("/").slice(-1)[0];
      if (!entryMap[parent]?.some((entry) => entry.is_dir && entry.name === name)) {
        addEntry(parent, {
          name,
          path: dirPath,
          size: 0,
          is_dir: true,
          mod_time: "",
          mode: "",
        });
      }
    };

    const basePath = `/${manifest.folderPath}`;
    const baseParts = basePath.split("/").filter(Boolean);
    let currentPath = "";
    for (const part of baseParts) {
      currentPath = `${currentPath}/${part}`;
      ensureDir(currentPath);
    }

    manifest.directories.forEach((dir) => {
      const fullPath = dir ? `${basePath}/${dir}` : basePath;
      ensureDir(fullPath);
    });

    manifest.entries.forEach((entry) => {
      const fullPath = entry.path ? `${basePath}/${entry.path}` : basePath;
      const parent = fullPath.split("/").slice(0, -1).join("/") || "/";
      addEntry(parent, {
        name: entry.name,
        path: fullPath,
        size: entry.size,
        is_dir: false,
        mod_time: entry.modifiedTime ?? "",
        mode: "",
      });
    });

    return entryMap;
  }, []);

  const mergePreviewEntries = React.useCallback(
    (target: Record<string, SessionFileEntry[]>, source: Record<string, SessionFileEntry[]>) => {
      Object.entries(source).forEach(([path, entries]) => {
        if (!target[path]) {
          target[path] = [...entries];
          return;
        }
        target[path] = [...target[path], ...entries];
      });
      Object.keys(target).forEach((key) => {
        target[key].sort((a, b) => {
          if (a.is_dir && !b.is_dir) return -1;
          if (!a.is_dir && b.is_dir) return 1;
          return a.name.localeCompare(b.name);
        });
      });
    },
    []
  );

  React.useEffect(() => {
    setExpandedPaths(new Set(["/"]));
    setFileEntries({});
    setFileError(null);
    if (sessionId) {
      loadFiles("/");
    }
  }, [sessionId, loadFiles]);

  React.useEffect(() => {
    const dashboardId = data.dashboardId;
    if (sessionId || !dashboardId) {
      return;
    }
    const canFetchDrive = driveIntegration?.connected && driveStatus?.status !== "syncing_cache";
    const canFetchGithub = githubIntegration?.connected && githubStatus?.status !== "syncing_cache";
    const canFetchBox = boxIntegration?.connected && boxStatus?.status !== "syncing_cache";
    const canFetchOnedrive = onedriveIntegration?.connected && onedriveStatus?.status !== "syncing_cache";
    if (!canFetchDrive && !canFetchGithub && !canFetchBox && !canFetchOnedrive) {
      return;
    }

    const now = Date.now();
    if (now - previewFetchRef.current < 10000) {
      return;
    }
    previewFetchRef.current = now;

    let isActive = true;
    const run = async () => {
      const combined: Record<string, SessionFileEntry[]> = {};
      try {
        if (canFetchDrive) {
          const driveResponse = await getGoogleDriveManifest(dashboardId);
          if (driveResponse.manifest) {
            mergePreviewEntries(combined, buildDrivePreviewEntries(driveResponse.manifest));
          }
        }
        if (canFetchGithub) {
          const githubResponse = await getGithubManifest(dashboardId);
          if (githubResponse.manifest) {
            mergePreviewEntries(combined, buildDrivePreviewEntries(githubResponse.manifest));
          }
        }
        if (canFetchBox) {
          const boxResponse = await getBoxManifest(dashboardId);
          if (boxResponse.manifest) {
            mergePreviewEntries(combined, buildDrivePreviewEntries(boxResponse.manifest));
          }
        }
        if (canFetchOnedrive) {
          const onedriveResponse = await getOnedriveManifest(dashboardId);
          if (onedriveResponse.manifest) {
            mergePreviewEntries(combined, buildDrivePreviewEntries(onedriveResponse.manifest));
          }
        }
        if (!isActive) return;
        setFileError(null);
        setFileEntries(combined);
      } catch (error) {
        if (!isActive) return;
        setFileError(error instanceof Error ? error.message : "Failed to load preview");
      }
    };

    void run();
    return () => {
      isActive = false;
    };
  }, [
    buildDrivePreviewEntries,
    data.dashboardId,
    driveIntegration?.connected,
    driveStatus?.status,
    githubIntegration?.connected,
    githubStatus?.status,
    boxIntegration?.connected,
    boxStatus?.status,
    onedriveIntegration?.connected,
    onedriveStatus?.status,
    mergePreviewEntries,
    githubSyncing,
    sessionId,
  ]);

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

  const loadGithubIntegration = React.useCallback(async () => {
    if (!user) return;
    try {
      const integration = await getGithubIntegration(data.dashboardId);
      setGithubIntegration(integration);
    } catch {
      setGithubIntegration(null);
    }
  }, [data.dashboardId, user]);

  const loadGithubStatus = React.useCallback(async () => {
    if (!user || !data.dashboardId) return;
    try {
      const status = await getGithubSyncStatus(data.dashboardId);
      setGithubStatus(status);
      setGithubSyncing(status.status === "syncing_cache" || status.status === "syncing_workspace");
    } catch {
      setGithubStatus(null);
      setGithubSyncing(false);
    }
  }, [data.dashboardId, user]);

  const loadGithubRepos = React.useCallback(async () => {
    setGithubLoading(true);
    try {
      const response = await listGithubRepos();
      setGithubRepos(response.repos || []);
    } catch {
      setGithubRepos([]);
    } finally {
      setGithubLoading(false);
    }
  }, []);

  const loadBoxIntegration = React.useCallback(async () => {
    if (!user) return;
    try {
      const integration = await getBoxIntegration(data.dashboardId);
      setBoxIntegration(integration);
    } catch {
      setBoxIntegration(null);
    }
  }, [data.dashboardId, user]);

  const loadBoxStatus = React.useCallback(async () => {
    if (!user || !data.dashboardId) return;
    try {
      const status = await getBoxSyncStatus(data.dashboardId);
      setBoxStatus(status);
    } catch {
      setBoxStatus(null);
    }
  }, [data.dashboardId, user]);

  const loadBoxFolders = React.useCallback(async (parentId: string) => {
    setBoxLoading(true);
    try {
      const response = await listBoxFolders(parentId);
      setBoxFolders(response.folders || []);
      setBoxParentId(response.parentId);
    } catch {
      setBoxFolders([]);
    } finally {
      setBoxLoading(false);
    }
  }, []);

  const loadOnedriveIntegration = React.useCallback(async () => {
    if (!user) return;
    try {
      const integration = await getOnedriveIntegration(data.dashboardId);
      setOnedriveIntegration(integration);
    } catch {
      setOnedriveIntegration(null);
    }
  }, [data.dashboardId, user]);

  const loadOnedriveStatus = React.useCallback(async () => {
    if (!user || !data.dashboardId) return;
    try {
      const status = await getOnedriveSyncStatus(data.dashboardId);
      setOnedriveStatus(status);
    } catch {
      setOnedriveStatus(null);
    }
  }, [data.dashboardId, user]);

  const loadOnedriveFolders = React.useCallback(async (parentId: string) => {
    setOnedriveLoading(true);
    try {
      const response = await listOnedriveFolders(parentId);
      setOnedriveFolders(response.folders || []);
      setOnedriveParentId(response.parentId);
    } catch {
      setOnedriveFolders([]);
    } finally {
      setOnedriveLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadDriveIntegration();
    void loadDriveStatus();
    void loadGithubIntegration();
    void loadGithubStatus();
    void loadBoxIntegration();
    void loadBoxStatus();
    void loadOnedriveIntegration();
    void loadOnedriveStatus();
  }, [
    loadDriveIntegration,
    loadDriveStatus,
    loadGithubIntegration,
    loadGithubStatus,
    loadBoxIntegration,
    loadBoxStatus,
    loadOnedriveIntegration,
    loadOnedriveStatus,
  ]);

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
        return;
      }
      if (payload?.type === "github-auth-complete") {
        void loadGithubIntegration();
        setGithubPickerOpen(true);
        void loadGithubRepos();
        return;
      }
      if (payload?.type === "box-auth-complete") {
        void loadBoxIntegration();
        setBoxPickerOpen(true);
        setBoxPath([]);
        void loadBoxFolders("0");
        return;
      }
      if (payload?.type === "onedrive-auth-complete") {
        void loadOnedriveIntegration();
        setOnedrivePickerOpen(true);
        setOnedrivePath([]);
        void loadOnedriveFolders("root");
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    apiOrigin,
    data.dashboardId,
    loadDriveIntegration,
    loadDriveStatus,
    loadGithubIntegration,
    loadGithubRepos,
    loadBoxIntegration,
    loadBoxFolders,
    loadOnedriveIntegration,
    loadOnedriveFolders,
  ]);

  React.useEffect(() => {
    if (!driveSyncing) return;
    const interval = setInterval(() => {
      void loadDriveStatus();
    }, 2500);
    return () => clearInterval(interval);
  }, [driveSyncing, loadDriveStatus]);

  React.useEffect(() => {
    if (!githubSyncing) return;
    const interval = setInterval(() => {
      void loadGithubStatus();
    }, 2500);
    return () => clearInterval(interval);
  }, [githubSyncing, loadGithubStatus]);

  React.useEffect(() => {
    if (!githubPickerOpen || !githubIntegration?.connected) return;
    setGithubSelected(null);
    void loadGithubRepos();
  }, [githubPickerOpen, githubIntegration?.connected, loadGithubRepos]);

  React.useEffect(() => {
    if (!boxPickerOpen || !boxIntegration?.connected) return;
    setBoxPath([]);
    void loadBoxFolders("0");
  }, [boxPickerOpen, boxIntegration?.connected, loadBoxFolders]);

  React.useEffect(() => {
    if (!onedrivePickerOpen || !onedriveIntegration?.connected) return;
    setOnedrivePath([]);
    void loadOnedriveFolders("root");
  }, [onedrivePickerOpen, onedriveIntegration?.connected, loadOnedriveFolders]);

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

  const handleUnlinkGithub = React.useCallback(async () => {
    if (!data.dashboardId) return;
    const ok = window.confirm("Unlink this GitHub repo from the dashboard?");
    if (!ok) return;
    try {
      await unlinkGithubRepo(data.dashboardId);
      setGithubStatus(null);
      await loadGithubIntegration();
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Failed to unlink GitHub");
    }
  }, [data.dashboardId, loadGithubIntegration]);

  const handleSelectGithubRepo = React.useCallback(async (repo: GithubRepo) => {
    if (!data.dashboardId) return;
    try {
      await setGithubRepo(data.dashboardId, repo);
      await loadGithubIntegration();
      await loadGithubStatus();
      setGithubPickerOpen(false);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Failed to link GitHub repo");
    }
  }, [data.dashboardId, loadGithubIntegration, loadGithubStatus]);

  const handleConfirmGithubRepo = React.useCallback(async () => {
    if (!githubSelected) return;
    setGithubImporting(true);
    try {
      await handleSelectGithubRepo(githubSelected);
    } finally {
      setGithubImporting(false);
    }
  }, [githubSelected, handleSelectGithubRepo]);

  const handleUnlinkBox = React.useCallback(async () => {
    if (!data.dashboardId) return;
    const ok = window.confirm("Unlink this Box folder from the dashboard?");
    if (!ok) return;
    try {
      await unlinkBoxFolder(data.dashboardId);
      setBoxStatus(null);
      await loadBoxIntegration();
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Failed to unlink Box");
    }
  }, [data.dashboardId, loadBoxIntegration]);

  const handleSelectBoxFolder = React.useCallback(async (folder: BoxFolder) => {
    if (!data.dashboardId) return;
    try {
      await setBoxFolder(data.dashboardId, folder);
      await loadBoxIntegration();
      await loadBoxStatus();
      setBoxPickerOpen(false);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Failed to link Box folder");
    }
  }, [data.dashboardId, loadBoxIntegration, loadBoxStatus]);

  const handleUnlinkOnedrive = React.useCallback(async () => {
    if (!data.dashboardId) return;
    const ok = window.confirm("Unlink this OneDrive folder from the dashboard?");
    if (!ok) return;
    try {
      await unlinkOnedriveFolder(data.dashboardId);
      setOnedriveStatus(null);
      await loadOnedriveIntegration();
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Failed to unlink OneDrive");
    }
  }, [data.dashboardId, loadOnedriveIntegration]);

  const handleSelectOnedriveFolder = React.useCallback(async (folder: OnedriveFolder) => {
    if (!data.dashboardId) return;
    try {
      await setOnedriveFolder(data.dashboardId, folder);
      await loadOnedriveIntegration();
      await loadOnedriveStatus();
      setOnedrivePickerOpen(false);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Failed to link OneDrive folder");
    }
  }, [data.dashboardId, loadOnedriveIntegration, loadOnedriveStatus]);

  const handleOpenBoxFolder = React.useCallback((folder: BoxFolder) => {
    const nextPath = [...boxPath, folder];
    setBoxPath(nextPath);
    void loadBoxFolders(folder.id);
  }, [boxPath, loadBoxFolders]);

  const handleBackBoxFolder = React.useCallback(() => {
    const nextPath = boxPath.slice(0, -1);
    setBoxPath(nextPath);
    const parentId = nextPath.length > 0 ? nextPath[nextPath.length - 1].id : "0";
    void loadBoxFolders(parentId);
  }, [boxPath, loadBoxFolders]);

  const handleOpenOnedriveFolder = React.useCallback((folder: OnedriveFolder) => {
    const nextPath = [...onedrivePath, folder];
    setOnedrivePath(nextPath);
    void loadOnedriveFolders(folder.id);
  }, [onedrivePath, loadOnedriveFolders]);

  const handleBackOnedriveFolder = React.useCallback(() => {
    const nextPath = onedrivePath.slice(0, -1);
    setOnedrivePath(nextPath);
    const parentId = nextPath.length > 0 ? nextPath[nextPath.length - 1].id : "root";
    void loadOnedriveFolders(parentId);
  }, [onedrivePath, loadOnedriveFolders]);

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
              {!isDir && allowDelete && (
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
    [allowDelete, expandedPaths, fileEntries, handleDeletePath, togglePath]
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
  const isDriveLinked = Boolean(driveIntegration?.connected && driveIntegration?.folder);
  const isGithubLinked = Boolean(githubIntegration?.connected && githubIntegration?.repo);
  const isBoxLinked = Boolean(boxIntegration?.connected && boxIntegration?.folder);
  const isOnedriveLinked = Boolean(onedriveIntegration?.connected && onedriveIntegration?.folder);
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
              {fileError && (
                <div className="px-2 py-1 text-[10px] text-[var(--status-error)]">
                  {fileError}
                </div>
              )}
              {showFiles ? (
                <div>
                  {renderFileTree("/", 0)}
                  {!sessionId && (
                    <div className="px-2 py-2 text-[10px] text-[var(--foreground-muted)]">
                      {githubSyncing ? "Syncing repo..." : "Start a terminal to make edits."}
                    </div>
                  )}
                </div>
              ) : (
                <div className="px-2 py-2 text-[10px] text-[var(--foreground-muted)]">
                  {sessionId
                    ? "Files will appear here."
                    : githubSyncing
                      ? "Syncing repo..."
                      : "Start a terminal to make edits."}
                </div>
              )}
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-[10px] text-[var(--foreground-muted)] px-3 text-center">
              {sessionId ? "Files will appear here." : "Start a terminal to make edits."}
            </div>
          )}
        </div>
        <div className="w-36 bg-[var(--background)] px-2 py-2">
          <div className="grid grid-cols-2 gap-2">
            {isDriveLinked ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!user}
                    className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
                    title="Manage Google Drive"
                  >
                    <Cloud className="w-4 h-4" />
                    <span>Drive</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem disabled className="text-[10px] text-[var(--foreground-muted)]">
                    Drive: {driveIntegration?.folder?.name ?? "Linked"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openIntegration("google-drive")}>
                    Change folder
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleUnlinkDrive}
                    className="text-[var(--status-error)] focus:text-[var(--status-error)]"
                  >
                    Unlink
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
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
            )}
            {isGithubLinked ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!user}
                    className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
                    title="Manage GitHub"
                  >
                    <Github className="w-4 h-4" />
                    <span>GitHub</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem disabled className="text-[10px] text-[var(--foreground-muted)]">
                    Repo: {githubIntegration?.repo?.owner}/{githubIntegration?.repo?.name}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openIntegration("github")}>
                    Change repo
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleUnlinkGithub}
                    className="text-[var(--status-error)] focus:text-[var(--status-error)]"
                  >
                    Unlink
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
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
            )}
            {isBoxLinked ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!user}
                    className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
                    title="Manage Box"
                  >
                    <Box className="w-4 h-4" />
                    <span>Box</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem disabled className="text-[10px] text-[var(--foreground-muted)]">
                    Folder: {boxIntegration?.folder?.name ?? "Linked"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openIntegration("box")}>
                    Change folder
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleUnlinkBox}
                    className="text-[var(--status-error)] focus:text-[var(--status-error)]"
                  >
                    Unlink
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openIntegration("box")}
                disabled={!user}
                className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
                title="Connect Box"
              >
                <Box className="w-4 h-4" />
                <span>Box</span>
              </Button>
            )}
            {isOnedriveLinked ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!user}
                    className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
                    title="Manage OneDrive"
                  >
                    <HardDrive className="w-4 h-4" />
                    <span>OneDrive</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuItem disabled className="text-[10px] text-[var(--foreground-muted)]">
                    Folder: {onedriveIntegration?.folder?.name ?? "Linked"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openIntegration("onedrive")}>
                    Change folder
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={handleUnlinkOnedrive}
                    className="text-[var(--status-error)] focus:text-[var(--status-error)]"
                  >
                    Unlink
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openIntegration("onedrive")}
                disabled={!user}
                className="h-10 w-full flex flex-col items-center justify-center gap-1 text-[10px] nodrag"
                title="Connect OneDrive"
              >
                <HardDrive className="w-4 h-4" />
                <span>OneDrive</span>
              </Button>
            )}
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
      <Dialog open={githubPickerOpen} onOpenChange={setGithubPickerOpen}>
        <DialogContent className="max-w-xl h-[540px] p-0">
          <DialogTitle className="sr-only">GitHub</DialogTitle>
          {githubIntegration?.connected ? (
            <div className="h-full flex flex-col gap-3 bg-[var(--background)] p-6">
              <div className="text-sm font-semibold text-[var(--foreground)]">Select a GitHub repo</div>
              <div className="text-xs text-[var(--foreground-muted)]">
                Choose a repository to sync into this workspace.
              </div>
              <div className="flex-1 overflow-auto border border-[var(--border)] rounded-md">
                {githubLoading ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">Loading repos...</div>
                ) : githubRepos.length === 0 ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">No repos found.</div>
                ) : (
                  <div className="divide-y divide-[var(--border)]">
                    {githubRepos.map((repo) => (
                      <button
                        key={`${repo.owner}/${repo.name}`}
                        type="button"
                        onClick={() => setGithubSelected(repo)}
                        disabled={githubImporting}
                        className={`w-full text-left px-4 py-3 transition-colors ${
                          githubSelected?.owner === repo.owner && githubSelected?.name === repo.name
                            ? "bg-[var(--background-hover)]"
                            : "hover:bg-[var(--background-hover)]"
                        }`}
                      >
                        <div className="text-sm text-[var(--foreground)]">
                          {repo.owner}/{repo.name}
                        </div>
                        <div className="text-[10px] text-[var(--foreground-muted)]">
                          {repo.branch ? `Branch: ${repo.branch}` : "Default branch"}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {githubImporting && (
                <div className="text-xs text-[var(--foreground-muted)]">
                  Importing repo...
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setGithubPickerOpen(false)}
                  disabled={githubImporting}
                  className="nodrag"
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!githubSelected || githubImporting}
                  onClick={handleConfirmGithubRepo}
                  className="nodrag"
                >
                  {githubImporting ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    "Import repo"
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 bg-[var(--background)] p-6 text-center">
              <div className="text-sm font-semibold text-[var(--foreground)]">Connect GitHub</div>
              <div className="text-xs text-[var(--foreground-muted)]">
                Sign in to choose a repository and sync it into this workspace.
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleGithubConnect}
                className="nodrag"
              >
                Connect GitHub
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={boxPickerOpen} onOpenChange={setBoxPickerOpen}>
        <DialogContent className="max-w-xl h-[540px] p-0">
          <DialogTitle className="sr-only">Box</DialogTitle>
          {boxIntegration?.connected ? (
            <div className="h-full flex flex-col gap-3 bg-[var(--background)] p-6">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-[var(--foreground)]">Select a Box folder</div>
                {boxPath.length > 0 && (
                  <Button variant="secondary" size="sm" onClick={handleBackBoxFolder} className="nodrag">
                    Back
                  </Button>
                )}
              </div>
              <div className="text-xs text-[var(--foreground-muted)]">
                Current folder: {boxPath.length > 0 ? boxPath[boxPath.length - 1].name : "Box"}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() =>
                    handleSelectBoxFolder(
                      boxPath.length > 0 ? boxPath[boxPath.length - 1] : { id: "0", name: "Box" }
                    )
                  }
                  className="nodrag"
                >
                  Select this folder
                </Button>
              </div>
              <div className="flex-1 overflow-auto border border-[var(--border)] rounded-md">
                {boxLoading ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">Loading folders...</div>
                ) : boxFolders.length === 0 ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">No folders found.</div>
                ) : (
                  <div className="divide-y divide-[var(--border)]">
                    {boxFolders.map((folder) => (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => handleOpenBoxFolder(folder)}
                        className="w-full text-left px-4 py-3 hover:bg-[var(--background-hover)] transition-colors"
                      >
                        <div className="text-sm text-[var(--foreground)]">{folder.name}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 bg-[var(--background)] p-6 text-center">
              <div className="text-sm font-semibold text-[var(--foreground)]">Connect Box</div>
              <div className="text-xs text-[var(--foreground-muted)]">
                Sign in to choose a folder and sync it into this workspace.
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleBoxConnect}
                className="nodrag"
              >
                Connect Box
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={onedrivePickerOpen} onOpenChange={setOnedrivePickerOpen}>
        <DialogContent className="max-w-xl h-[540px] p-0">
          <DialogTitle className="sr-only">OneDrive</DialogTitle>
          {onedriveIntegration?.connected ? (
            <div className="h-full flex flex-col gap-3 bg-[var(--background)] p-6">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-[var(--foreground)]">Select a OneDrive folder</div>
                {onedrivePath.length > 0 && (
                  <Button variant="secondary" size="sm" onClick={handleBackOnedriveFolder} className="nodrag">
                    Back
                  </Button>
                )}
              </div>
              <div className="text-xs text-[var(--foreground-muted)]">
                Current folder: {onedrivePath.length > 0 ? onedrivePath[onedrivePath.length - 1].name : "OneDrive"}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() =>
                    handleSelectOnedriveFolder(
                      onedrivePath.length > 0 ? onedrivePath[onedrivePath.length - 1] : { id: "root", name: "OneDrive" }
                    )
                  }
                  className="nodrag"
                >
                  Select this folder
                </Button>
              </div>
              <div className="flex-1 overflow-auto border border-[var(--border)] rounded-md">
                {onedriveLoading ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">Loading folders...</div>
                ) : onedriveFolders.length === 0 ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">No folders found.</div>
                ) : (
                  <div className="divide-y divide-[var(--border)]">
                    {onedriveFolders.map((folder) => (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => handleOpenOnedriveFolder(folder)}
                        className="w-full text-left px-4 py-3 hover:bg-[var(--background-hover)] transition-colors"
                      >
                        <div className="text-sm text-[var(--foreground)]">{folder.name}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 bg-[var(--background)] p-6 text-center">
              <div className="text-sm font-semibold text-[var(--foreground)]">Connect OneDrive</div>
              <div className="text-xs text-[var(--foreground-muted)]">
                Sign in to choose a folder and sync it into this workspace.
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleOnedriveConnect}
                className="nodrag"
              >
                Connect OneDrive
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </BlockWrapper>
  );
}

export default WorkspaceBlock;
