// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: dashboard-v15-fix-move-jumpback
console.log(`[dashboard] REVISION: dashboard-v15-fix-move-jumpback loaded at ${new Date().toISOString()}`);


import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type Edge, useEdgesState } from "@xyflow/react";
import {
  ArrowLeft,
  StickyNote,
  CheckSquare,
  Globe,
  Terminal,
  Users,
  Settings,
  Share2,
  GitMerge,
  Activity,
  MessageSquare,
  Upload,
  Link,
  Clock,
  Minimize2,
  Maximize2,
  Bug,
  X,
} from "lucide-react";
import {
  GmailIcon,
  GoogleCalendarIcon,
  GoogleContactsIcon,
  GoogleSheetsIcon,
  GoogleFormsIcon,
} from "@/components/icons";
import { toast } from "sonner";

import {
  Button,
  Tooltip,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Input,
  Skeleton,
  ThemeToggle,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui";
import { ExportTemplateDialog } from "@/components/dialogs/ExportTemplateDialog";
import { ShareDashboardDialog } from "@/components/dialogs/ShareDashboardDialog";
import { BugReportDialog } from "@/components/dialogs/BugReportDialog";
import { Canvas } from "@/components/canvas";
import { CursorOverlay, PresenceList } from "@/components/multiplayer";
import { useAuthStore } from "@/stores/auth-store";
import { useCollaboration, useDebouncedCallback, useUICommands } from "@/hooks";
import { getDashboard, createItem, updateItem, deleteItem, createEdge, deleteEdge, getDashboardMetrics, startDashboardBrowser, stopDashboardBrowser, sendUICommandResult } from "@/lib/api/cloudflare";
import { generateId } from "@/lib/utils";
import type { DashboardItem, Dashboard, Session, DashboardEdge, DashboardItemType } from "@/types/dashboard";
import type { PresenceUser } from "@/types/collaboration";
import { ConnectionDataFlowProvider } from "@/contexts/ConnectionDataFlowContext";
import {
  isIntegrationBlockType,
  getProviderForBlockType,
  getBlockTypeForProvider,
  attachIntegration,
  detachIntegration,
  listAvailableIntegrations,
  listTerminalIntegrations,
  createReadOnlyPolicy,
  getProviderDisplayName,
  type IntegrationProvider,
  type SecurityLevel,
  type TerminalIntegration,
  type BrowserPolicy,
} from "@/lib/api/cloudflare/integration-policies";
import { PolicyEditorDialog } from "@/components/blocks/PolicyEditorDialog";
import { WorkspaceSidebar } from "@/components/workspace";

// Optimistic updates disabled by default - set NEXT_PUBLIC_OPTIMISTIC_UPDATE=true to enable
const OPTIMISTIC_UPDATE_ENABLED = process.env.NEXT_PUBLIC_OPTIMISTIC_UPDATE === "true";

type BlockType = DashboardItem["type"];

type BlockTool = {
  type: BlockType;
  icon: React.ReactNode;
  label: string;
  terminalPreset?: {
    command?: string;
    agentic?: boolean;
  };
};

type PendingConnection = {
  nodeId: string;
  handleId: string;
  kind: "source" | "target";
};

const toFlowEdge = (edge: DashboardEdge): Edge => ({
  id: edge.id,
  source: edge.sourceItemId,
  target: edge.targetItemId,
  sourceHandle: edge.sourceHandle,
  targetHandle: edge.targetHandle,
  type: "smoothstep",
  animated: true,
  style: { stroke: "var(--accent-primary)", strokeWidth: 2 },
});

// Only include types that exist in the DB schema
const blockTools: BlockTool[] = [
  { type: "note", icon: <StickyNote className="w-4 h-4" />, label: "Note" },
  { type: "todo", icon: <CheckSquare className="w-4 h-4" />, label: "Todo" },
  { type: "prompt", icon: <MessageSquare className="w-4 h-4" />, label: "Prompt" },
  { type: "schedule", icon: <Clock className="w-4 h-4" />, label: "Schedule" },
  { type: "browser", icon: <Globe className="w-4 h-4" />, label: "Browser" },
  // Recipe is not in DB schema yet - uncomment when added:
  // { type: "recipe", icon: <Workflow className="w-4 h-4" />, label: "Recipe" },
];

// Google integrations in their own section
const googleTools: BlockTool[] = [
  { type: "gmail", icon: <GmailIcon className="w-4 h-4" />, label: "Gmail" },
  { type: "calendar", icon: <GoogleCalendarIcon className="w-4 h-4" />, label: "Calendar" },
  { type: "contacts", icon: <GoogleContactsIcon className="w-4 h-4" />, label: "Contacts" },
  { type: "sheets", icon: <GoogleSheetsIcon className="w-4 h-4" />, label: "Sheets" },
  { type: "forms", icon: <GoogleFormsIcon className="w-4 h-4" />, label: "Forms" },
];

const terminalTools: BlockTool[] = [
  {
    type: "terminal",
    label: "Claude Code",
    icon: <img src="/icons/claude.ico" alt="" className="w-4 h-4 object-contain" />,
    terminalPreset: { command: "claude", agentic: true },
  },
  {
    type: "terminal",
    label: "Gemini CLI",
    icon: <img src="/icons/gemini.ico" alt="" className="w-4 h-4 object-contain" />,
    terminalPreset: { command: "gemini", agentic: true },
  },
  {
    type: "terminal",
    label: "Codex",
    icon: <img src="/icons/codex.png" alt="" className="w-4 h-4 object-contain" />,
    terminalPreset: { command: "codex", agentic: true },
  },
  // OpenCode - temporarily hidden until connection issues are resolved
  // {
  //   type: "terminal",
  //   label: "OpenCode",
  //   icon: <img src="/icons/opencode.ico" alt="" className="w-4 h-4 object-contain" />,
  //   terminalPreset: { command: "opencode", agentic: true },
  // },
  // Droid - temporarily hidden until stable release
  // {
  //   type: "terminal",
  //   label: "Droid",
  //   icon: <img src="/icons/droid.png" alt="" className="w-4 h-4 object-contain" />,
  //   terminalPreset: { command: "droid", agentic: true },
  // },
  {
    type: "terminal",
    label: "OpenClaw",
    icon: <img src="/icons/moltbot.png" alt="" className="w-4 h-4 object-contain" />,
    terminalPreset: { command: "openclaw tui", agentic: true },
  },
  {
    type: "terminal",
    label: "Terminal",
    icon: <Terminal className="w-4 h-4" />,
  },
];

const defaultSizes: Record<string, { width: number; height: number }> = {
  note: { width: 200, height: 120 },
  todo: { width: 280, height: 160 },
  prompt: { width: 280, height: 160 },
  schedule: { width: 280, height: 220 },
  link: { width: 260, height: 140 },
  terminal: { width: 480, height: 500 },
  browser: { width: 680, height: 600 },
  workspace: { width: 620, height: 130 },
  recipe: { width: 320, height: 200 },
  gmail: { width: 280, height: 280 },
  calendar: { width: 280, height: 280 },
  contacts: { width: 280, height: 280 },
  sheets: { width: 300, height: 260 },
  forms: { width: 280, height: 280 },
};

const PLACEMENT_GAP = 32; // gap between items when finding space
const COLLAPSED_SIDEBAR_WIDTH = 36; // w-9 = 2.25rem ≈ 36px
const SIDEBAR_WIDTH_KEY = "orcabot:sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 200;

/** Read the current sidebar pixel width, accounting for collapsed state. */
function getSidebarWidth(collapsed: boolean): number {
  if (collapsed) return COLLAPSED_SIDEBAR_WIDTH;
  try {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? Math.max(160, Math.min(400, Number(saved))) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/**
 * Find available space for a new component that doesn't overlap existing items.
 * Strategy:
 * 1. Try to place within the visible viewport area, scanning positions on a grid.
 * 2. If no space in viewport, place to the right of all existing items.
 * Returns a snapped position (16px grid).
 *
 * @param sidebarInset  Pixels of the left edge occluded by the workspace sidebar.
 */
function findAvailableSpace(
  existingItems: Array<{ position: { x: number; y: number }; size: { width: number; height: number } }>,
  newSize: { width: number; height: number },
  viewport: { x: number; y: number; zoom: number },
  containerWidth: number,
  containerHeight: number,
  sidebarInset: number,
): { x: number; y: number } {
  // Convert viewport to flow coordinates (visible area)
  const zoom = viewport.zoom || 1;
  const viewLeft = (-viewport.x + sidebarInset) / zoom; // shift right past sidebar
  const viewTop = -viewport.y / zoom;
  const viewWidth = (containerWidth - sidebarInset) / zoom;
  const viewHeight = containerHeight / zoom;

  // Check if a candidate position overlaps any existing item
  function overlaps(cx: number, cy: number): boolean {
    for (const item of existingItems) {
      const ax = item.position.x;
      const ay = item.position.y;
      const aw = item.size.width;
      const ah = item.size.height;

      if (
        cx < ax + aw + PLACEMENT_GAP &&
        cx + newSize.width + PLACEMENT_GAP > ax &&
        cy < ay + ah + PLACEMENT_GAP &&
        cy + newSize.height + PLACEMENT_GAP > ay
      ) {
        return true;
      }
    }
    return false;
  }

  // Snap to 16px grid
  const snap = (v: number) => Math.round(v / 16) * 16;

  // 1. Try to place within the visible viewport with some margin
  const margin = 48;
  const stepX = Math.max(64, snap(newSize.width / 2));
  const stepY = Math.max(64, snap(newSize.height / 2));

  for (let y = snap(viewTop + margin); y + newSize.height < viewTop + viewHeight - margin; y += stepY) {
    for (let x = snap(viewLeft + margin); x + newSize.width < viewLeft + viewWidth - margin; x += stepX) {
      if (!overlaps(x, y)) {
        return { x, y };
      }
    }
  }

  // 2. No space in viewport — place to the right of all existing items
  if (existingItems.length === 0) {
    return { x: snap(viewLeft + margin), y: snap(viewTop + margin) };
  }

  let maxRight = -Infinity;
  let topAtMaxRight = 0;
  for (const item of existingItems) {
    const right = item.position.x + item.size.width;
    if (right > maxRight) {
      maxRight = right;
      topAtMaxRight = item.position.y;
    }
  }

  return { x: snap(maxRight + PLACEMENT_GAP * 2), y: snap(topAtMaxRight) };
}

export default function DashboardPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const dashboardId = params.id as string;
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const { user, isAuthenticated, isAuthResolved } = useAuthStore();

  // Dialog states
  const [isAddLinkOpen, setIsAddLinkOpen] = React.useState(false);
  const [newLinkUrl, setNewLinkUrl] = React.useState("");
  const [isExportDialogOpen, setIsExportDialogOpen] = React.useState(false);
  const [isShareDialogOpen, setIsShareDialogOpen] = React.useState(false);
  const [isBugReportOpen, setIsBugReportOpen] = React.useState(false);
  const [edgePolicyEditor, setEdgePolicyEditor] = React.useState<{
    terminalItemId: string; // dashboard item ID (for edge matching)
    ptyId: string;          // pty ID (for control plane API calls)
    integration: TerminalIntegration;
  } | null>(null);
  const [metricsHidden, setMetricsHidden] = React.useState(false);
  const [connectorMode, setConnectorMode] = React.useState(false);
  const [pendingConnection, setPendingConnection] = React.useState<PendingConnection | null>(null);
  const hasPendingConnection = Boolean(pendingConnection);
  const [connectionCursor, setConnectionCursor] = React.useState<{ x: number; y: number } | null>(null);
  const cursorRef = React.useRef<{ x: number; y: number } | null>(null);

  // Toolbar section collapse states
  const [toolbarAgentsCollapsed, setToolbarAgentsCollapsed] = React.useState(false);
  const [toolbarBlocksCollapsed, setToolbarBlocksCollapsed] = React.useState(false);
  const [toolbarGoogleCollapsed, setToolbarGoogleCollapsed] = React.useState(false);
  const [drivePortalEl, setDrivePortalEl] = React.useState<HTMLDivElement | null>(null);

  // Workspace sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [workspaceCwd, setWorkspaceCwd] = React.useState("/");
  const [terminalCwds, setTerminalCwds] = React.useState<Record<string, string>>({});

  // Canvas container ref for cursor tracking
  const canvasContainerRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = React.useRef({ x: 0, y: 0, zoom: 1 });
  const reactFlowInstanceRef = React.useRef<import("@xyflow/react").ReactFlowInstance | null>(null);
  const browserOpenHandlerRef = React.useRef<(url: string) => void>(() => {});
  const pendingBrowserUrlRef = React.useRef<string | null>(null);
  // Ref for UI command execution (updated after useUICommands hook)
  const executeUICommandRef = React.useRef<((command: import("@/types/collaboration").UICommand) => void) | null>(null);

  // Collaboration hook - real-time presence and updates
  const [collabState, collabActions] = useCollaboration({
    dashboardId,
    userId: user?.id || "",
    userName: user?.name || "",
    enabled: isAuthenticated && isAuthResolved && !!dashboardId && !!user?.id,
    onMessage: (message) => {
      if (message.type === "browser_open") {
        browserOpenHandlerRef.current(message.url);
      } else if (message.type === "pending_approval") {
        // Push notification for new approval request - invalidate the query and show toast
        queryClient.invalidateQueries({ queryKey: ["pending-approvals", dashboardId] });
        toast.warning(`Domain approval required: ${message.domain}`, {
          description: `Secret "${message.secret_name}" needs permission to access this domain. Open terminal settings to approve.`,
          duration: 10000,
        });
      }
    },
    onUICommand: (command) => {
      // Execute the UI command from agent
      if (executeUICommandRef.current) {
        executeUICommandRef.current(command);
      } else {
        console.warn("UI command received but executor not ready:", command.type);
      }
    },
  });

  // Convert PresenceInfo to PresenceUser (add isCurrentUser flag)
  const presenceUsers: PresenceUser[] = React.useMemo(() => {
    const users = collabState.presence.map((p) => ({
      ...p,
      isCurrentUser: p.userId === user?.id,
    }));

    // Always include current user if not in presence list yet
    if (user && !users.some((u) => u.userId === user.id)) {
      users.unshift({
        userId: user.id,
        userName: user.name,
        color: "var(--presence-1)",
        cursor: null,
        selectedItem: null,
        isTyping: false,
        isCurrentUser: true,
      });
    }

    return users;
  }, [collabState.presence, user]);

  // Track cursor position and send to collaboration
  const handleCanvasMouseMove = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!canvasContainerRef.current) return;

      const rect = canvasContainerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      collabActions.sendCursor({ x, y });
    },
    [collabActions]
  );

  // Handle cursor leaving the canvas
  const handleCanvasMouseLeave = React.useCallback(() => {
    // Send cursor off-screen to hide it for other users
    collabActions.sendCursor({ x: -1000, y: -1000 });
  }, [collabActions]);

  // Pending updates for batching
  const pendingUpdatesRef = React.useRef<Map<string, Partial<DashboardItem>>>(new Map());
  // Track item IDs with pending local updates (to avoid cache invalidation for self-updates)
  const pendingItemIdsRef = React.useRef<Set<string>>(new Set());
  // Track recently created item IDs (to avoid cache invalidation when WebSocket echoes our create)
  const recentlyCreatedItemsRef = React.useRef<Set<string>>(new Set());
  // Track number of mutations in flight (to prevent WebSocket-triggered invalidations during mutations)
  const mutationsInFlightRef = React.useRef(0);
  // Track recently deleted item IDs (to prevent refetches from bringing them back)
  const recentlyDeletedItemsRef = React.useRef<Set<string>>(new Set());
  // Track previous collaboration items to detect what actually changed
  const prevCollabItemsRef = React.useRef<DashboardItem[]>([]);
  const prevCollabEdgesRef = React.useRef<DashboardEdge[]>([]);
  const prevCollabSessionsRef = React.useRef<Session[]>([]);
  // workspaceCreateRequestedRef removed - workspace is now a sidebar, not a canvas block

  // Fetch dashboard data with better caching
  const {
    data,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["dashboard", dashboardId],
    queryFn: () => getDashboard(dashboardId),
    enabled: isAuthenticated && isAuthResolved && !!dashboardId,
    staleTime: 30000, // Consider data fresh for 30 seconds
    gcTime: 1000 * 60 * 30, // Keep in cache for 30 minutes (survives disconnects)
    refetchOnWindowFocus: false, // Don't refetch on window focus
    refetchInterval: false, // Don't auto-refetch
    retry: (failureCount, error) => {
      // Don't retry on 4xx/5xx errors - they won't magically fix themselves
      if (error && 'status' in error) {
        const status = (error as { status: number }).status;
        if (status >= 400 && status < 600) return false;
      }
      // Retry network errors up to 3 times
      return failureCount < 3;
    },
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff
    // Filter out recently deleted items from refetch results to prevent ghost reappearance
    select: (fetchedData) => {
      const deleted = recentlyDeletedItemsRef.current;
      if (deleted.size === 0) return fetchedData;
      return {
        ...fetchedData,
        items: fetchedData.items.filter((item: DashboardItem) => !deleted.has(item.id)),
        sessions: fetchedData.sessions.filter((session: Session) => !deleted.has(session.itemId)),
        edges: fetchedData.edges.filter(
          (edge: DashboardEdge) => !deleted.has(edge.sourceItemId) && !deleted.has(edge.targetItemId)
        ),
      };
    },
  });

  const dashboard = data?.dashboard;
  const items = data?.items ?? [];
  const sessions = data?.sessions ?? [];
  const edgesFromData = data?.edges ?? [];
  const role = data?.role ?? "viewer";

  // Workspace sidebar session: pick the first active session from any terminal
  const workspaceSessionId = React.useMemo(() => {
    const session = sessions.find((s) => s.status === "active")
      ?? sessions.find((s) => s.status === "creating")
      ?? sessions[0];
    return session?.id;
  }, [sessions]);
  // Build mapping from real IDs to stable keys for nodes that have them
  const realIdToStableKey = React.useMemo(() => {
    const map = new Map<string, string>();
    items.forEach(item => {
      if (item._stableKey) {
        map.set(item.id, item._stableKey);
      }
    });
    return map;
  }, [items]);

  // Convert edges to flow edges, using stable keys for source/target when available
  const edgesFromDataFlow = React.useMemo(() => edgesFromData.map(edge => {
    const flowEdge = toFlowEdge(edge);
    // Use stable keys if the source/target items have them
    return {
      ...flowEdge,
      source: realIdToStableKey.get(flowEdge.source) || flowEdge.source,
      target: realIdToStableKey.get(flowEdge.target) || flowEdge.target,
    };
  }), [edgesFromData, realIdToStableKey]);
  const browserPrewarmRef = React.useRef(false);

  // Check if dashboard has any active sessions (indicates sandbox is ready for metrics)
  const hasActiveSandbox = React.useMemo(() => {
    return sessions.some((s) => s.status === "active");
  }, [sessions]);

  const metricsQuery = useQuery({
    queryKey: ["sandbox-metrics", dashboardId],
    queryFn: () => getDashboardMetrics(dashboardId as string),
    enabled: Boolean(dashboardId) && hasActiveSandbox && process.env.NODE_ENV === "development",
    refetchInterval: 5000,
    staleTime: 4000,
    retry: false, // Don't retry on 404 - expected when no sandbox exists
  });

  React.useEffect(() => {
    if (!isAuthenticated || !isAuthResolved || !dashboardId) {
      return;
    }
    if (browserPrewarmRef.current) {
      return;
    }
    browserPrewarmRef.current = true;
    startDashboardBrowser(dashboardId).catch(() => {});

    return () => {
      browserPrewarmRef.current = false;
      stopDashboardBrowser(dashboardId).catch(() => {});
    };
  }, [dashboardId, isAuthenticated, isAuthResolved]);

  // Compute a non-overlapping position for a new block and ensure it's visible
  const computePlacement = React.useCallback(
    (newSize: { width: number; height: number }) => {
      const container = canvasContainerRef.current;
      const containerWidth = container?.clientWidth ?? 1200;
      const containerHeight = container?.clientHeight ?? 800;
      const sidebarInset = getSidebarWidth(sidebarCollapsed);

      return findAvailableSpace(
        items,
        newSize,
        viewportRef.current,
        containerWidth,
        containerHeight,
        sidebarInset,
      );
    },
    [items, sidebarCollapsed],
  );

  // Pan/zoom so a newly-placed block is visible
  const ensureVisible = React.useCallback(
    (position: { x: number; y: number }, size: { width: number; height: number }) => {
      // Defer to next frame so the optimistic node is rendered into the flow
      requestAnimationFrame(() => {
        const instance = reactFlowInstanceRef.current;
        if (!instance) {
          console.warn("[ensureVisible] no ReactFlow instance");
          return;
        }

        const vp = viewportRef.current;
        const zoom = vp.zoom || 1;
        const container = canvasContainerRef.current;
        const containerWidth = container?.clientWidth ?? 1200;
        const containerHeight = container?.clientHeight ?? 800;
        const sidebarInset = getSidebarWidth(sidebarCollapsed);

        // Visible area in flow coordinates (shifted right past sidebar)
        const usableWidth = containerWidth - sidebarInset;
        const viewLeft = (-vp.x + sidebarInset) / zoom;
        const viewTop = -vp.y / zoom;
        const viewRight = viewLeft + usableWidth / zoom;
        const viewBottom = viewTop + containerHeight / zoom;

        const blockRight = position.x + size.width;
        const blockBottom = position.y + size.height;
        const margin = 48;

        // Check if the block is already fully within the visible area
        if (
          position.x >= viewLeft + margin &&
          position.y >= viewTop + margin &&
          blockRight <= viewRight - margin &&
          blockBottom <= viewBottom - margin
        ) {
          return; // already visible
        }

        // Compute bounding box of all existing items + the new block
        let minX = position.x;
        let minY = position.y;
        let maxX = blockRight;
        let maxY = blockBottom;
        for (const item of items) {
          minX = Math.min(minX, item.position.x);
          minY = Math.min(minY, item.position.y);
          maxX = Math.max(maxX, item.position.x + item.size.width);
          maxY = Math.max(maxY, item.position.y + item.size.height);
        }

        // Check whether the bounding box fits at the current zoom
        const boundsWidth = maxX - minX + margin * 2;
        const boundsHeight = maxY - minY + margin * 2;
        const fitsAtCurrentZoom =
          boundsWidth * zoom <= usableWidth && boundsHeight * zoom <= containerHeight;

        if (fitsAtCurrentZoom) {
          // Everything fits at the current zoom — just pan (no zoom change)
          const centerX = (minX + maxX) / 2;
          const centerY = (minY + maxY) / 2;
          // setCenter centers the viewport on the given flow coordinate at the given zoom
          // Offset the center rightward by half the sidebar inset so the visible
          // center (not the DOM center) is used.
          const offsetX = sidebarInset / 2 / zoom;
          instance.setCenter(centerX + offsetX, centerY, { zoom, duration: 300 });
        } else {
          // Need to zoom out — compute the maximum zoom that fits, capped at current
          const neededZoom = Math.min(
            usableWidth / boundsWidth,
            containerHeight / boundsHeight,
            zoom, // never zoom in
          );
          const clampedZoom = Math.max(0.1, neededZoom);
          const centerX = (minX + maxX) / 2;
          const centerY = (minY + maxY) / 2;
          const offsetX = sidebarInset / 2 / clampedZoom;
          instance.setCenter(centerX + offsetX, centerY, { zoom: clampedZoom, duration: 300 });
        }
      });
    },
    [items, sidebarCollapsed],
  );

  // Create item mutation
  const createItemMutation = useMutation({
    mutationFn: ({
      clientTempId: _clientTempId,
      sourceId: _sourceId,
      sourceHandle: _sourceHandle,
      targetHandle: _targetHandle,
      ...item
    }: Parameters<typeof createItem>[1] & {
      clientTempId?: string;
      sourceId?: string;
      sourceHandle?: string;
      targetHandle?: string;
    }) =>
      createItem(dashboardId, item),
    onMutate: async (item) => {
      // Increment mutations in-flight counter to prevent WebSocket-triggered invalidations
      mutationsInFlightRef.current++;

      // Always cancel in-flight queries to prevent stale data overwriting our updates
      await queryClient.cancelQueries({ queryKey: ["dashboard", dashboardId] });

      // Skip optimistic update if disabled
      if (!OPTIMISTIC_UPDATE_ENABLED) {
        return {
          previous: undefined,
          tempId: undefined,
          sourceId: item.sourceId,
          sourceHandle: item.sourceHandle,
          targetHandle: item.targetHandle,
        };
      }

      await queryClient.cancelQueries({ queryKey: ["dashboard", dashboardId] });
      const previous = queryClient.getQueryData<{
        dashboard: Dashboard;
        items: DashboardItem[];
        sessions: Session[];
        edges: DashboardEdge[];
        role: string;
      }>(["dashboard", dashboardId]);

      const now = new Date().toISOString();
      const tempId = item.clientTempId || `temp-${generateId()}`;
      const optimisticItem: DashboardItem = {
        id: tempId,
        dashboardId,
        type: item.type,
        content: item.content,
        position: item.position,
        size: item.size,
        createdAt: now,
        updatedAt: now,
        _stableKey: tempId, // Preserve for React key stability
      };

      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          const existingEdges = oldData.edges ?? [];
          const nextEdges = item.sourceId
            ? [
                ...existingEdges,
                {
                  id: `edge-${item.sourceId}-${tempId}-${item.sourceHandle ?? "auto"}-${item.targetHandle ?? "auto"}`,
                  dashboardId,
                  sourceItemId: item.sourceId,
                  targetItemId: tempId,
                  sourceHandle: item.sourceHandle,
                  targetHandle: item.targetHandle,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                } satisfies DashboardEdge,
              ]
            : oldData.edges;
          return {
            ...oldData,
            items: [...oldData.items, optimisticItem],
            edges: nextEdges ?? existingEdges,
          };
        }
      );

      if (item.sourceId) {
        const edgeId = `edge-${item.sourceId}-${tempId}-${item.sourceHandle ?? "auto"}-${item.targetHandle ?? "auto"}`;
        setEdges((prev) => {
          if (prev.some((edge) => edge.id === edgeId)) return prev;
          return [
            ...prev,
            {
              id: edgeId,
              source: item.sourceId as string,
              target: tempId,
              sourceHandle: item.sourceHandle,
              targetHandle: item.targetHandle,
              type: "smoothstep",
              animated: true,
              style: { stroke: "var(--accent-primary)", strokeWidth: 2 },
            },
          ];
        });
      }

      return {
        previous,
        tempId,
        sourceId: item.sourceId,
        sourceHandle: item.sourceHandle,
        targetHandle: item.targetHandle,
      };
    },
    onSuccess: (createdItem, _variables, context) => {
      // Decrement mutations in-flight counter
      mutationsInFlightRef.current--;

      if (!OPTIMISTIC_UPDATE_ENABLED) {
        // Track this item ID so WebSocket echo doesn't trigger invalidation
        recentlyCreatedItemsRef.current.add(createdItem.id);
        // Clean up after a short delay (enough time for WebSocket to echo)
        setTimeout(() => {
          recentlyCreatedItemsRef.current.delete(createdItem.id);
        }, 2000);

        // When optimistic updates are disabled, directly add the item to query data
        queryClient.setQueryData(
          ["dashboard", dashboardId],
          (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
            // If no data yet, force a refetch instead
            if (!oldData) {
              void queryClient.refetchQueries({ queryKey: ["dashboard", dashboardId] });
              return oldData;
            }
            // Don't add if already exists (from WebSocket)
            if (oldData.items.some((item) => item.id === createdItem.id)) {
              return oldData;
            }
            return {
              ...oldData,
              items: [...oldData.items, createdItem],
            };
          }
        );
        if (context?.sourceId) {
          createEdgeMutation.mutate({
            sourceItemId: context.sourceId,
            targetItemId: createdItem.id,
            sourceHandle: context.sourceHandle,
            targetHandle: context.targetHandle,
          });
        }
        toast.success("Block added");
        return;
      }

      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          const hasTemp = context?.tempId
            ? oldData.items.some((item) => item.id === context.tempId)
            : false;
          const nextItems = hasTemp
            ? oldData.items.map((item) =>
                item.id === context?.tempId
                  ? { ...createdItem, _stableKey: context.tempId } // Preserve temp ID for React key stability
                  : item
              )
            : [...oldData.items, createdItem];
          const existingEdges = oldData.edges ?? [];
          const nextEdges = context?.tempId
            ? existingEdges.filter((edge) => edge.targetItemId !== context.tempId)
            : existingEdges;
          return {
            ...oldData,
            items: nextItems,
            edges: nextEdges,
          };
        }
      );
      if (context?.sourceId) {
        const sourceId = context.sourceId;
        // Create backend edge with real IDs for persistence
        createEdgeMutation.mutate({
          sourceItemId: sourceId,
          targetItemId: createdItem.id,
          sourceHandle: context.sourceHandle,
          targetHandle: context.targetHandle,
        });
        // Keep visual edge using tempId (stable key) since node ID = _stableKey = tempId
        // Don't update edge target to real ID - it would break visual connectivity
      }
      toast.success("Block added");
    },
    onError: (error, _variables, context) => {
      // Decrement mutations in-flight counter
      mutationsInFlightRef.current--;

      if (context?.previous) {
        queryClient.setQueryData(["dashboard", dashboardId], context.previous);
      }
      if (context?.sourceId) {
        setEdges((prev) =>
          prev.filter(
            (edge) =>
              !(edge.source === context.sourceId && edge.target === context.tempId)
          )
        );
      }
      toast.error(`Failed to add block: ${error.message}`);
    },
  });

  const createEdgeMutation = useMutation({
    mutationFn: (edge: {
      sourceItemId: string;
      targetItemId: string;
      sourceHandle?: string;
      targetHandle?: string;
    }) => createEdge(dashboardId, edge),
    onSuccess: (createdEdge) => {
      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          const existingEdges = oldData.edges ?? [];
          if (existingEdges.some((edge) => edge.id === createdEdge.id)) {
            return oldData;
          }
          return {
            ...oldData,
            edges: [...existingEdges, createdEdge],
          };
        }
      );

      // Auto-attach integration when edge connects integration block to terminal
      handleIntegrationEdge(createdEdge, "attach");
    },
    onError: (error) => {
      toast.error(`Failed to save connection: ${error.message}`);
    },
  });

  // Handle integration-to-terminal edge creation/deletion
  const handleIntegrationEdge = React.useCallback(
    async (edge: { id: string; sourceItemId: string; targetItemId: string }, action: "attach" | "detach") => {
      // Get current items from cache
      const data = queryClient.getQueryData<{
        dashboard: Dashboard;
        items: DashboardItem[];
        sessions: Session[];
        edges: DashboardEdge[];
        role: string;
      }>(["dashboard", dashboardId]);
      if (!data) return;

      const { items: currentItems, sessions: currentSessions } = data;

      const sourceItem = currentItems.find((i) => i.id === edge.sourceItemId);
      const targetItem = currentItems.find((i) => i.id === edge.targetItemId);
      if (!sourceItem || !targetItem) return;

      // Determine which is the integration and which is the terminal
      let integrationItem: DashboardItem | null = null;
      let terminalItem: DashboardItem | null = null;

      if (isIntegrationBlockType(sourceItem.type) && targetItem.type === "terminal") {
        integrationItem = sourceItem;
        terminalItem = targetItem;
      } else if (isIntegrationBlockType(targetItem.type) && sourceItem.type === "terminal") {
        integrationItem = targetItem;
        terminalItem = sourceItem;
      }

      if (!integrationItem || !terminalItem) return;

      // Get the terminal's active session
      const session = currentSessions.find(
        (s) => s.itemId === terminalItem!.id && s.status === "active"
      );
      if (!session) {
        if (action === "attach") {
          toast.warning("Terminal not active. Start the terminal first, then draw the connection.");
        }
        return;
      }

      // Use ptyId as the terminal ID - this is what the control plane expects
      const ptyId = session.ptyId;
      if (!ptyId) {
        if (action === "attach") {
          toast.warning("Terminal PTY not ready. Wait for terminal to initialize.");
        }
        return;
      }

      const provider = getProviderForBlockType(integrationItem.type);
      if (!provider) return;

      try {
        if (action === "attach") {
          // Browser is special - doesn't need OAuth, but needs URL patterns
          if (provider === "browser") {
            // Check if already attached
            const availableIntegrations = await listAvailableIntegrations(dashboardId, ptyId);
            const alreadyAttached = availableIntegrations.find(
              (i) => i.provider === "browser" && i.attached
            );
            if (alreadyAttached) {
              toast.info("Browser is already attached to this terminal");
              return;
            }

            // Get URL from browser block content
            const browserUrl = integrationItem.content?.trim();

            let browserPolicy: BrowserPolicy;
            let toastMessage: string;

            if (browserUrl) {
              // Browser has a URL - create restricted policy for that domain
              let urlPattern = browserUrl;
              try {
                const url = new URL(browserUrl);
                urlPattern = `${url.origin}/*`;
              } catch {
                // If not a valid URL, use as-is
                urlPattern = browserUrl;
              }

              browserPolicy = {
                canNavigate: true,
                urlFilter: { mode: "allowlist", patterns: [urlPattern] },
                canClick: true,
                canType: true,
                canScroll: true,
                canScreenshot: true,
                canExtractText: true,
                canFillForms: false,
                canSubmitForms: false,
                canDownload: false,
                canUpload: false,
                canExecuteJs: false,
                canUseStoredCredentials: false,
                canInputCredentials: false,
                canReadCookies: false,
                canInspectNetwork: false,
                canModifyRequests: false,
              };
              toastMessage = `Browser attached to terminal (${urlPattern})`;
            } else {
              // No URL - attach with full access (all URLs allowed)
              browserPolicy = {
                canNavigate: true,
                urlFilter: { mode: "allowlist", patterns: ["*://*/*"] },
                canClick: true,
                canType: true,
                canScroll: true,
                canScreenshot: true,
                canExtractText: true,
                canFillForms: true,
                canSubmitForms: true,
                canDownload: true,
                canUpload: true,
                canExecuteJs: true,
                canUseStoredCredentials: false,
                canInputCredentials: true,
                canReadCookies: true,
                canInspectNetwork: true,
                canModifyRequests: false,
              };
              toastMessage = "Browser attached to terminal (full access)";
            }

            const result = await attachIntegration(dashboardId, ptyId, {
              provider: "browser",
              policy: browserPolicy,
            });

            // Update edge to show security indicator
            setEdges((prev) =>
              prev.map((e) =>
                e.id === edge.id
                  ? {
                      ...e,
                      type: "integration",
                      data: { securityLevel: result.securityLevel, provider: "browser" },
                    }
                  : e
              )
            );
            toast.success(toastMessage);
          } else {
            // OAuth-based integrations - need userIntegrationId
            const availableIntegrations = await listAvailableIntegrations(dashboardId, ptyId);
            const userIntegration = availableIntegrations.find(
              (i) => i.provider === provider && i.connected && !i.attached
            );

            if (!userIntegration) {
              // Check if already attached
              const alreadyAttached = availableIntegrations.find(
                (i) => i.provider === provider && i.attached
              );
              if (alreadyAttached) {
                toast.info(`${getProviderDisplayName(provider)} is already attached to this terminal`);
                return;
              }
              // Not connected via OAuth yet - delete the edge and show warning
              await deleteEdge(dashboardId, edge.id);
              setEdges((prev) => prev.filter((e) => e.id !== edge.id));
              queryClient.setQueryData(
                ["dashboard", dashboardId],
                (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
                  if (!oldData) return oldData;
                  return {
                    ...oldData,
                    edges: oldData.edges.filter((e) => e.id !== edge.id),
                  };
                }
              );
              toast.warning(`Sign in to ${getProviderDisplayName(provider)} first. Click the ${getProviderDisplayName(provider)} block and select "Connect" to authenticate.`);
              return;
            }

            const result = await attachIntegration(dashboardId, ptyId, {
              provider,
              userIntegrationId: userIntegration.userIntegrationId,
              policy: createReadOnlyPolicy(provider),
            });

            // Update edge to show security indicator
            setEdges((prev) =>
              prev.map((e) =>
                e.id === edge.id
                  ? {
                      ...e,
                      type: "integration",
                      data: { securityLevel: result.securityLevel, provider },
                    }
                  : e
              )
            );
            toast.success(`${getProviderDisplayName(provider)} attached to terminal (read-only)`);
          }
        } else {
          await detachIntegration(dashboardId, ptyId, provider);

          // Reset edge back to normal type
          setEdges((prev) =>
            prev.map((e) =>
              e.id === edge.id
                ? { ...e, type: "smoothstep", data: undefined }
                : e
            )
          );
          toast.success(`${getProviderDisplayName(provider)} detached from terminal`);
        }
        // Invalidate terminal integrations to refresh the IntegrationsPanel
        queryClient.invalidateQueries({
          queryKey: ["terminal-integrations", dashboardId, ptyId],
        });
        queryClient.invalidateQueries({
          queryKey: ["available-integrations", dashboardId, ptyId],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        if (action === "attach") {
          toast.error(`Failed to attach integration: ${msg}`);
        } else {
          toast.error(`Failed to detach integration: ${msg}`);
        }
      }
    },
    [dashboardId, queryClient, setEdges]
  );

  // Handle policy update from IntegrationsPanel - sync edge data with new security level
  const handlePolicyUpdate = React.useCallback(
    (terminalItemId: string, provider: string, securityLevel: string) => {
      // Find edges connecting this terminal to integration blocks
      setEdges((prev) =>
        prev.map((edge) => {
          // Check if this edge connects the terminal to an integration block
          const otherItemId = edge.source === terminalItemId ? edge.target : edge.target === terminalItemId ? edge.source : null;
          if (!otherItemId) return edge;

          // Find the other item to check if it's the right integration type
          const otherItem = items.find((i) => i.id === otherItemId);
          if (!otherItem) return edge;

          // Check if the integration block type matches the provider
          const blockProvider = getProviderForBlockType(otherItem.type);
          if (blockProvider !== provider) return edge;

          // Update this edge's security level
          return {
            ...edge,
            type: "integration",
            data: { ...edge.data, securityLevel, provider },
          };
        })
      );
    },
    [items, setEdges]
  );

  // Handle edge label click - open policy editor for the integration on this edge
  const handleEdgeLabelClick = React.useCallback(
    async (edgeId: string, provider: string) => {
      // Find the edge to determine which terminal it connects
      const edge = edges.find((e) => e.id === edgeId);
      if (!edge) return;

      // Determine which node is the terminal (terminals are targets typically)
      const sourceItem = items.find((i) => i.id === edge.source);
      const targetItem = items.find((i) => i.id === edge.target);
      const terminalItem = targetItem?.type === "terminal" ? targetItem : sourceItem?.type === "terminal" ? sourceItem : null;
      if (!terminalItem) return;

      // Resolve ptyId from the active session - the control plane uses ptyId, not item ID
      const session = sessions.find(
        (s) => s.itemId === terminalItem.id && s.status === "active"
      );
      if (!session?.ptyId) {
        toast.warning("Terminal not active. Start the terminal first.");
        return;
      }
      const ptyId = session.ptyId;

      // Always fetch fresh from API - cache may be stale after recent attach/detach
      let integrations: TerminalIntegration[];
      try {
        integrations = await listTerminalIntegrations(dashboardId, ptyId);
        // Update the cache so the panel benefits too
        queryClient.setQueryData(
          ["terminal-integrations", dashboardId, ptyId],
          integrations
        );
      } catch {
        toast.error("Failed to load integration details");
        return;
      }

      // Find the matching integration by provider
      const integration = integrations.find((i) => i.provider === provider);
      if (!integration) {
        toast.error(`No ${provider} integration found on this terminal`);
        return;
      }

      setEdgePolicyEditor({ terminalItemId: terminalItem.id, ptyId, integration });
    },
    [edges, items, sessions, dashboardId, queryClient]
  );

  // Handle integration attached via IntegrationsPanel - auto-create integration block if needed
  const handleIntegrationAttached = React.useCallback(
    async (terminalItemId: string, provider: string, securityLevel: string) => {
      // Get the block type for this provider
      const blockType = getBlockTypeForProvider(provider as IntegrationProvider);
      if (!blockType) return; // Not a block-creating provider

      // Check if an integration block of this type already exists
      const existingBlock = items.find((item) => item.type === blockType);
      if (existingBlock) {
        // Block exists - check if edge exists, if not create one
        const edgeExists = edges.some(
          (e) =>
            (e.source === existingBlock.id && e.target === terminalItemId) ||
            (e.source === terminalItemId && e.target === existingBlock.id)
        );
        if (!edgeExists) {
          // Create edge from integration block to terminal
          const edgeId = generateId();
          const now = new Date().toISOString();
          const newEdge: DashboardEdge = {
            id: edgeId,
            dashboardId,
            sourceItemId: existingBlock.id,
            targetItemId: terminalItemId,
            createdAt: now,
            updatedAt: now,
          };
          try {
            await createEdge(dashboardId, newEdge);
            setEdges((prev) => [
              ...prev,
              {
                id: edgeId,
                source: existingBlock.id,
                target: terminalItemId,
                type: "integration",
                data: { securityLevel, provider },
              },
            ]);
          } catch (err) {
            console.warn("Failed to create edge:", err);
          }
        } else {
          // Edge exists - just update its security level
          setEdges((prev) =>
            prev.map((e) =>
              (e.source === existingBlock.id && e.target === terminalItemId) ||
              (e.source === terminalItemId && e.target === existingBlock.id)
                ? { ...e, type: "integration", data: { ...e.data, securityLevel, provider } }
                : e
            )
          );
        }
        return;
      }

      // No existing block - create one
      const terminalItem = items.find((i) => i.id === terminalItemId);
      if (!terminalItem) return;

      // Position the new block to the left of the terminal
      const blockSize = defaultSizes[blockType] || { width: 280, height: 280 };
      const newPosition = {
        x: terminalItem.position.x - blockSize.width - 50,
        y: terminalItem.position.y,
      };

      // Create the integration block - await to ensure it appears before creating edge
      try {
        const createdItem = await createItemMutation.mutateAsync({
          type: blockType as DashboardItemType,
          position: newPosition,
          size: blockSize,
          content: "",
          clientTempId: `temp-${generateId()}`,
          sourceId: undefined,
          sourceHandle: "right",
          targetHandle: "left",
        });

        // Create edge from new integration block to terminal
        const edgeId = generateId();
        const now2 = new Date().toISOString();
        const newEdge: DashboardEdge = {
          id: edgeId,
          dashboardId,
          sourceItemId: createdItem.id,
          targetItemId: terminalItemId,
          createdAt: now2,
          updatedAt: now2,
        };
        await createEdge(dashboardId, newEdge);
        setEdges((prev) => [
          ...prev,
          {
            id: edgeId,
            source: createdItem.id,
            target: terminalItemId,
            type: "integration",
            data: { securityLevel, provider },
          },
        ]);
        ensureVisible(newPosition, blockSize);
        toast.success(`Created ${getProviderDisplayName(provider as IntegrationProvider)} block`);
      } catch (err) {
        console.warn("Failed to create integration block:", err);
        toast.error("Failed to create integration block");
      }
    },
    [items, edges, dashboardId, setEdges, createItemMutation, ensureVisible]
  );

  // Handle storage linked to workspace - auto-attach to all terminals in the dashboard
  const handleStorageLinked = React.useCallback(
    async (workspaceItemIdOrProvider: string, providerArg?: "google_drive" | "onedrive" | "box" | "github") => {
      // Support both old signature (itemId, provider) and new signature (provider only)
      const provider = providerArg ?? workspaceItemIdOrProvider as "google_drive" | "onedrive" | "box" | "github";
      console.log(`[handleStorageLinked] called for provider: ${provider}`);
      // Find all terminal items with active sessions
      // Terminals share the sandbox session with the workspace, so we attach to all active terminals
      const terminalItems = items.filter((item) => item.type === "terminal");

      if (terminalItems.length === 0) {
        console.log("[handleStorageLinked] no terminal items on dashboard");
        return;
      }

      let attachedCount = 0;
      let skippedNoSession = 0;
      let skippedNoIntegration = 0;

      // For each terminal, try to attach the storage integration
      for (const terminalItem of terminalItems) {
        // Find the terminal's active session
        const session = sessions.find(
          (s) => s.itemId === terminalItem.id && s.status === "active"
        );
        if (!session?.ptyId) {
          console.log(`[handleStorageLinked] terminal ${terminalItem.id} has no active session`);
          skippedNoSession++;
          continue;
        }

        try {
          // Check if already attached
          const availableIntegrations = await listAvailableIntegrations(dashboardId, session.ptyId);
          console.log(`[handleStorageLinked] available integrations:`, availableIntegrations.map(i => ({
            provider: i.provider,
            connected: i.connected,
            attached: i.attached,
          })));
          const alreadyAttached = availableIntegrations.find(
            (i) => i.provider === provider && i.attached
          );
          if (alreadyAttached) {
            console.log(`[handleStorageLinked] ${provider} already attached to terminal`);
            continue;
          }

          // Find the user's integration for this provider
          const userIntegration = availableIntegrations.find(
            (i) => i.provider === provider && i.connected && !i.attached
          );
          if (!userIntegration) {
            console.log(`[handleStorageLinked] no connected ${provider} integration found`);
            skippedNoIntegration++;
            continue;
          }

          // Attach with full access (read/write) since it's workspace storage
          await attachIntegration(dashboardId, session.ptyId, {
            provider,
            userIntegrationId: userIntegration.userIntegrationId,
            // Use full access policy for workspace storage
          });

          attachedCount++;

          // Invalidate queries
          queryClient.invalidateQueries({
            queryKey: ["terminal-integrations", dashboardId, session.ptyId],
          });
          queryClient.invalidateQueries({
            queryKey: ["available-integrations", dashboardId, session.ptyId],
          });
        } catch (err) {
          console.warn(`Failed to auto-attach ${provider} to terminal:`, err);
        }
      }

      const providerName = getProviderDisplayName(provider);
      if (attachedCount > 0) {
        toast.success(`${providerName} auto-attached to ${attachedCount} terminal${attachedCount > 1 ? 's' : ''}`);
      } else if (skippedNoSession > 0) {
        toast.info(`${providerName} linked. Start a terminal to attach it.`);
      } else if (skippedNoIntegration > 0) {
        console.log(`[handleStorageLinked] ${provider} linked but no matching integration record found`);
      }
    },
    [items, sessions, dashboardId, queryClient]
  );

  // Update item mutation - don't invalidate cache to avoid excessive refetches
  const updateItemMutation = useMutation({
    mutationFn: ({
      itemId,
      changes,
    }: {
      itemId: string;
      changes: Parameters<typeof updateItem>[2];
    }) => updateItem(dashboardId, itemId, changes),
    // Don't auto-invalidate - we update local state optimistically
    onError: (error) => {
      toast.error(`Failed to save: ${error.message}`);
      // Refetch on error to restore correct state
      queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    },
  });

  // Delete item mutation
  const deleteItemMutation = useMutation({
    mutationFn: (itemId: string) => deleteItem(dashboardId, itemId),
    onMutate: async (itemId) => {
      // Increment mutations in-flight counter to prevent WebSocket-triggered invalidations
      mutationsInFlightRef.current++;

      // Track as recently deleted to prevent refetches from bringing it back
      recentlyDeletedItemsRef.current.add(itemId);

      // Always cancel in-flight queries to prevent stale data overwriting our updates
      await queryClient.cancelQueries({ queryKey: ["dashboard", dashboardId] });

      // Skip optimistic update if disabled
      if (!OPTIMISTIC_UPDATE_ENABLED) {
        return { previous: undefined, previousEdges: undefined };
      }
      const previous = queryClient.getQueryData<{
        dashboard: Dashboard;
        items: DashboardItem[];
        sessions: Session[];
        edges: DashboardEdge[];
        role: string;
      }>(["dashboard", dashboardId]);
      const previousEdges = edges;

      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            items: oldData.items.filter((item) => item.id !== itemId),
            sessions: oldData.sessions.filter((session) => session.itemId !== itemId),
            edges: oldData.edges.filter(
              (edge) => edge.sourceItemId !== itemId && edge.targetItemId !== itemId
            ),
          };
        }
      );

      setEdges((prev) =>
        prev.filter((edge) => edge.source !== itemId && edge.target !== itemId)
      );

      return { previous, previousEdges };
    },
    onSuccess: (_data, itemId) => {
      if (!OPTIMISTIC_UPDATE_ENABLED) {
        // When optimistic updates are disabled, directly remove the item from query data
        queryClient.setQueryData(
          ["dashboard", dashboardId],
          (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
            if (!oldData) return oldData;
            return {
              ...oldData,
              items: oldData.items.filter((item) => item.id !== itemId),
              sessions: oldData.sessions.filter((session) => session.itemId !== itemId),
              edges: oldData.edges.filter(
                (edge) => edge.sourceItemId !== itemId && edge.targetItemId !== itemId
              ),
            };
          }
        );
        setEdges((prev) =>
          prev.filter((edge) => edge.source !== itemId && edge.target !== itemId)
        );
      }
      toast.success("Block deleted");
    },
    onError: (error, _itemId, context) => {
      // On error, remove from recently deleted so it can reappear
      recentlyDeletedItemsRef.current.delete(_itemId);

      if (context?.previous) {
        queryClient.setQueryData(["dashboard", dashboardId], context.previous);
      }
      if (context?.previousEdges) {
        setEdges(context.previousEdges);
      }
      toast.error(`Failed to delete block: ${error.message}`);
    },
    onSettled: (_data, _error, itemId) => {
      // Decrement mutations in-flight counter (always, whether success or error)
      mutationsInFlightRef.current--;

      // Keep item in recentlyDeletedItemsRef for a grace period to prevent
      // late-arriving WebSocket echoes or refetches from bringing it back
      setTimeout(() => {
        recentlyDeletedItemsRef.current.delete(itemId);
      }, 5000);
    },
  });

  // Handle integration detached via IntegrationsPanel - remove canvas block + edge
  const handleIntegrationDetached = React.useCallback(
    (terminalItemId: string, provider: string) => {
      const blockType = getBlockTypeForProvider(provider as IntegrationProvider);
      if (!blockType) return;

      // Find the specific integration block connected to this terminal via edges,
      // not just any block of the same type (there may be multiple gmail blocks, etc.)
      const connectedBlockIds = new Set<string>();
      for (const e of edges) {
        const otherId = e.source === terminalItemId ? e.target : e.target === terminalItemId ? e.source : null;
        if (otherId) connectedBlockIds.add(otherId);
      }
      const integrationBlock = items.find(
        (item) => item.type === blockType && connectedBlockIds.has(item.id)
      );
      if (!integrationBlock) return;

      // Remove edges between this integration block and terminal
      const edgesToRemove = edges.filter(
        (e) =>
          (e.source === integrationBlock.id && e.target === terminalItemId) ||
          (e.source === terminalItemId && e.target === integrationBlock.id)
      );

      if (edgesToRemove.length > 0) {
        const edgeIdsToRemove = new Set(edgesToRemove.map((e) => e.id));
        setEdges((prev) => prev.filter((e) => !edgeIdsToRemove.has(e.id)));

        for (const edge of edgesToRemove) {
          deleteEdge(dashboardId, edge.id).catch((err) => {
            console.warn("Failed to delete edge:", err);
          });
        }
      }

      // Check if the integration block has any remaining edges
      const remainingEdges = edges.filter(
        (e) =>
          (e.source === integrationBlock.id || e.target === integrationBlock.id) &&
          !edgesToRemove.some((r) => r.id === e.id)
      );

      // Only delete the block if it has no other connections
      if (remainingEdges.length === 0) {
        deleteItemMutation.mutate(integrationBlock.id);
      }
    },
    [items, edges, dashboardId, setEdges, deleteItemMutation]
  );

  // Flush pending updates to API (debounced)
  const flushPendingUpdates = useDebouncedCallback(() => {
    // Snapshot and clear pending updates atomically
    const updates = new Map(pendingUpdatesRef.current);
    pendingUpdatesRef.current.clear();

    updates.forEach((changes, itemId) => {
      mutationsInFlightRef.current++;
      updateItemMutation.mutate(
        { itemId, changes },
        {
          onSettled: () => {
            mutationsInFlightRef.current--;
            // Only clear pending tracking if no new updates were queued while
            // this mutation was in-flight. Without this check, a rapid second
            // move (A→B→C) would clear the guard after the first save (B),
            // allowing the WebSocket echo to trigger a refetch that overwrites
            // the optimistic position (C) with the stale saved position (B).
            if (!pendingUpdatesRef.current.has(itemId)) {
              pendingItemIdsRef.current.delete(itemId);
            }
          },
        }
      );
    });
  }, 500);

  // Create edge function for useUICommands
  const createEdgeFn = React.useCallback(
    async (edge: {
      sourceItemId: string;
      targetItemId: string;
      sourceHandle?: string;
      targetHandle?: string;
    }) => {
      return new Promise<void>((resolve, reject) => {
        createEdgeMutation.mutate(edge, {
          onSuccess: () => resolve(),
          onError: (error) => reject(error),
        });
      });
    },
    [createEdgeMutation]
  );

  // Delete edge function for useUICommands
  const deleteEdgeFn = React.useCallback(
    async (edgeId: string) => {
      // Look up the edge before deleting to handle auto-detach
      const data = queryClient.getQueryData<{
        dashboard: Dashboard;
        items: DashboardItem[];
        sessions: Session[];
        edges: DashboardEdge[];
        role: string;
      }>(["dashboard", dashboardId]);
      const edgeToDelete = data?.edges?.find((e) => e.id === edgeId);

      await deleteEdge(dashboardId, edgeId);
      // Update local state
      setEdges((prev) => prev.filter((e) => e.id !== edgeId));
      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            edges: oldData.edges.filter((e) => e.id !== edgeId),
          };
        }
      );

      // Auto-detach integration when edge between integration and terminal is removed
      if (edgeToDelete) {
        handleIntegrationEdge(
          { id: edgeToDelete.id, sourceItemId: edgeToDelete.sourceItemId, targetItemId: edgeToDelete.targetItemId },
          "detach"
        );
      }
    },
    [dashboardId, queryClient, handleIntegrationEdge]
  );

  // Callback to send UI command results back to DashboardDO for broadcast
  const handleCommandExecuted = React.useCallback(
    (result: import("@/types/collaboration").UICommandResultMessage) => {
      sendUICommandResult(dashboardId, {
        command_id: result.command_id,
        success: result.success,
        error: result.error,
        created_item_id: result.created_item_id,
      }).catch((err) => {
        console.error("[UI Commands] Failed to send result:", err);
      });
    },
    [dashboardId]
  );

  // UI Commands hook - allows agents to control dashboard UI
  const { executeCommand } = useUICommands({
    dashboardId,
    items,
    edges: edgesFromData,
    createItemMutation: createItemMutation as Parameters<typeof useUICommands>[0]["createItemMutation"],
    updateItemMutation: updateItemMutation as Parameters<typeof useUICommands>[0]["updateItemMutation"],
    deleteItemMutation: deleteItemMutation as Parameters<typeof useUICommands>[0]["deleteItemMutation"],
    createEdgeFn,
    deleteEdgeFn,
    onCommandExecuted: handleCommandExecuted,
  });

  // Connect UI command execution to collaboration WebSocket
  React.useEffect(() => {
    executeUICommandRef.current = executeCommand;
  }, [executeCommand]);

  // Add block handler
  const handleAddBlock = (tool: BlockTool) => {
    setConnectorMode(false);
    if (tool.type === "link") {
      setIsAddLinkOpen(true);
      return;
    }

    const defaultContent = tool.type === "todo" ? "[]" : "";
    // workspaceCwd is a file-tree-relative path like "/test" or "/src/lib".
    // The PTY starts in the workspace root (~), so use a relative cd.
    const relCwd = workspaceCwd !== "/" ? workspaceCwd.replace(/^\//, "") : "";
    let content = defaultContent;
    if (tool.type === "terminal") {
      const originalBoot = tool.terminalPreset?.command ?? "";
      // Encode cwd directly into bootCommand since the backend only reads bootCommand.
      // Sandbox detects shell metacharacters (&&, $) and runs via bash -c automatically.
      let bootCommand = originalBoot;
      if (relCwd) {
        bootCommand = originalBoot
          ? `cd "$HOME/${relCwd}" && ${originalBoot}`
          : `cd "$HOME/${relCwd}" && exec bash`;
      }
      content = JSON.stringify({
        name: tool.label,
        subagentIds: [],
        skillIds: [],
        agentic: tool.terminalPreset?.agentic ?? false,
        bootCommand,
      });
    }

    const size = defaultSizes[tool.type] || { width: 200, height: 120 };
    const position = computePlacement(size);
    createItemMutation.mutate({
      type: tool.type,
      content,
      position,
      size,
    });
    ensureVisible(position, size);
  };

  const handleCreateBrowserBlock = React.useCallback(
    (url: string, anchor?: { x: number; y: number }, sourceId?: string) => {
      if (!url) return;
      const size = defaultSizes.browser;
      const position = anchor
        ? { x: Math.round(anchor.x), y: Math.round(anchor.y) }
        : computePlacement(size);
      createItemMutation.mutate({
        type: "browser",
        content: url,
        position,
        size,
        sourceId,
        sourceHandle: "right-out",
        targetHandle: "left-in",
      });
      ensureVisible(position, size);
    },
    [createItemMutation, computePlacement, ensureVisible]
  );

  const handleDuplicate = React.useCallback(
    (itemId: string) => {
      const item = items.find((i) => i.id === itemId);
      if (!item) return;
      const size = { ...item.size };
      const position = computePlacement(size);
      createItemMutation.mutate({
        type: item.type,
        content: item.content,
        position,
        size,
        metadata: item.metadata ? { ...item.metadata, minimized: false } : undefined,
      });
      ensureVisible(position, size);
    },
    [items, createItemMutation, computePlacement, ensureVisible]
  );

  const handleBrowserOpen = React.useCallback(
    (url: string) => {
      if (!url) return;
      const existing = items.find((item) => item.type === "browser");
      if (existing) {
        updateItemMutation.mutate({
          itemId: existing.id,
          changes: { content: url },
        });
        return;
      }
      pendingBrowserUrlRef.current = url;
      void queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    },
    [items, updateItemMutation, queryClient, dashboardId]
  );

  React.useEffect(() => {
    browserOpenHandlerRef.current = handleBrowserOpen;
  }, [handleBrowserOpen]);

  React.useEffect(() => {
    if (!pendingBrowserUrlRef.current) return;
    const existing = items.find((item) => item.type === "browser");
    if (!existing) return;
    const pendingUrl = pendingBrowserUrlRef.current;
    pendingBrowserUrlRef.current = null;
    updateItemMutation.mutate({
      itemId: existing.id,
      changes: { content: pendingUrl },
    });
  }, [items, updateItemMutation]);

  const hasEdgeBetween = React.useCallback(
    (
      sourceId: string,
      targetId: string,
      sourceHandle?: string,
      targetHandle?: string
    ) =>
      edges.some(
        (edge) =>
          edge.source === sourceId &&
          edge.target === targetId &&
          edge.sourceHandle === sourceHandle &&
          edge.targetHandle === targetHandle
      ),
    [edges]
  );

  // Add link handler
  const handleAddLink = (e: React.FormEvent) => {
    e.preventDefault();
    if (newLinkUrl.trim()) {
      setConnectorMode(false);
      const size = defaultSizes.link;
      const position = computePlacement(size);
      createItemMutation.mutate({
        type: "link",
        content: newLinkUrl.trim(),
        position,
        size,
      });
      ensureVisible(position, size);
      setNewLinkUrl("");
      setIsAddLinkOpen(false);
    }
  };

  // Terminal cwd change handler - updates live indicator positions in sidebar
  const handleTerminalCwdChange = React.useCallback((itemId: string, cwd: string) => {
    setTerminalCwds((prev) => {
      if (prev[itemId] === cwd) return prev;
      return { ...prev, [itemId]: cwd };
    });
  }, []);

  // Item change handler - debounced to prevent excessive API calls
  const handleItemChange = React.useCallback((itemId: string, changes: Partial<DashboardItem>) => {
    // Track this item as having a pending local update
    pendingItemIdsRef.current.add(itemId);

    // Optimistically update the React Query cache so items reflects the change immediately
    // This prevents the "bounce back" where nodes are rebuilt from stale items
    queryClient.setQueryData(
      ["dashboard", dashboardId],
      (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          items: oldData.items.map((item) =>
            item.id === itemId ? { ...item, ...changes } : item
          ),
        };
      }
    );

    // Merge with any pending changes for this item
    const existing = pendingUpdatesRef.current.get(itemId) || {};
    pendingUpdatesRef.current.set(itemId, { ...existing, ...changes });

    // Broadcast change via WebSocket for real-time collaboration
    collabActions.updateItem(itemId, changes);

    // Flush to REST API after debounce for persistence
    flushPendingUpdates();
  }, [flushPendingUpdates, collabActions, queryClient, dashboardId]);

  const handleConnectorClick = React.useCallback(
    (nodeId: string, handleId: string, kind: "source" | "target") => {
      if (role === "viewer") return;

      // Auto-activate connect mode when clicking a connector outside of connect mode
      if (!connectorMode) {
        setConnectorMode(true);
      }

      setPendingConnection((current) => {
        if (!current) {
          if (cursorRef.current) {
            setConnectionCursor(cursorRef.current);
          }
          return { nodeId, handleId, kind };
        }

        const isBidirectionalHandle = (id: string) =>
          id.startsWith("top-") || id.startsWith("bottom-");
        const flipHandleKind = (id: string) =>
          id.endsWith("-in") ? id.replace("-in", "-out") : id.replace("-out", "-in");

        if (current.nodeId === nodeId && current.handleId === handleId) {
          return null;
        }

        let nextClick = { nodeId, handleId, kind };
        if (current.kind === kind) {
          if (isBidirectionalHandle(current.handleId) && isBidirectionalHandle(handleId)) {
            nextClick = {
              nodeId,
              handleId: flipHandleKind(handleId),
              kind: kind === "source" ? "target" : "source",
            };
          } else {
            toast.error("Select an opposite connector to complete the link.");
            return current;
          }
        }

        const source = current.kind === "source"
          ? current
          : nextClick;
        const target = current.kind === "target"
          ? current
          : nextClick;

        if (source.nodeId === target.nodeId) {
          toast.error("Connect to a different block.");
          return null;
        }

        const edgeId = `edge-${source.nodeId}-${target.nodeId}-${source.handleId}-${target.handleId}`;
        setEdges((prev) => {
          if (prev.some((edge) => edge.id === edgeId)) return prev;
          return [
            ...prev,
            {
              id: edgeId,
              source: source.nodeId,
              target: target.nodeId,
              sourceHandle: source.handleId,
              targetHandle: target.handleId,
              type: "smoothstep",
              animated: true,
              style: { stroke: "var(--accent-primary)", strokeWidth: 2 },
            },
          ];
        });

        createEdgeMutation.mutate({
          sourceItemId: source.nodeId,
          targetItemId: target.nodeId,
          sourceHandle: source.handleId,
          targetHandle: target.handleId,
        });

        return null;
      });
    },
    [connectorMode, role, setEdges, createEdgeMutation, setConnectorMode]
  );

  const handleCursorMove = React.useCallback(
    (point: { x: number; y: number }) => {
      cursorRef.current = point;
      if (pendingConnection) {
        setConnectionCursor(point);
      }
    },
    [pendingConnection]
  );

  // Listen for item changes from other users via WebSocket
  React.useEffect(() => {
    // Find items that actually changed (new or updated) by comparing with previous state
    const prevItems = prevCollabItemsRef.current;
    const currentItems = collabState.items;
    const currentItemIds = new Set(currentItems.map((item) => item.id));
    const removedItemIds = prevItems
      .filter((item) => !currentItemIds.has(item.id))
      .map((item) => item.id);

    const changedItemIds = new Set<string>();
    for (const item of currentItems) {
      const prevItem = prevItems.find((p) => p.id === item.id);
      // Item is "changed" if it's new or has a different reference (was updated)
      if (!prevItem || prevItem !== item) {
        changedItemIds.add(item.id);
      }
    }

    // Update ref for next comparison
    prevCollabItemsRef.current = currentItems;

    const prevEdges = prevCollabEdgesRef.current;
    const currentEdges = collabState.edges;
    const prevEdgeIds = new Set(prevEdges.map((edge) => edge.id));
    const currentEdgeIds = new Set(currentEdges.map((edge) => edge.id));
    const addedEdges = currentEdges.filter((edge) => !prevEdgeIds.has(edge.id));
    const removedEdges = prevEdges.filter((edge) => !currentEdgeIds.has(edge.id));
    prevCollabEdgesRef.current = currentEdges;

    if (addedEdges.length > 0 || removedEdges.length > 0) {
      setEdges((prev) => {
        const next = prev.filter((edge) => !removedEdges.some((removed) => removed.id === edge.id));
        addedEdges.forEach((edge) => {
          if (!next.some((existing) => existing.id === edge.id)) {
            next.push(toFlowEdge(edge));
          }
        });
        return next;
      });
    }

    if (removedItemIds.length > 0) {
      setEdges((prev) =>
        prev.filter(
          (edge) =>
            !removedItemIds.includes(edge.source) &&
            !removedItemIds.includes(edge.target)
        )
      );
      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            items: oldData.items.filter((item) => !removedItemIds.includes(item.id)),
            sessions: oldData.sessions.filter((session) => !removedItemIds.includes(session.itemId)),
            edges: oldData.edges.filter(
              (edge) =>
                !removedItemIds.includes(edge.sourceItemId) &&
                !removedItemIds.includes(edge.targetItemId)
            ),
          };
        }
      );
    }

    // Check if sessions actually changed (not just exist)
    const prevSessions = prevCollabSessionsRef.current;
    const currentSessions = collabState.sessions;
    const sessionsChanged = currentSessions.length !== prevSessions.length ||
      currentSessions.some((s, i) => {
        const prev = prevSessions[i];
        return !prev || prev.id !== s.id || prev.status !== s.status;
      });
    prevCollabSessionsRef.current = currentSessions;

    // Only invalidate if changed items are from remote users (not in our pending set or recently created)
    // AND only when connected - don't trigger refetches during reconnection
    // AND only when no mutations are in flight (WebSocket broadcast can arrive before mutation completes)
    const isConnected = collabState.connectionState === "connected";
    const canInvalidate = isConnected && mutationsInFlightRef.current === 0;

    if (changedItemIds.size > 0 && canInvalidate) {
      const hasRemoteChanges = Array.from(changedItemIds).some(
        (id) =>
          !pendingItemIdsRef.current.has(id) &&
          !recentlyCreatedItemsRef.current.has(id) &&
          !recentlyDeletedItemsRef.current.has(id)
      );
      if (hasRemoteChanges) {
        queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
      }
    }

    // Session updates - only invalidate when sessions actually change
    // AND only when no mutations are in flight
    // Skip if we have recently created items (session creation follows item creation)
    if (sessionsChanged && canInvalidate) {
      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; edges: DashboardEdge[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            sessions: currentSessions,
          };
        }
      );
      if (recentlyCreatedItemsRef.current.size === 0) {
        queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
      }
    }
  }, [collabState.items, collabState.sessions, collabState.edges, collabState.connectionState, queryClient, dashboardId, setEdges]);

  // Item delete handler
  const handleItemDelete = async (itemId: string) => {
    // Remove from pending update tracking (no longer needed since item is being deleted)
    pendingUpdatesRef.current.delete(itemId);
    // Note: do NOT remove from pendingItemIdsRef here — the delete mutation's
    // recentlyDeletedItemsRef handles preventing stale refetches

    // Check if this is an integration block - if so, detach from any connected terminals
    const data = queryClient.getQueryData<{
      dashboard: Dashboard;
      items: DashboardItem[];
      sessions: Session[];
      edges: DashboardEdge[];
      role: string;
    }>(["dashboard", dashboardId]);

    if (data) {
      const itemToDelete = data.items.find((i) => i.id === itemId);
      if (itemToDelete && isIntegrationBlockType(itemToDelete.type)) {
        const provider = getProviderForBlockType(itemToDelete.type);
        if (provider) {
          // Find all edges connecting this integration to terminals
          const connectedEdges = data.edges.filter(
            (e) => e.sourceItemId === itemId || e.targetItemId === itemId
          );

          // Await all detach operations before deleting the block
          const detachPromises: Promise<void>[] = [];
          for (const edge of connectedEdges) {
            const otherItemId = edge.sourceItemId === itemId ? edge.targetItemId : edge.sourceItemId;
            const otherItem = data.items.find((i) => i.id === otherItemId);

            if (otherItem?.type === "terminal") {
              // Find the terminal's session
              const session = data.sessions.find(
                (s) => s.itemId === otherItem.id && s.status === "active"
              );
              if (session?.ptyId) {
                detachPromises.push(
                  detachIntegration(dashboardId, session.ptyId, provider)
                    .then(() => {
                      queryClient.invalidateQueries({
                        queryKey: ["terminal-integrations", dashboardId, session.ptyId],
                      });
                      queryClient.invalidateQueries({
                        queryKey: ["available-integrations", dashboardId, session.ptyId],
                      });
                    })
                    .catch((err) => {
                      console.warn(`Failed to auto-detach ${provider}:`, err);
                    })
                );
              }
            }
          }

          // Wait for all detach operations to complete
          await Promise.all(detachPromises);
        }
      }
    }

    deleteItemMutation.mutate(itemId);
  };

  // Redirect if not authenticated
  React.useEffect(() => {
    if (!isAuthResolved) {
      return;
    }
    if (!isAuthenticated) {
      router.push("/login");
    }
  }, [isAuthenticated, isAuthResolved, router]);

  // Workspace sidebar replaces the old canvas workspace block.
  // Auto-creation and auto-edge effects removed in workspace-sidebar-v1.

  React.useEffect(() => {
    if (!connectorMode) {
      setPendingConnection(null);
      setConnectionCursor(null);
    }
  }, [connectorMode]);

  React.useEffect(() => {
    if (!edgesFromDataFlow.length) return;
    setEdges((prev) => {
      const existingIds = new Set(prev.map((edge) => edge.id));
      let changed = false;
      const next = [...prev];
      edgesFromDataFlow.forEach((edge) => {
        if (!existingIds.has(edge.id)) {
          next.push(edge);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [edgesFromDataFlow, setEdges]);

  React.useEffect(() => {
    if (!pendingConnection) {
      setConnectionCursor(null);
    }
  }, [pendingConnection]);

  const pendingEdge = React.useMemo(() => {
    if (!pendingConnection || !connectionCursor) return null;
    const cursorId = "__connector-cursor__";
    const sourceItem = items.find((item) => item.id === pendingConnection.nodeId);
    const sourcePosition = sourceItem?.position ?? { x: 0, y: 0 };
    const sourceSize = sourceItem?.size ?? { width: 0, height: 0 };
    const sourceCenter = {
      x: sourcePosition.x + sourceSize.width / 2,
      y: sourcePosition.y + sourceSize.height / 2,
    };
    const dx = connectionCursor.x - sourceCenter.x;
    const dy = connectionCursor.y - sourceCenter.y;
    const axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    const cursorSide = axis === "x"
      ? (dx >= 0 ? "left" : "right")
      : (dy >= 0 ? "top" : "bottom");
    const cursorTargetHandle = `cursor-target-${cursorSide}`;
    const cursorSourceHandle = `cursor-source-${cursorSide}`;
    const base = {
      id: `edge-${pendingConnection.nodeId}-${cursorId}-${pendingConnection.handleId}`,
      type: "step" as const,
      animated: true,
      style: {
        stroke: "var(--accent-primary)",
        strokeWidth: 2,
        strokeDasharray: "4 4",
      },
    };

    if (pendingConnection.kind === "source") {
      return {
        ...base,
        source: pendingConnection.nodeId,
        sourceHandle: pendingConnection.handleId,
        target: cursorId,
        targetHandle: cursorTargetHandle,
      };
    }

    return {
      ...base,
      source: cursorId,
      sourceHandle: cursorSourceHandle,
      target: pendingConnection.nodeId,
      targetHandle: pendingConnection.handleId,
    };
  }, [pendingConnection, connectionCursor, items]);

  const cursorNode = React.useMemo(() => {
    if (!pendingConnection || !connectionCursor) return null;
    return {
      id: "__connector-cursor__",
      type: "cursor",
      position: connectionCursor,
      data: {},
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      style: {
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: "none",
      },
    } as const;
  }, [pendingConnection, connectionCursor]);

  const edgesToRender = pendingEdge ? [...edges, pendingEdge] : edges;
  const extraNodes = cursorNode ? [cursorNode] : [];

  if (!isAuthResolved || !isAuthenticated) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="h-screen flex flex-col bg-[var(--background)]">
        {/* Header skeleton */}
        <div className="h-12 border-b border-[var(--border)] bg-[var(--background-elevated)] flex items-center px-4 gap-4">
          <Skeleton className="w-8 h-8" />
          <Skeleton className="w-32 h-5" />
          <div className="flex-1" />
          <Skeleton className="w-24 h-8" />
        </div>
        {/* Canvas skeleton */}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-[var(--foreground-muted)]">Loading dashboard...</div>
        </div>
      </div>
    );
  }

  // Only show error state if we have no data at all
  // If we have cached data, continue showing it even during errors/reconnection
  if (!data) {
    // Check if we're just reconnecting (have an error but might recover)
    const isReconnecting = collabState.connectionState === "reconnecting" ||
                           collabState.connectionState === "disconnected";

    return (
      <div className="h-screen flex flex-col bg-[var(--background)]">
        <div className="h-12 border-b border-[var(--border)] bg-[var(--background-elevated)] flex items-center px-4 gap-4">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => router.push("/dashboards")}
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <p className="text-[var(--status-error)]">
            {isReconnecting ? "Connection lost. Reconnecting..." : "Failed to load dashboard"}
          </p>
          {!isReconnecting && (
            <Button
              variant="secondary"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] })}
            >
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Connection status indicator
  const isCollaborationConnected = collabState.connectionState === "connected";
  const isReconnecting = collabState.connectionState === "reconnecting" ||
                         collabState.connectionState === "disconnected";

  return (
    <div className="h-screen flex flex-col bg-[var(--background)]">
      {/* Reconnection banner - shows when disconnected but we have cached data */}
      {isReconnecting && (
        <div className="bg-[var(--status-warning)] text-[var(--background)] px-4 py-2 text-center text-sm font-medium flex items-center justify-center gap-2">
          <div className="w-2 h-2 rounded-full bg-current animate-pulse" />
          Connection lost. Reconnecting...
        </div>
      )}
      {/* Header */}
      <header className="h-12 border-b border-[var(--border)] bg-[var(--background-elevated)] px-4 relative z-30 pointer-events-none">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center h-full pointer-events-auto">
          <div className="flex items-center gap-2">
            <Tooltip content="Back to dashboards" side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => router.push("/dashboards")}
              >
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Tooltip>
            <img
              src="/orca.png"
              alt="Orcabot"
              className="w-6 h-6 object-contain"
            />
            <span className="text-sm font-medium text-[var(--foreground)]">
              OrcaBot
            </span>
          </div>

          <div className="flex items-center gap-2 justify-center min-w-0">
            <h1 className="text-sm font-medium text-[var(--foreground)] truncate max-w-[40vw] text-center">
              {dashboard?.name}
            </h1>
            {role !== "owner" && (
              <span className="text-xs text-[var(--foreground-subtle)] px-2 py-0.5 bg-[var(--background)] rounded">
                {role}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 justify-end">
            {/* Presence indicators */}
            <div className="flex items-center gap-2">
              <Tooltip
                content={
                  isCollaborationConnected
                    ? `${presenceUsers.length} online`
                    : "Connecting..."
                }
              >
                <div className="flex items-center gap-1.5 px-2 py-1 bg-[var(--background)] rounded">
                  <Users className="w-3.5 h-3.5 text-[var(--foreground-subtle)]" />
                  <span className="text-xs text-[var(--foreground-muted)]">
                    {presenceUsers.length}
                  </span>
                  {/* Connection status dot */}
                  <div
                    className={`w-2 h-2 rounded-full ${
                      isCollaborationConnected
                        ? "bg-[var(--status-success)]"
                        : "bg-[var(--status-warning)] animate-pulse"
                    }`}
                  />
                </div>
              </Tooltip>
              <PresenceList users={presenceUsers} maxVisible={4} size="sm" />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <Tooltip content="Share">
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm">
                      <Share2 className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Share</DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => setIsShareDialogOpen(true)}>
                    <Users className="w-4 h-4 mr-2" />
                    Share Dashboard
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setIsExportDialogOpen(true)}>
                    <Upload className="w-4 h-4 mr-2" />
                    Export as Template
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled>
                    <Link className="w-4 h-4 mr-2" />
                    Copy Link (coming soon)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Tooltip content="Toggle theme">
                <ThemeToggle />
              </Tooltip>
              {/* TODO: Settings button hidden until settings panel is implemented */}
              {/* <Tooltip content="Settings">
                <Button variant="ghost" size="icon-sm">
                  <Settings className="w-4 h-4" />
                </Button>
              </Tooltip> */}
              <Tooltip content="Report a bug">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setIsBugReportOpen(true)}
                >
                  <Bug className="w-4 h-4" />
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>
      </header>

      {/* Main content area */}
      <div className="flex-1 flex relative overflow-hidden">
        {/* Workspace sidebar */}
        <WorkspaceSidebar
          dashboardId={dashboardId}
          sessionId={workspaceSessionId}
          items={items}
          sessions={sessions}
          onStorageLinked={(provider) => handleStorageLinked(provider)}
          onSelectedPathChange={setWorkspaceCwd}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((prev) => !prev)}
          drivePortalTarget={drivePortalEl}
          terminalCwds={terminalCwds}
        />
        {/* Canvas with cursor tracking */}
        <main
          ref={canvasContainerRef}
          className="flex-1 relative isolate"
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
        >
          <div className="absolute left-[10px] top-2 z-20 pointer-events-none">
            <div className="flex items-center gap-2 pointer-events-auto">
              {/* Storage / drive buttons */}
              <div className="flex items-center border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1">
                <div ref={setDrivePortalEl} className="flex items-center gap-1" />
              </div>

              {/* Agents section */}
              <div className="flex items-center border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1">
                <Tooltip content={toolbarAgentsCollapsed ? "Expand agents" : "Collapse agents"} side="bottom">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setToolbarAgentsCollapsed((prev) => !prev)}
                    className="mr-1"
                  >
                    {toolbarAgentsCollapsed ? <Maximize2 className="w-3 h-3" /> : <Minimize2 className="w-3 h-3" />}
                  </Button>
                </Tooltip>
                {!toolbarAgentsCollapsed && terminalTools.map((tool) => (
                  <Tooltip key={`${tool.type}-${tool.label}`} content={tool.label} side="bottom">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleAddBlock(tool)}
                      disabled={createItemMutation.isPending}
                    >
                      {tool.icon}
                    </Button>
                  </Tooltip>
                ))}
              </div>

              {/* Blocks section */}
              <div className="flex items-center border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1">
                <Tooltip content={toolbarBlocksCollapsed ? "Expand blocks" : "Collapse blocks"} side="bottom">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setToolbarBlocksCollapsed((prev) => !prev)}
                    className="mr-1"
                  >
                    {toolbarBlocksCollapsed ? <Maximize2 className="w-3 h-3" /> : <Minimize2 className="w-3 h-3" />}
                  </Button>
                </Tooltip>
                {!toolbarBlocksCollapsed && blockTools.map((tool) => (
                  <Tooltip key={`${tool.type}-${tool.label}`} content={tool.label} side="bottom">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleAddBlock(tool)}
                      disabled={createItemMutation.isPending}
                    >
                      {tool.icon}
                    </Button>
                  </Tooltip>
                ))}
              </div>

              {/* Google integrations section */}
              <div className="flex items-center border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1">
                <Tooltip content={toolbarGoogleCollapsed ? "Expand Google" : "Collapse Google"} side="bottom">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setToolbarGoogleCollapsed((prev) => !prev)}
                    className="mr-1"
                  >
                    {toolbarGoogleCollapsed ? <Maximize2 className="w-3 h-3" /> : <Minimize2 className="w-3 h-3" />}
                  </Button>
                </Tooltip>
                {!toolbarGoogleCollapsed && googleTools.map((tool) => (
                  <Tooltip key={`${tool.type}-${tool.label}`} content={tool.label} side="bottom">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleAddBlock(tool)}
                      disabled={createItemMutation.isPending}
                    >
                      {tool.icon}
                    </Button>
                  </Tooltip>
                ))}
              </div>

              {/* Connect mode */}
              <div className="flex items-center border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1">
                <Tooltip
                  content={connectorMode ? "Exit connect mode" : "Connect blocks"}
                  side="bottom"
                >
                  <Button
                    variant={connectorMode ? "secondary" : "ghost"}
                    size="icon-sm"
                    onClick={() => setConnectorMode((prev) => !prev)}
                    disabled={role === "viewer"}
                    className="relative"
                  >
                    <GitMerge className="w-4 h-4" />
                    {connectorMode && hasPendingConnection && (
                      <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-[var(--accent-primary)]" />
                    )}
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>
          {/* Dev-only sandbox metrics display */}
          {process.env.NODE_ENV === "development" && (
            <div className="absolute right-4 top-2 z-20 pointer-events-none">
              <div className="flex items-center gap-1 w-fit border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-1 py-1 pointer-events-auto">
                {/* Hide/show toggle button */}
                <Tooltip content={metricsHidden ? "Show metrics" : "Hide metrics"} side="bottom">
                  <button
                    onClick={() => setMetricsHidden(!metricsHidden)}
                    className="flex items-center justify-center w-6 h-6 rounded hover:bg-[var(--background-surface)] transition-colors"
                  >
                    {metricsHidden ? (
                      <Activity className="w-3.5 h-3.5 text-[var(--foreground-muted)]" />
                    ) : (
                      <X className="w-3.5 h-3.5 text-[var(--foreground-muted)]" />
                    )}
                  </button>
                </Tooltip>
                {/* Metrics content - conditionally shown */}
                {!metricsHidden && (
                  <Tooltip
                    content={
                      typeof metricsQuery.data?.systemMemTotalMB === "number" ? (
                        <div className="text-xs">
                          <div className="mb-2">
                            CPU {metricsQuery.data.systemCpuPct.toFixed(1)}% · Mem {metricsQuery.data.systemMemUsedMB.toFixed(0)}MB / {metricsQuery.data.systemMemTotalMB.toFixed(0)}MB ({metricsQuery.data.systemMemPct.toFixed(1)}%)
                            {metricsQuery.data.revision && (
                              <span className="block text-[9px] text-[var(--foreground-muted)] mt-1">rev: {metricsQuery.data.revision}</span>
                            )}
                          </div>
                          {metricsQuery.data.topProcesses?.length > 0 && (
                            <div className="border-t border-[var(--border)] pt-2 mt-1">
                              <div className="font-medium mb-1">Top Processes</div>
                              <table className="text-[10px] w-full">
                                <thead>
                                  <tr className="text-[var(--foreground-muted)]">
                                    <th className="text-left pr-2">Name</th>
                                    <th className="text-right pr-2">CPU</th>
                                    <th className="text-right pr-2">Mem</th>
                                    <th className="text-right">Total</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {metricsQuery.data.topProcesses.map((proc) => (
                                    <tr key={proc.pid}>
                                      <td className="pr-2 truncate max-w-[100px]" title={proc.name}>{proc.name}</td>
                                      <td className="text-right pr-2">{proc.cpuPct.toFixed(1)}%</td>
                                      <td className="text-right pr-2">{proc.memPct.toFixed(1)}%</td>
                                      <td className="text-right font-medium">{proc.combined.toFixed(1)}%</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      ) : (
                        "Sandbox metrics unavailable"
                      )
                    }
                    side="bottom"
                  >
                    <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1">
                      <Activity className="w-3.5 h-3.5 text-[var(--foreground-muted)]" />
                      <div className="flex items-center gap-2 text-[10px] text-[var(--foreground-muted)]">
                        {typeof metricsQuery.data?.systemMemTotalMB === "number" ? (
                          <>
                            <span>CPU {metricsQuery.data.systemCpuPct.toFixed(1)}%</span>
                            <span>Mem {metricsQuery.data.systemMemPct.toFixed(1)}%</span>
                            {metricsQuery.data.topProcesses?.[0] && (
                              <span className="text-[var(--foreground-muted)] border-l border-[var(--border)] pl-2">
                                Top: {metricsQuery.data.topProcesses[0].name} ({metricsQuery.data.topProcesses[0].combined.toFixed(1)}%)
                              </span>
                            )}
                          </>
                        ) : (
                          <span>Metrics…</span>
                        )}
                      </div>
                    </div>
                  </Tooltip>
                )}
              </div>
            </div>
          )}
          {/* Bug report button moved to title bar */}
          <ConnectionDataFlowProvider edges={edgesToRender}>
            <Canvas
              items={items}
              sessions={sessions}
              onItemChange={handleItemChange}
              onItemDelete={handleItemDelete}
              edges={edgesToRender}
              onEdgesChange={onEdgesChange}
              onCreateBrowserBlock={role === "viewer" ? undefined : handleCreateBrowserBlock}
              onViewportChange={(next) => {
                viewportRef.current = next;
              }}
              onCursorMove={connectorMode || pendingConnection ? handleCursorMove : undefined}
              onCanvasClick={() => {
                if (connectorMode) setConnectorMode(false);
              }}
              onConnectorClick={role === "viewer" ? undefined : handleConnectorClick}
              connectorMode={connectorMode}
              fitViewEnabled={false}
              extraNodes={extraNodes}
              readOnly={role === "viewer"}
              onPolicyUpdate={handlePolicyUpdate}
              onIntegrationAttached={handleIntegrationAttached}
              onIntegrationDetached={handleIntegrationDetached}
              onStorageLinked={handleStorageLinked}
              onDuplicate={role === "viewer" ? undefined : handleDuplicate}
              onEdgeLabelClick={role === "viewer" ? undefined : handleEdgeLabelClick}
              onTerminalCwdChange={handleTerminalCwdChange}
              reactFlowRef={reactFlowInstanceRef}
            />
          </ConnectionDataFlowProvider>
          {/* Remote cursors overlay */}
          <CursorOverlay users={presenceUsers} />
        </main>
      </div>

      {/* Add Link Dialog */}
      <Dialog open={isAddLinkOpen} onOpenChange={setIsAddLinkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Link</DialogTitle>
            <DialogDescription>
              Enter a URL to create a link block.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddLink}>
            <div className="py-4">
              <Input
                type="url"
                placeholder="https://example.com"
                value={newLinkUrl}
                onChange={(e) => setNewLinkUrl(e.target.value)}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setIsAddLinkOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                isLoading={createItemMutation.isPending}
                disabled={!newLinkUrl.trim()}
              >
                Add Link
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Export Template Dialog */}
      <ExportTemplateDialog
        open={isExportDialogOpen}
        onOpenChange={setIsExportDialogOpen}
        dashboardId={dashboardId}
        dashboardName={dashboard?.name || ""}
      />

      {/* Share Dashboard Dialog */}
      <ShareDashboardDialog
        open={isShareDialogOpen}
        onOpenChange={setIsShareDialogOpen}
        dashboardId={dashboardId}
        dashboardName={dashboard?.name || ""}
        currentUserRole={role}
      />

      {/* Bug Report Dialog */}
      <BugReportDialog
        open={isBugReportOpen}
        onOpenChange={setIsBugReportOpen}
        dashboardId={dashboardId}
        dashboardName={dashboard?.name || ""}
      />

      {/* Edge Policy Editor Dialog (opened by clicking edge labels) */}
      {edgePolicyEditor && (
        <PolicyEditorDialog
          integration={edgePolicyEditor.integration}
          dashboardId={dashboardId}
          terminalId={edgePolicyEditor.ptyId}
          onClose={() => setEdgePolicyEditor(null)}
          onSuccess={() => {
            queryClient.invalidateQueries({
              queryKey: ["terminal-integrations", dashboardId, edgePolicyEditor.ptyId],
            });
            setEdgePolicyEditor(null);
          }}
          onPolicyUpdate={(provider, securityLevel) => {
            // Use terminalItemId (dashboard item ID) for edge matching
            handlePolicyUpdate(edgePolicyEditor.terminalItemId, provider, securityLevel);
          }}
        />
      )}
    </div>
  );
}
