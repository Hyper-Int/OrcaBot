// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: workspace-sidebar-v5-live-cwd-tracking
const MODULE_REVISION = "workspace-sidebar-v5-live-cwd-tracking";
console.log(`[WorkspaceSidebar] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import { createPortal } from "react-dom";
import {
  Folder,
  Cloud,
  Github,
  Box,
  HardDrive,
  Loader2,
  Settings,
  Eye,
  EyeOff,
  PanelLeftClose,
  PanelLeftOpen,
  Terminal,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
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
  disconnectGoogleDrive,
  getGithubIntegration,
  getGithubManifest,
  getGithubSyncStatus,
  listGithubRepos,
  setGithubRepo,
  unlinkGithubRepo,
  disconnectGithub,
  getBoxIntegration,
  getBoxManifest,
  getBoxSyncStatus,
  listBoxFolders,
  setBoxFolder,
  unlinkBoxFolder,
  disconnectBox,
  getOnedriveIntegration,
  getOnedriveManifest,
  getOnedriveSyncStatus,
  listOnedriveFolders,
  setOnedriveFolder,
  unlinkOnedriveFolder,
  disconnectOnedrive,
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
import type { DashboardItem, Session } from "@/types/dashboard";
import { useAuthStore } from "@/stores/auth-store";
import { API } from "@/config/env";
import { cn } from "@/lib/utils";
import { getAgentType, getAgentIconSrc, getAgentDisplayName } from "@/lib/agent-icons";

// Module-level cache (shared with WorkspaceBlock for backwards compat)
const integrationLoadCache = new Map<string, number>();
const INTEGRATION_LOAD_COOLDOWN_MS = 30000;
const INTEGRATION_CACHE_KEY = "orcabot:integration-load-cache";

function getLastLoadTime(dashboardId: string): number | null {
  const memCached = integrationLoadCache.get(dashboardId);
  if (memCached) return memCached;
  try {
    const stored = sessionStorage.getItem(INTEGRATION_CACHE_KEY);
    if (stored) {
      const cache = JSON.parse(stored) as Record<string, number>;
      return cache[dashboardId] ?? null;
    }
  } catch {}
  return null;
}

function setLastLoadTime(dashboardId: string, timestamp: number): void {
  integrationLoadCache.set(dashboardId, timestamp);
  try {
    const stored = sessionStorage.getItem(INTEGRATION_CACHE_KEY);
    const cache = stored ? (JSON.parse(stored) as Record<string, number>) : {};
    cache[dashboardId] = timestamp;
    const entries = Object.entries(cache).sort((a, b) => b[1] - a[1]).slice(0, 10);
    sessionStorage.setItem(INTEGRATION_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

// localStorage key for sidebar width
const SIDEBAR_WIDTH_KEY = "orcabot:sidebar-width";
const DEFAULT_WIDTH = 200;
const MIN_WIDTH = 160;
const MAX_WIDTH = 400;

interface WorkspaceSidebarProps {
  dashboardId: string;
  sessionId: string | undefined;
  items: DashboardItem[];
  sessions: Session[];
  onStorageLinked?: (provider: "google_drive" | "onedrive" | "box" | "github") => void;
  onSelectedPathChange?: (path: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  drivePortalTarget?: HTMLDivElement | null;
  /** Live terminal working directories from WebSocket cwd_changed events (itemId → cwd) */
  terminalCwds?: Record<string, string>;
}

export function WorkspaceSidebar({
  dashboardId,
  sessionId,
  items,
  sessions,
  onStorageLinked,
  onSelectedPathChange,
  collapsed,
  onToggleCollapse,
  drivePortalTarget,
  terminalCwds,
}: WorkspaceSidebarProps) {
  const { user } = useAuthStore();
  const [selectedPath, setSelectedPath] = React.useState<string>("/");

  const handleSelectPath = React.useCallback((path: string) => {
    setSelectedPath(path);
    onSelectedPathChange?.(path);
  }, [onSelectedPathChange]);

  // ── Sidebar resize ──────────────────────────────────────────────
  const [width, setWidth] = React.useState(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      return saved ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(saved))) : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  const isResizing = React.useRef(false);

  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = width;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + e.clientX - startX));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
      } catch {}
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [width]);

  // Persist width on change
  React.useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {}
  }, [width]);

  // ── File tree state ─────────────────────────────────────────────
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set(["/"]));
  const [fileEntries, setFileEntries] = React.useState<Record<string, SessionFileEntry[]>>({});
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = React.useState(false);
  const allowDelete = Boolean(sessionId);

  // ── Integration state ───────────────────────────────────────────
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
  const [boxSyncing, setBoxSyncing] = React.useState(false);
  const [boxPickerOpen, setBoxPickerOpen] = React.useState(false);
  const [boxFolders, setBoxFolders] = React.useState<BoxFolder[]>([]);
  const [boxPath, setBoxPath] = React.useState<BoxFolder[]>([]);
  const [boxParentId, setBoxParentId] = React.useState("0");
  const [boxLoading, setBoxLoading] = React.useState(false);
  const [onedriveIntegration, setOnedriveIntegration] = React.useState<OnedriveIntegration | null>(null);
  const [onedriveStatus, setOnedriveStatus] = React.useState<OnedriveSyncStatus | null>(null);
  const [onedriveSyncing, setOnedriveSyncing] = React.useState(false);
  const [onedrivePickerOpen, setOnedrivePickerOpen] = React.useState(false);
  const [onedriveFolders, setOnedriveFolders] = React.useState<OnedriveFolder[]>([]);
  const [onedrivePath, setOnedrivePath] = React.useState<OnedriveFolder[]>([]);
  const [onedriveParentId, setOnedriveParentId] = React.useState("root");
  const [onedriveLoading, setOnedriveLoading] = React.useState(false);

  const previewFetchRef = React.useRef(0);
  const integrationLoadedRef = React.useRef<string | null>(null);
  const integrationLoadingRef = React.useRef(false);
  const apiOrigin = React.useMemo(() => new URL(API.cloudflare.base).origin, []);

  // ── Derived integration state ───────────────────────────────────
  const isDriveConnected = Boolean(driveIntegration?.connected);
  const isDriveLinked = Boolean(driveIntegration?.connected && driveIntegration?.folder);
  const isGithubConnected = Boolean(githubIntegration?.connected);
  const isGithubLinked = Boolean(githubIntegration?.connected && githubIntegration?.repo);
  const isBoxConnected = Boolean(boxIntegration?.connected);
  const isBoxLinked = Boolean(boxIntegration?.connected && boxIntegration?.folder);
  const isOnedriveConnected = Boolean(onedriveIntegration?.connected);
  const isOnedriveLinked = Boolean(onedriveIntegration?.connected && onedriveIntegration?.folder);

  const drivePickerUrl = React.useMemo(() => {
    const url = new URL(`${API.cloudflare.base}/integrations/google/drive/picker`);
    if (dashboardId) url.searchParams.set("dashboard_id", dashboardId);
    if (user) {
      url.searchParams.set("user_id", user.id);
      url.searchParams.set("user_email", user.email);
      url.searchParams.set("user_name", user.name);
    }
    return url.toString();
  }, [dashboardId, user]);

  // ── Agent indicators ────────────────────────────────────────────
  const agentIndicators = React.useMemo(() => {
    const terminalItems = items.filter((i) => i.type === "terminal");
    return terminalItems.map((item) => {
      let parsed: { name?: string; bootCommand?: string } = {};
      try {
        parsed = JSON.parse(item.content);
      } catch {}
      const agentType = getAgentType(parsed.bootCommand, parsed.name);
      const hasActiveSession = sessions.some(
        (s) => s.itemId === item.id && s.status === "active"
      );
      // Use live cwd from WebSocket if available, otherwise fall back to bootCommand parsing
      let cwdPath = "/";
      const liveCwd = terminalCwds?.[item.id];
      if (liveCwd) {
        cwdPath = liveCwd;
      } else {
        const bootCmd = parsed.bootCommand || "";
        const cwdMatch = bootCmd.match(/cd\s+"\$HOME\/([^"]+)"/);
        if (cwdMatch) {
          cwdPath = "/" + cwdMatch[1];
        }
      }
      return {
        id: item.id,
        agentType,
        name: parsed.name || getAgentDisplayName(agentType),
        active: hasActiveSession,
        iconSrc: getAgentIconSrc(agentType),
        cwdPath,
      };
    });
  }, [items, sessions, terminalCwds]);

  // ── File loading ────────────────────────────────────────────────
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
        addEntry(parent, { name, path: dirPath, size: 0, is_dir: true, mod_time: "", mode: "" });
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

  // ── Integration loaders ─────────────────────────────────────────
  const loadDriveIntegration = React.useCallback(async () => {
    if (!user) return;
    try {
      const integration = await getGoogleDriveIntegration(dashboardId);
      setDriveIntegration(integration);
    } catch { setDriveIntegration(null); }
  }, [dashboardId, user]);

  const loadDriveStatus = React.useCallback(async () => {
    if (!user || !dashboardId) return;
    try {
      const status = await getGoogleDriveSyncStatus(dashboardId);
      setDriveStatus(status);
      setDriveSyncing(status.status === "syncing_cache" || status.status === "syncing_workspace");
    } catch { setDriveStatus(null); setDriveSyncing(false); }
  }, [dashboardId, user]);

  const loadGithubIntegration = React.useCallback(async () => {
    if (!user) return;
    try {
      const integration = await getGithubIntegration(dashboardId);
      setGithubIntegration(integration);
    } catch { setGithubIntegration(null); }
  }, [dashboardId, user]);

  const loadGithubStatus = React.useCallback(async () => {
    if (!user || !dashboardId) return;
    try {
      const status = await getGithubSyncStatus(dashboardId);
      setGithubStatus(status);
      setGithubSyncing(status.status === "syncing_cache" || status.status === "syncing_workspace");
    } catch { setGithubStatus(null); setGithubSyncing(false); }
  }, [dashboardId, user]);

  const loadGithubRepos = React.useCallback(async () => {
    setGithubLoading(true);
    try {
      const response = await listGithubRepos();
      if (!response.connected && response.error) {
        setFileError(response.error);
        void loadGithubIntegration();
      }
      setGithubRepos(response.repos || []);
    } catch { setGithubRepos([]); }
    finally { setGithubLoading(false); }
  }, [loadGithubIntegration]);

  const loadBoxIntegration = React.useCallback(async () => {
    if (!user) return;
    try {
      const integration = await getBoxIntegration(dashboardId);
      setBoxIntegration(integration);
    } catch { setBoxIntegration(null); }
  }, [dashboardId, user]);

  const loadBoxStatus = React.useCallback(async () => {
    if (!user || !dashboardId) return;
    try {
      const status = await getBoxSyncStatus(dashboardId);
      setBoxStatus(status);
      setBoxSyncing(status.status === "syncing_cache" || status.status === "syncing_workspace");
    } catch { setBoxStatus(null); setBoxSyncing(false); }
  }, [dashboardId, user]);

  const loadBoxFolders = React.useCallback(async (parentId: string) => {
    setBoxLoading(true);
    try {
      const response = await listBoxFolders(parentId);
      setBoxFolders(response.folders || []);
      setBoxParentId(response.parentId);
    } catch { setBoxFolders([]); }
    finally { setBoxLoading(false); }
  }, []);

  const loadOnedriveIntegration = React.useCallback(async () => {
    if (!user) return;
    try {
      const integration = await getOnedriveIntegration(dashboardId);
      setOnedriveIntegration(integration);
    } catch { setOnedriveIntegration(null); }
  }, [dashboardId, user]);

  const loadOnedriveStatus = React.useCallback(async () => {
    if (!user || !dashboardId) return;
    try {
      const status = await getOnedriveSyncStatus(dashboardId);
      setOnedriveStatus(status);
      setOnedriveSyncing(status.status === "syncing_cache" || status.status === "syncing_workspace");
    } catch { setOnedriveStatus(null); setOnedriveSyncing(false); }
  }, [dashboardId, user]);

  const loadOnedriveFolders = React.useCallback(async (parentId: string) => {
    setOnedriveLoading(true);
    try {
      const response = await listOnedriveFolders(parentId);
      setOnedriveFolders(response.folders || []);
      setOnedriveParentId(response.parentId);
    } catch { setOnedriveFolders([]); }
    finally { setOnedriveLoading(false); }
  }, []);

  // ── Integration connect handlers ────────────────────────────────
  const openPopup = React.useCallback((path: string, name: string) => {
    if (!user) return;
    const url = new URL(`${API.cloudflare.base}${path}`);
    url.searchParams.set("mode", "popup");
    if (dashboardId) url.searchParams.set("dashboard_id", dashboardId);
    if (path.includes("drive")) {
      url.searchParams.set("user_id", user.id);
      url.searchParams.set("user_email", user.email);
      url.searchParams.set("user_name", user.name);
    }
    const w = 520, h = 680;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
    window.open(url.toString(), name, `width=${w},height=${h},left=${left},top=${top},noopener,noreferrer`);
  }, [dashboardId, user]);

  const handleDriveConnect = React.useCallback(() => openPopup("/integrations/google/drive/connect", "orcabot-drive-auth"), [openPopup]);
  const handleGithubConnect = React.useCallback(() => openPopup("/integrations/github/connect", "orcabot-github-auth"), [openPopup]);
  const handleBoxConnect = React.useCallback(() => openPopup("/integrations/box/connect", "orcabot-box-auth"), [openPopup]);
  const handleOnedriveConnect = React.useCallback(() => openPopup("/integrations/onedrive/connect", "orcabot-onedrive-auth"), [openPopup]);

  // ── Integration unlink/disconnect handlers ──────────────────────
  const handleUnlinkDrive = React.useCallback(async () => {
    if (!dashboardId) return;
    if (!window.confirm("Unlink this Drive folder from the dashboard?")) return;
    try { await unlinkGoogleDriveFolder(dashboardId); setDriveStatus(null); await loadDriveIntegration(); }
    catch (error) { setFileError(error instanceof Error ? error.message : "Failed to unlink Drive"); }
  }, [dashboardId, loadDriveIntegration]);

  const handleUnlinkGithub = React.useCallback(async () => {
    if (!dashboardId) return;
    if (!window.confirm("Unlink this GitHub repo from the dashboard?")) return;
    try { await unlinkGithubRepo(dashboardId); setGithubStatus(null); await loadGithubIntegration(); }
    catch (error) { setFileError(error instanceof Error ? error.message : "Failed to unlink GitHub"); }
  }, [dashboardId, loadGithubIntegration]);

  const handleSelectGithubRepo = React.useCallback(async (repo: GithubRepo) => {
    if (!dashboardId) return;
    try {
      await setGithubRepo(dashboardId, repo);
      await loadGithubIntegration();
      await loadGithubStatus();
      setGithubPickerOpen(false);
      onStorageLinked?.("github");
    } catch (error) { setFileError(error instanceof Error ? error.message : "Failed to link GitHub repo"); }
  }, [dashboardId, loadGithubIntegration, loadGithubStatus, onStorageLinked]);

  const handleConfirmGithubRepo = React.useCallback(async () => {
    if (!githubSelected) return;
    setGithubImporting(true);
    try { await handleSelectGithubRepo(githubSelected); }
    finally { setGithubImporting(false); }
  }, [githubSelected, handleSelectGithubRepo]);

  const handleUnlinkBox = React.useCallback(async () => {
    if (!dashboardId) return;
    if (!window.confirm("Unlink this Box folder from the dashboard?")) return;
    try { await unlinkBoxFolder(dashboardId); setBoxStatus(null); await loadBoxIntegration(); }
    catch (error) { setFileError(error instanceof Error ? error.message : "Failed to unlink Box"); }
  }, [dashboardId, loadBoxIntegration]);

  const handleSelectBoxFolder = React.useCallback(async (folder: BoxFolder) => {
    if (!dashboardId) return;
    try {
      await setBoxFolder(dashboardId, folder);
      await loadBoxIntegration();
      await loadBoxStatus();
      setBoxPickerOpen(false);
      onStorageLinked?.("box");
    } catch (error) { setFileError(error instanceof Error ? error.message : "Failed to link Box folder"); }
  }, [dashboardId, loadBoxIntegration, loadBoxStatus, onStorageLinked]);

  const handleUnlinkOnedrive = React.useCallback(async () => {
    if (!dashboardId) return;
    if (!window.confirm("Unlink this OneDrive folder from the dashboard?")) return;
    try { await unlinkOnedriveFolder(dashboardId); setOnedriveStatus(null); await loadOnedriveIntegration(); }
    catch (error) { setFileError(error instanceof Error ? error.message : "Failed to unlink OneDrive"); }
  }, [dashboardId, loadOnedriveIntegration]);

  const handleSelectOnedriveFolder = React.useCallback(async (folder: OnedriveFolder) => {
    if (!dashboardId) return;
    try {
      await setOnedriveFolder(dashboardId, folder);
      await loadOnedriveIntegration();
      await loadOnedriveStatus();
      setOnedrivePickerOpen(false);
      onStorageLinked?.("onedrive");
    } catch (error) { setFileError(error instanceof Error ? error.message : "Failed to link OneDrive folder"); }
  }, [dashboardId, loadOnedriveIntegration, loadOnedriveStatus, onStorageLinked]);

  const handleDisconnectDrive = React.useCallback(async () => {
    if (!window.confirm("Sign out of Google Drive? This will unlink all Drive folders from your dashboards.")) return;
    try { await disconnectGoogleDrive(); setDriveIntegration(null); setDriveStatus(null); }
    catch (error) { setFileError(error instanceof Error ? error.message : "Failed to disconnect Drive"); }
  }, []);

  const handleDisconnectGithub = React.useCallback(async () => {
    if (!window.confirm("Sign out of GitHub? This will unlink all repos from your dashboards.")) return;
    try { await disconnectGithub(); setGithubIntegration(null); setGithubStatus(null); }
    catch (error) { setFileError(error instanceof Error ? error.message : "Failed to disconnect GitHub"); }
  }, []);

  const handleDisconnectBox = React.useCallback(async () => {
    if (!window.confirm("Sign out of Box? This will unlink all Box folders from your dashboards.")) return;
    try { await disconnectBox(); setBoxIntegration(null); setBoxStatus(null); }
    catch (error) { setFileError(error instanceof Error ? error.message : "Failed to disconnect Box"); }
  }, []);

  const handleDisconnectOnedrive = React.useCallback(async () => {
    if (!window.confirm("Sign out of OneDrive? This will unlink all OneDrive folders from your dashboards.")) return;
    try { await disconnectOnedrive(); setOnedriveIntegration(null); setOnedriveStatus(null); }
    catch (error) { setFileError(error instanceof Error ? error.message : "Failed to disconnect OneDrive"); }
  }, []);

  const handleOpenBoxFolder = React.useCallback((folder: BoxFolder) => {
    setBoxPath((prev) => [...prev, folder]);
    void loadBoxFolders(folder.id);
  }, [loadBoxFolders]);

  const handleBackBoxFolder = React.useCallback(() => {
    setBoxPath((prev) => {
      const next = prev.slice(0, -1);
      const parentId = next.length > 0 ? next[next.length - 1].id : "0";
      void loadBoxFolders(parentId);
      return next;
    });
  }, [loadBoxFolders]);

  const handleOpenOnedriveFolder = React.useCallback((folder: OnedriveFolder) => {
    setOnedrivePath((prev) => [...prev, folder]);
    void loadOnedriveFolders(folder.id);
  }, [loadOnedriveFolders]);

  const handleBackOnedriveFolder = React.useCallback(() => {
    setOnedrivePath((prev) => {
      const next = prev.slice(0, -1);
      const parentId = next.length > 0 ? next[next.length - 1].id : "root";
      void loadOnedriveFolders(parentId);
      return next;
    });
  }, [loadOnedriveFolders]);

  // ── Effects ─────────────────────────────────────────────────────

  // Load files when sessionId changes
  React.useEffect(() => {
    setExpandedPaths(new Set(["/"]));
    setFileEntries({});
    setFileError(null);
    if (sessionId) loadFiles("/");
  }, [sessionId, loadFiles]);

  // Preview entries from cloud manifests when no session
  React.useEffect(() => {
    if (sessionId || !dashboardId) return;
    const canFetchDrive = driveIntegration?.connected && driveStatus?.status !== "syncing_cache";
    const canFetchGithub = githubIntegration?.connected && githubStatus?.status !== "syncing_cache";
    const canFetchBox = boxIntegration?.connected && boxStatus?.status !== "syncing_cache";
    const canFetchOnedrive = onedriveIntegration?.connected && onedriveStatus?.status !== "syncing_cache";
    if (!canFetchDrive && !canFetchGithub && !canFetchBox && !canFetchOnedrive) return;
    const now = Date.now();
    if (now - previewFetchRef.current < 10000) return;
    previewFetchRef.current = now;
    let isActive = true;
    const run = async () => {
      const combined: Record<string, SessionFileEntry[]> = {};
      try {
        if (canFetchDrive) {
          const r = await getGoogleDriveManifest(dashboardId);
          if (r.manifest) mergePreviewEntries(combined, buildDrivePreviewEntries(r.manifest));
        }
        if (canFetchGithub) {
          const r = await getGithubManifest(dashboardId);
          if (r.manifest) mergePreviewEntries(combined, buildDrivePreviewEntries(r.manifest));
        }
        if (canFetchBox) {
          const r = await getBoxManifest(dashboardId);
          if (r.manifest) mergePreviewEntries(combined, buildDrivePreviewEntries(r.manifest));
        }
        if (canFetchOnedrive) {
          const r = await getOnedriveManifest(dashboardId);
          if (r.manifest) mergePreviewEntries(combined, buildDrivePreviewEntries(r.manifest));
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
    return () => { isActive = false; };
  }, [
    buildDrivePreviewEntries, dashboardId,
    driveIntegration?.connected, driveStatus?.status, driveSyncing,
    githubIntegration?.connected, githubStatus?.status, githubSyncing,
    boxIntegration?.connected, boxStatus?.status, boxSyncing,
    onedriveIntegration?.connected, onedriveStatus?.status, onedriveSyncing,
    mergePreviewEntries, sessionId,
  ]);

  // Load all integrations once per dashboard
  React.useEffect(() => {
    if (!dashboardId || !user) return;
    const lastLoad = getLastLoadTime(dashboardId);
    const now = Date.now();
    if (lastLoad && now - lastLoad < INTEGRATION_LOAD_COOLDOWN_MS) return;
    if (integrationLoadedRef.current === dashboardId) return;
    if (integrationLoadingRef.current) return;
    integrationLoadingRef.current = true;
    integrationLoadedRef.current = dashboardId;
    setLastLoadTime(dashboardId, now);
    void Promise.all([
      loadDriveIntegration(), loadDriveStatus(),
      loadGithubIntegration(), loadGithubStatus(),
      loadBoxIntegration(), loadBoxStatus(),
      loadOnedriveIntegration(), loadOnedriveStatus(),
    ]).finally(() => { integrationLoadingRef.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardId, user]);

  // File tree polling
  React.useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(() => {
      Array.from(expandedPaths).forEach((path) => loadFiles(path));
    }, 2500);
    return () => clearInterval(interval);
  }, [expandedPaths, loadFiles, sessionId]);

  // OAuth popup message listeners
  React.useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin && event.origin !== apiOrigin) return;
      const payload = event.data as { type?: string; folder?: { dashboardId?: string } };
      if (payload?.type === "drive-auth-complete") { void loadDriveIntegration(); setDrivePickerOpen(true); return; }
      if (payload?.type === "drive-auth-expired") { setDrivePickerOpen(false); void loadDriveIntegration(); setFileError("Google Drive session expired. Please reconnect."); return; }
      if (payload?.type === "drive-linked") {
        setDrivePickerOpen(false); void loadDriveIntegration(); void loadDriveStatus();
        const did = payload.folder?.dashboardId || dashboardId;
        if (did) void syncGoogleDrive(did).catch(() => undefined);
        onStorageLinked?.("google_drive");
        return;
      }
      if (payload?.type === "github-auth-complete") { void loadGithubIntegration(); setGithubPickerOpen(true); void loadGithubRepos(); return; }
      if (payload?.type === "box-auth-complete") { void loadBoxIntegration(); setBoxPickerOpen(true); setBoxPath([]); void loadBoxFolders("0"); return; }
      if (payload?.type === "onedrive-auth-complete") { void loadOnedriveIntegration(); setOnedrivePickerOpen(true); setOnedrivePath([]); void loadOnedriveFolders("root"); }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [apiOrigin, dashboardId, onStorageLinked, loadDriveIntegration, loadDriveStatus, loadGithubIntegration, loadGithubRepos, loadBoxIntegration, loadBoxFolders, loadOnedriveIntegration, loadOnedriveFolders]);

  // BroadcastChannel for cross-tab OAuth
  React.useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("orcabot-oauth");
      bc.onmessage = (event: MessageEvent) => {
        const payload = event.data as { type?: string; dashboardId?: string };
        if (payload?.dashboardId && payload.dashboardId !== dashboardId) return;
        if (payload?.type === "drive-auth-complete") { void loadDriveIntegration(); setDrivePickerOpen(true); return; }
        if (payload?.type === "drive-auth-expired") { setDrivePickerOpen(false); void loadDriveIntegration(); setFileError("Google Drive session expired. Please reconnect."); return; }
        if (payload?.type === "github-auth-complete") { void loadGithubIntegration(); setGithubPickerOpen(true); void loadGithubRepos(); return; }
        if (payload?.type === "box-auth-complete") { void loadBoxIntegration(); setBoxPickerOpen(true); setBoxPath([]); void loadBoxFolders("0"); return; }
        if (payload?.type === "onedrive-auth-complete") { void loadOnedriveIntegration(); setOnedrivePickerOpen(true); setOnedrivePath([]); void loadOnedriveFolders("root"); }
      };
    } catch {}
    return () => { try { bc?.close(); } catch {} };
  }, [dashboardId, loadDriveIntegration, loadGithubIntegration, loadGithubRepos, loadBoxIntegration, loadBoxFolders, loadOnedriveIntegration, loadOnedriveFolders]);

  // Sync status polling
  React.useEffect(() => { if (!driveSyncing) return; const i = setInterval(() => { void loadDriveStatus(); }, 2500); return () => clearInterval(i); }, [driveSyncing, loadDriveStatus]);
  React.useEffect(() => { if (!githubSyncing) return; const i = setInterval(() => { void loadGithubStatus(); }, 2500); return () => clearInterval(i); }, [githubSyncing, loadGithubStatus]);
  React.useEffect(() => { if (!boxSyncing) return; const i = setInterval(() => { void loadBoxStatus(); }, 2500); return () => clearInterval(i); }, [boxSyncing, loadBoxStatus]);
  React.useEffect(() => { if (!onedriveSyncing) return; const i = setInterval(() => { void loadOnedriveStatus(); }, 2500); return () => clearInterval(i); }, [onedriveSyncing, loadOnedriveStatus]);

  // Picker open effects
  React.useEffect(() => { if (!githubPickerOpen || !githubIntegration?.connected) return; setGithubSelected(null); void loadGithubRepos(); }, [githubPickerOpen, githubIntegration?.connected, loadGithubRepos]);
  React.useEffect(() => { if (!boxPickerOpen || !boxIntegration?.connected) return; setBoxPath([]); void loadBoxFolders("0"); }, [boxPickerOpen, boxIntegration?.connected, loadBoxFolders]);
  React.useEffect(() => { if (!onedrivePickerOpen || !onedriveIntegration?.connected) return; setOnedrivePath([]); void loadOnedriveFolders("root"); }, [onedrivePickerOpen, onedriveIntegration?.connected, loadOnedriveFolders]);

  // ── Agent indicators for a given path ──────────────────────────
  const getIndicatorsForPath = React.useCallback(
    (path: string) => agentIndicators.filter((a) => a.cwdPath === path),
    [agentIndicators]
  );

  const renderAgentIndicators = React.useCallback(
    (path: string) => {
      const indicators = getIndicatorsForPath(path);
      if (indicators.length === 0) return null;
      return (
        <div className="flex items-center gap-0.5 ml-auto shrink-0">
          {indicators.map((agent) => (
            <Tooltip key={agent.id} content={agent.name} side="right">
              <div className="relative">
                {agent.iconSrc ? (
                  <img src={agent.iconSrc} alt={agent.name} className="w-3.5 h-3.5 object-contain" />
                ) : (
                  <Terminal className="w-3.5 h-3.5 text-[var(--foreground-muted)]" />
                )}
                <span
                  className={`absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full border border-[var(--background)] ${
                    agent.active ? "bg-[var(--status-success)]" : "bg-[var(--foreground-subtle)]"
                  }`}
                />
              </div>
            </Tooltip>
          ))}
        </div>
      );
    },
    [getIndicatorsForPath]
  );

  // ── File tree renderer ──────────────────────────────────────────
  const renderFileTree = React.useCallback(
    (path: string, depth = 0): React.ReactNode => {
      const entries = fileEntries[path] || [];
      const filteredEntries = showHiddenFiles
        ? entries
        : entries.filter((entry) => !entry.name.startsWith("."));
      return filteredEntries.map((entry) => {
        const isExpanded = expandedPaths.has(entry.path);
        const isDir = entry.is_dir;
        const isSelected = isDir && selectedPath === entry.path;
        return (
          <div key={entry.path}>
            <div
              className={cn(
                "flex items-center justify-between gap-1 px-2 py-0.5 text-[11px] select-none",
                isDir ? "cursor-pointer" : "cursor-default",
                isSelected
                  ? "bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
                  : "hover:bg-[var(--background-elevated)]"
              )}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={() => {
                if (isDir) {
                  handleSelectPath(entry.path);
                  if (!isExpanded) togglePath(entry.path);
                }
              }}
            >
              <div className="flex items-center gap-1 min-w-0 flex-1">
                {isDir ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); togglePath(entry.path); }}
                    className={cn(
                      "flex items-center",
                      isSelected ? "text-[var(--accent-primary)]" : "text-[var(--foreground-muted)]"
                    )}
                    aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                  </button>
                ) : (
                  <span className="w-3" />
                )}
                {isDir && (
                  <Folder className={cn("w-3 h-3 shrink-0", isSelected ? "text-[var(--accent-primary)]" : "text-[var(--foreground-muted)]")} />
                )}
                <span className={cn("truncate", isSelected ? "text-[var(--accent-primary)] font-medium" : "text-[var(--foreground)]")}>{entry.name}</span>
              </div>
              {isDir && renderAgentIndicators(entry.path)}
              {!isDir && allowDelete && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleDeletePath(entry.path, path); }}
                  className="text-[10px] text-[var(--status-error)] hover:text-[var(--status-error)] opacity-0 group-hover:opacity-100"
                >
                  Del
                </button>
              )}
            </div>
            {isDir && isExpanded && renderFileTree(entry.path, depth + 1)}
          </div>
        );
      });
    },
    [allowDelete, expandedPaths, fileEntries, handleDeletePath, handleSelectPath, renderAgentIndicators, selectedPath, showHiddenFiles, togglePath]
  );

  const rootEntries = fileEntries["/"] || [];
  const showFiles = rootEntries.length > 0;

  // ── Drive button helper ─────────────────────────────────────────
  const DriveButton = React.useCallback(
    ({
      icon,
      label,
      connected,
      linked,
      onConnect,
      children,
    }: {
      icon: React.ReactNode;
      label: string;
      connected: boolean;
      linked: boolean;
      onConnect: () => void;
      children?: React.ReactNode;
    }) => {
      if (connected) {
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Tooltip content={label} side="bottom">
                <Button
                  variant={linked ? "secondary" : "ghost"}
                  size="icon-sm"
                  disabled={!user}
                  title={label}
                >
                  {icon}
                </Button>
              </Tooltip>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              {children}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      }
      return (
        <Tooltip content={`Connect ${label}`} side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onConnect}
            disabled={!user}
            title={`Connect ${label}`}
          >
            {icon}
          </Button>
        </Tooltip>
      );
    },
    [user]
  );

  // ── Collapsed view ──────────────────────────────────────────────
  // Drive buttons JSX — rendered via portal into toolbar when target is available
  const driveButtonsJSX = (
    <>
      <DriveButton
        icon={<Cloud className="w-3.5 h-3.5" />}
        label="Drive"
        connected={isDriveConnected}
        linked={isDriveLinked}
        onConnect={handleDriveConnect}
      >
        {isDriveLinked ? (
          <>
            <DropdownMenuItem disabled className="text-[10px] text-[var(--foreground-muted)]">
              Drive: {driveIntegration?.folder?.name ?? "Linked"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDrivePickerOpen(true)}>Change folder</DropdownMenuItem>
            <DropdownMenuItem onSelect={handleUnlinkDrive} className="text-[var(--status-error)] focus:text-[var(--status-error)]">Unlink</DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => setDrivePickerOpen(true)}>Link folder</DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={handleDisconnectDrive} className="text-[var(--status-error)] focus:text-[var(--status-error)]">Sign out</DropdownMenuItem>
      </DriveButton>

      <DriveButton
        icon={<Github className="w-3.5 h-3.5" />}
        label="GitHub"
        connected={isGithubConnected}
        linked={isGithubLinked}
        onConnect={handleGithubConnect}
      >
        {isGithubLinked ? (
          <>
            <DropdownMenuItem disabled className="text-[10px] text-[var(--foreground-muted)]">
              Repo: {githubIntegration?.repo?.owner}/{githubIntegration?.repo?.name}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setGithubPickerOpen(true)}>Change repo</DropdownMenuItem>
            <DropdownMenuItem onSelect={handleUnlinkGithub} className="text-[var(--status-error)] focus:text-[var(--status-error)]">Unlink</DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => setGithubPickerOpen(true)}>Link repo</DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={handleDisconnectGithub} className="text-[var(--status-error)] focus:text-[var(--status-error)]">Sign out</DropdownMenuItem>
      </DriveButton>

      <DriveButton
        icon={<Box className="w-3.5 h-3.5" />}
        label="Box"
        connected={isBoxConnected}
        linked={isBoxLinked}
        onConnect={handleBoxConnect}
      >
        {isBoxLinked ? (
          <>
            <DropdownMenuItem disabled className="text-[10px] text-[var(--foreground-muted)]">
              Folder: {boxIntegration?.folder?.name ?? "Linked"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setBoxPickerOpen(true)}>Change folder</DropdownMenuItem>
            <DropdownMenuItem onSelect={handleUnlinkBox} className="text-[var(--status-error)] focus:text-[var(--status-error)]">Unlink</DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => setBoxPickerOpen(true)}>Link folder</DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={handleDisconnectBox} className="text-[var(--status-error)] focus:text-[var(--status-error)]">Sign out</DropdownMenuItem>
      </DriveButton>

      <DriveButton
        icon={<HardDrive className="w-3.5 h-3.5" />}
        label="OneDrive"
        connected={isOnedriveConnected}
        linked={isOnedriveLinked}
        onConnect={handleOnedriveConnect}
      >
        {isOnedriveLinked ? (
          <>
            <DropdownMenuItem disabled className="text-[10px] text-[var(--foreground-muted)]">
              Folder: {onedriveIntegration?.folder?.name ?? "Linked"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setOnedrivePickerOpen(true)}>Change folder</DropdownMenuItem>
            <DropdownMenuItem onSelect={handleUnlinkOnedrive} className="text-[var(--status-error)] focus:text-[var(--status-error)]">Unlink</DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => setOnedrivePickerOpen(true)}>Link folder</DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={handleDisconnectOnedrive} className="text-[var(--status-error)] focus:text-[var(--status-error)]">Sign out</DropdownMenuItem>
      </DriveButton>
    </>
  );

  if (collapsed) {
    return (
      <>
        <div className="flex flex-col items-center w-9 border-r border-[var(--border)] bg-[var(--background)] absolute left-0 top-[55px] bottom-0 z-10 shadow-sm">
          <Tooltip content="Expand workspace" side="right">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleCollapse}
              className="mt-2"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </Button>
          </Tooltip>
          <Tooltip content="Workspace" side="right">
            <div className="mt-2">
              <Folder className="w-4 h-4 text-[var(--foreground-muted)]" />
            </div>
          </Tooltip>
        </div>
        {/* Drive buttons portal */}
        {drivePortalTarget && createPortal(driveButtonsJSX, drivePortalTarget)}
      </>
    );
  }

  // ── Expanded view ───────────────────────────────────────────────
  return (
    <>
      <div
        className="flex flex-col border-r border-[var(--border)] bg-[var(--background)] absolute left-0 top-[55px] bottom-0 z-10 select-none shadow-lg"
        style={{ width: `${width}px` }}
      >
        {/* Header */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[var(--border)]">
          <Folder className="w-3.5 h-3.5 text-[var(--foreground-subtle)] shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--foreground-muted)] flex-1">
            Workspace
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" title="Settings" className="h-5 w-5">
                <Settings className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onSelect={() => setShowHiddenFiles((prev) => !prev)}
                className="flex items-center gap-2"
              >
                {showHiddenFiles ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                <span>{showHiddenFiles ? "Hide hidden files" : "Show hidden files"}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content="Collapse sidebar" side="right">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleCollapse}
              className="h-5 w-5"
            >
              <PanelLeftClose className="w-3 h-3" />
            </Button>
          </Tooltip>
        </div>

        {/* File tree */}
        <div className="flex-1 overflow-auto min-h-0">
          {fileError && (
            <div className="px-2 py-1 text-[10px] text-[var(--status-error)]">{fileError}</div>
          )}
          <div className="py-1">
            {/* Root directory row — always visible */}
            <div
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 text-[11px] cursor-pointer select-none",
                selectedPath === "/"
                  ? "bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]"
                  : "hover:bg-[var(--background-elevated)]"
              )}
              onClick={() => handleSelectPath("/")}
            >
              <Folder className={cn("w-3 h-3 shrink-0", selectedPath === "/" ? "text-[var(--accent-primary)]" : "text-[var(--foreground-muted)]")} />
              <span className={cn("truncate flex-1", selectedPath === "/" ? "text-[var(--accent-primary)] font-medium" : "text-[var(--foreground)]")}>/</span>
              {renderAgentIndicators("/")}
            </div>
            {showFiles && renderFileTree("/", 0)}
            {!sessionId && (
              <div className="px-2 py-2 text-[10px] text-[var(--foreground-muted)]">
                {githubSyncing ? "Syncing repo..." : "Start a terminal to see files."}
              </div>
            )}
          </div>
        </div>

        {/* Resize handle */}
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent-primary)] transition-colors z-10"
          onMouseDown={handleMouseDown}
        />
      </div>

      {/* Integration picker dialogs */}
      <Dialog open={drivePickerOpen} onOpenChange={setDrivePickerOpen}>
        <DialogContent className="max-w-3xl h-[540px] p-0">
          <DialogTitle className="sr-only">Google Drive</DialogTitle>
          {driveIntegration?.connected ? (
            <iframe title="Google Drive Picker" src={drivePickerUrl} className="w-full h-full border-0" />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 bg-[var(--background)] p-6 text-center">
              <div className="text-sm font-semibold text-[var(--foreground)]">Connect Google Drive</div>
              <div className="text-xs text-[var(--foreground-muted)]">Sign in once to select a folder and sync it into this workspace.</div>
              <Button variant="secondary" size="sm" onClick={handleDriveConnect}>Connect Drive</Button>
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
              <div className="text-xs text-[var(--foreground-muted)]">Choose a repository to sync into this workspace.</div>
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
                        <div className="text-sm text-[var(--foreground)]">{repo.owner}/{repo.name}</div>
                        <div className="text-[10px] text-[var(--foreground-muted)]">
                          {repo.branch ? `Branch: ${repo.branch}` : "Default branch"}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {githubImporting && <div className="text-xs text-[var(--foreground-muted)]">Importing repo...</div>}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setGithubPickerOpen(false)} disabled={githubImporting}>Cancel</Button>
                <Button variant="primary" size="sm" disabled={!githubSelected || githubImporting} onClick={handleConfirmGithubRepo}>
                  {githubImporting ? (<><Loader2 className="w-3 h-3 animate-spin" />Importing...</>) : "Import repo"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-3 bg-[var(--background)] p-6 text-center">
              <div className="text-sm font-semibold text-[var(--foreground)]">Connect GitHub</div>
              <div className="text-xs text-[var(--foreground-muted)]">Sign in to choose a repository and sync it into this workspace.</div>
              <Button variant="secondary" size="sm" onClick={handleGithubConnect}>Connect GitHub</Button>
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
                  <Button variant="secondary" size="sm" onClick={handleBackBoxFolder}>Back</Button>
                )}
              </div>
              <div className="text-xs text-[var(--foreground-muted)]">
                Current folder: {boxPath.length > 0 ? boxPath[boxPath.length - 1].name : "Box"}
              </div>
              <Button variant="primary" size="sm" onClick={() => handleSelectBoxFolder(boxPath.length > 0 ? boxPath[boxPath.length - 1] : { id: "0", name: "Box" })}>
                Select this folder
              </Button>
              <div className="flex-1 overflow-auto border border-[var(--border)] rounded-md">
                {boxLoading ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">Loading folders...</div>
                ) : boxFolders.length === 0 ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">No folders found.</div>
                ) : (
                  <div className="divide-y divide-[var(--border)]">
                    {boxFolders.map((folder) => (
                      <button key={folder.id} type="button" onClick={() => handleOpenBoxFolder(folder)} className="w-full text-left px-4 py-3 hover:bg-[var(--background-hover)] transition-colors">
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
              <div className="text-xs text-[var(--foreground-muted)]">Sign in to choose a folder and sync it into this workspace.</div>
              <Button variant="secondary" size="sm" onClick={handleBoxConnect}>Connect Box</Button>
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
                  <Button variant="secondary" size="sm" onClick={handleBackOnedriveFolder}>Back</Button>
                )}
              </div>
              <div className="text-xs text-[var(--foreground-muted)]">
                Current folder: {onedrivePath.length > 0 ? onedrivePath[onedrivePath.length - 1].name : "OneDrive"}
              </div>
              <Button variant="primary" size="sm" onClick={() => handleSelectOnedriveFolder(onedrivePath.length > 0 ? onedrivePath[onedrivePath.length - 1] : { id: "root", name: "OneDrive" })}>
                Select this folder
              </Button>
              <div className="flex-1 overflow-auto border border-[var(--border)] rounded-md">
                {onedriveLoading ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">Loading folders...</div>
                ) : onedriveFolders.length === 0 ? (
                  <div className="p-4 text-xs text-[var(--foreground-muted)]">No folders found.</div>
                ) : (
                  <div className="divide-y divide-[var(--border)]">
                    {onedriveFolders.map((folder) => (
                      <button key={folder.id} type="button" onClick={() => handleOpenOnedriveFolder(folder)} className="w-full text-left px-4 py-3 hover:bg-[var(--background-hover)] transition-colors">
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
              <div className="text-xs text-[var(--foreground-muted)]">Sign in to choose a folder and sync it into this workspace.</div>
              <Button variant="secondary" size="sm" onClick={handleOnedriveConnect}>Connect OneDrive</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Drive buttons portal — renders into toolbar target */}
      {drivePortalTarget && createPortal(driveButtonsJSX, drivePortalTarget)}
    </>
  );
}

export default WorkspaceSidebar;
