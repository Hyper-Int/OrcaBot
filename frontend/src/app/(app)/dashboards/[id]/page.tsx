// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: dashboard-v30-fix-disconnect-refresh
console.log(`[dashboard] REVISION: dashboard-v30-fix-disconnect-refresh loaded at ${new Date().toISOString()}`);


import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type Edge, useEdgesState } from "@xyflow/react";
import {
  ArrowLeft,
  StickyNote,
  CheckSquare,
  Globe,
  SquareTerminal,
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
  Undo2,
  Redo2,
} from "lucide-react";
import {
  GmailIcon,
  GoogleCalendarIcon,
  GoogleContactsIcon,
  GoogleSheetsIcon,
  GoogleFormsIcon,
  SlackIcon,
  DiscordIcon,
  TelegramIcon,
  WhatsAppIcon,
  TeamsIcon,
  MatrixIcon,
  GoogleChatIcon,
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
import { OnboardingDialog } from "@/components/dialogs/OnboardingDialog";
import { Canvas } from "@/components/canvas";
import { CursorOverlay, PresenceList } from "@/components/multiplayer";
import { useAuthStore } from "@/stores/auth-store";
import { useCollaboration, useDebouncedCallback, useUICommands, useUndoRedo, useUIGuidance } from "@/hooks";
import { UIGuidanceOverlay } from "@/components/ui/UIGuidanceOverlay";
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
  listDashboardIntegrationLabels,
  createReadOnlyPolicy,
  getProviderDisplayName,
  type IntegrationProvider,
  type SecurityLevel,
  type TerminalIntegration,
  type IntegrationLabel,
  type BrowserPolicy,
} from "@/lib/api/cloudflare/integration-policies";
import { PolicyEditorDialog } from "@/components/blocks/PolicyEditorDialog";
import { WorkspaceSidebar } from "@/components/workspace";
import { ChatPanel } from "@/components/chat";

// Optimistic updates disabled by default - set NEXT_PUBLIC_OPTIMISTIC_UPDATE=true to enable
const OPTIMISTIC_UPDATE_ENABLED = process.env.NEXT_PUBLIC_OPTIMISTIC_UPDATE === "true";

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

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
  type: "integration",
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

// Messaging integrations in their own section
const messagingTools: BlockTool[] = [
  { type: "slack", icon: <SlackIcon className="w-4 h-4" />, label: "Slack" },
  { type: "discord", icon: <DiscordIcon className="w-4 h-4" />, label: "Discord" },
  { type: "telegram", icon: <TelegramIcon className="w-4 h-4" />, label: "Telegram" },
  { type: "whatsapp", icon: <WhatsAppIcon className="w-4 h-4" />, label: "WhatsApp" },
  // Teams, Matrix, Google Chat hidden until ready
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
  // OpenClaw - temporarily hidden (not installed in sandbox image)
  // {
  //   type: "terminal",
  //   label: "OpenClaw",
  //   icon: <img src="/icons/moltbot.png" alt="" className="w-4 h-4 object-contain" />,
  //   terminalPreset: { command: "[ -f ~/.openclaw/.env ] && openclaw tui || openclaw onboard", agentic: true },
  // },
  {
    type: "terminal",
    label: "Terminal",
    icon: <SquareTerminal className="w-4 h-4" />,
  },
];

const defaultSizes: Record<string, { width: number; height: number }> = {
  note: { width: 200, height: 120 },
  todo: { width: 280, height: 160 },
  prompt: { width: 280, height: 160 },
  schedule: { width: 280, height: 220 },
  link: { width: 260, height: 140 },
  terminal: { width: 480, height: 500 },
  browser: { width: 680, height: 480 },
  workspace: { width: 620, height: 130 },
  recipe: { width: 320, height: 200 },
  gmail: { width: 280, height: 280 },
  calendar: { width: 280, height: 280 },
  contacts: { width: 280, height: 280 },
  sheets: { width: 300, height: 260 },
  forms: { width: 280, height: 280 },
  slack: { width: 280, height: 280 },
  discord: { width: 280, height: 280 },
  telegram: { width: 280, height: 280 },
  whatsapp: { width: 280, height: 320 },
  teams: { width: 280, height: 280 },
  matrix: { width: 280, height: 280 },
  google_chat: { width: 280, height: 280 },
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
  const [toolbarMessagingCollapsed, setToolbarMessagingCollapsed] = React.useState(false);
  const [drivePortalEl, setDrivePortalEl] = React.useState<HTMLDivElement | null>(null);

  // Workspace sidebar state
  const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
  const [workspaceCwd, setWorkspaceCwd] = React.useState("/");
  const [terminalCwds, setTerminalCwds] = React.useState<Record<string, string>>({});

  // UI Guidance state for Orcabot onboarding
  const uiGuidance = useUIGuidance({
    onOpenPanel: React.useCallback((panel: string) => {
      console.log(`[dashboard] UI Guidance: open panel "${panel}"`);
      if (panel === "files" || panel === "workspace") {
        setSidebarCollapsed(false);
      }
      // Other panels can be added here (settings, integrations, etc.)
    }, []),
    onScrollTo: React.useCallback((target: string, behavior: "smooth" | "instant") => {
      console.log(`[dashboard] UI Guidance: scroll to "${target}" (${behavior})`);
      // Find the target element and scroll to it
      const element = document.querySelector(`[data-item-id="${target.replace(/^(terminal|browser|note)-/, '')}"]`);
      if (element) {
        element.scrollIntoView({ behavior, block: "center", inline: "center" });
      }
    }, []),
  });

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
      } else if (message.type === "task_create" || message.type === "task_update" || message.type === "task_delete") {
        // Invalidate ALL task queries for this dashboard (including session-scoped)
        // Use predicate to match ["dashboard-tasks", dashboardId, ...] regardless of sessionId
        queryClient.invalidateQueries({
          predicate: (query) =>
            Array.isArray(query.queryKey) &&
            query.queryKey[0] === "dashboard-tasks" &&
            query.queryKey[1] === dashboardId,
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

  const handleDragStateChange = React.useCallback((dragging: boolean) => {
    isDraggingRef.current = dragging;
  }, []);

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
  const isDraggingRef = React.useRef(false);
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

  // Fetch integration labels for edge enrichment on reload
  const { data: integrationLabels } = useQuery({
    queryKey: ["integration-labels", dashboardId],
    queryFn: () => listDashboardIntegrationLabels(dashboardId),
    enabled: isAuthenticated && isAuthResolved && !!dashboardId && edgesFromData.length > 0,
    staleTime: 30000,
  });

  // Restore template viewport if this dashboard was just created from a template.
  // Uses requestAnimationFrame retry since ReactFlow instance may not be ready
  // on the first render after data loads.
  const templateViewportApplied = React.useRef(false);
  React.useEffect(() => {
    if (templateViewportApplied.current || !data) return;
    const key = `template-viewport-${dashboardId}`;
    const raw = sessionStorage.getItem(key);
    if (!raw) {
      templateViewportApplied.current = true;
      return;
    }
    const tryApply = () => {
      if (templateViewportApplied.current) return;
      const instance = reactFlowInstanceRef.current;
      if (!instance) {
        requestAnimationFrame(tryApply);
        return;
      }
      sessionStorage.removeItem(key);
      templateViewportApplied.current = true;
      try {
        const vp = JSON.parse(raw) as { x: number; y: number; zoom: number };
        instance.setViewport(vp, { duration: 0 });
        viewportRef.current = vp;
      } catch {
        // ignore malformed viewport
      }
    };
    tryApply();
  }, [data, dashboardId]);

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

  // Build a map from (itemId, provider) → securityLevel from integration labels
  const integrationLabelMap = React.useMemo(() => {
    const map = new Map<string, IntegrationLabel>();
    if (integrationLabels) {
      for (const label of integrationLabels) {
        // Key by itemId+provider to match edges
        map.set(`${label.itemId}:${label.provider}`, label);
      }
    }
    return map;
  }, [integrationLabels]);

  // Convert edges to flow edges, using stable keys for source/target when available
  // Also enrich with provider and securityLevel for edge label display
  const edgesFromDataFlow = React.useMemo(() => edgesFromData.map(edge => {
    const flowEdge = toFlowEdge(edge);
    // Use stable keys if the source/target items have them
    const source = realIdToStableKey.get(flowEdge.source) || flowEdge.source;
    const target = realIdToStableKey.get(flowEdge.target) || flowEdge.target;

    // Derive provider from the non-terminal end of the edge
    const sourceItem = items.find(i => (i._stableKey || i.id) === source);
    const targetItem = items.find(i => (i._stableKey || i.id) === target);
    const terminalItem = sourceItem?.type === "terminal" ? sourceItem : targetItem?.type === "terminal" ? targetItem : null;
    const integrationItem = sourceItem?.type !== "terminal" ? sourceItem : targetItem?.type !== "terminal" ? targetItem : null;
    const provider = integrationItem ? getProviderForBlockType(integrationItem.type) : undefined;

    // Look up securityLevel from integration labels (fetched from backend)
    let securityLevel: SecurityLevel | undefined;
    if (terminalItem && provider) {
      const label = integrationLabelMap.get(`${terminalItem.id}:${provider}`);
      if (label?.securityLevel) {
        securityLevel = label.securityLevel;
      }
    }

    return {
      ...flowEdge,
      source,
      target,
      ...(provider ? { data: { provider, securityLevel } } : {}),
    };
  }), [edgesFromData, realIdToStableKey, items, integrationLabelMap]);
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
      console.log("[ensureVisible] called with position:", position, "size:", size);
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

        console.log("[ensureVisible] viewport:", { viewLeft, viewTop, viewRight, viewBottom, zoom });
        console.log("[ensureVisible] block bounds:", { x: position.x, y: position.y, blockRight, blockBottom });

        // Check if the block is already fully within the visible area
        if (
          position.x >= viewLeft + margin &&
          position.y >= viewTop + margin &&
          blockRight <= viewRight - margin &&
          blockBottom <= viewBottom - margin
        ) {
          console.log("[ensureVisible] block already visible, skipping pan");
          return; // already visible
        }

        console.log("[ensureVisible] block not fully visible, will pan/zoom");

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
          console.log("[ensureVisible] panning to center:", { centerX: centerX + offsetX, centerY, zoom });
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
          console.log("[ensureVisible] zooming out to:", { centerX: centerX + offsetX, centerY, zoom: clampedZoom });
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
        // Record undo entry for non-terminal, non-integration blocks
        if (!["terminal"].includes(createdItem.type) && !isIntegrationBlockType(createdItem.type)) {
          recordActionRef.current?.({
            type: "create_item",
            description: `Created ${createdItem.type} block`,
            undoData: { type: "delete_item", itemId: createdItem.id },
            redoData: {
              type: "create_item",
              item: { dashboardId, type: createdItem.type, content: createdItem.content, position: createdItem.position, size: createdItem.size, metadata: createdItem.metadata },
            },
          });
        }
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
      // Record undo entry for non-terminal, non-integration blocks
      if (!["terminal"].includes(createdItem.type) && !isIntegrationBlockType(createdItem.type)) {
        recordActionRef.current?.({
          type: "create_item",
          description: `Created ${createdItem.type} block`,
          undoData: { type: "delete_item", itemId: createdItem.id },
          redoData: {
            type: "create_item",
            item: { dashboardId, type: createdItem.type, content: createdItem.content, position: createdItem.position, size: createdItem.size, metadata: createdItem.metadata },
          },
        });
      }
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
      _tempEdgeId?: string;
    }) => {
      const { _tempEdgeId, ...payload } = edge;
      return createEdge(dashboardId, payload);
    },
    onSuccess: (createdEdge, variables) => {
      // Replace temp edge with real server edge (swap temp ID → real ID)
      if (variables._tempEdgeId) {
        setEdges((prev) =>
          prev.map((e) =>
            e.id === variables._tempEdgeId
              ? { ...e, ...toFlowEdge(createdEdge), data: e.data }
              : e
          )
        );
      }

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

      // Record undo entry for non-integration edges
      const sourceItem = items.find((i) => i.id === createdEdge.sourceItemId);
      const targetItem = items.find((i) => i.id === createdEdge.targetItemId);
      const isIntEdge =
        (sourceItem && isIntegrationBlockType(sourceItem.type)) ||
        (targetItem && isIntegrationBlockType(targetItem.type));
      if (!isIntEdge) {
        recordActionRef.current?.({
          type: "create_edge",
          description: "Created connection",
          undoData: { type: "delete_edge", edgeId: createdEdge.id },
          redoData: {
            type: "create_edge",
            edge: {
              dashboardId: createdEdge.dashboardId,
              sourceItemId: createdEdge.sourceItemId,
              targetItemId: createdEdge.targetItemId,
              sourceHandle: createdEdge.sourceHandle,
              targetHandle: createdEdge.targetHandle,
            },
          },
        });
      }
    },
    onError: (error, variables) => {
      // Remove temp edge on failure
      if (variables._tempEdgeId) {
        setEdges((prev) => prev.filter((e) => e.id !== variables._tempEdgeId));
      }
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
          toast.info("Connection saved. Integration will attach when the terminal starts.");
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
              (i) => i.provider === provider && i.connected && !i.attached && i.userIntegrationId
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
              // WhatsApp can work without OAuth (platform credentials or bridge/QR connection)
              // — try attaching without userIntegrationId
              if (provider === "whatsapp") {
                try {
                  const result = await attachIntegration(dashboardId, ptyId, {
                    provider,
                    policy: createReadOnlyPolicy(provider),
                  });
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
                  toast.success(`${getProviderDisplayName(provider)} attached to terminal`);
                  return;
                } catch (err: unknown) {
                  // 409 = already attached — edge is already styled from the first successful call, just return
                  if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 409) {
                    return;
                  }
                  console.error(`[handleIntegrationEdge] WhatsApp attach without OAuth failed:`, err);
                  // Fall through to show sign-in warning
                }
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
        queryClient.invalidateQueries({
          queryKey: ["integration-labels", dashboardId],
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

  // Auto-attach integrations when a terminal session becomes active.
  // If the user draws an integration edge before starting the terminal, the edge is saved
  // but attachment is deferred. This effect retries attachment when new sessions appear.
  const prevActiveSessionIdsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const currentActiveIds = new Set(
      sessions.filter((s) => s.status === "active" && s.ptyId).map((s) => s.itemId)
    );
    const newlyActive = [...currentActiveIds].filter((id) => !prevActiveSessionIdsRef.current.has(id));
    prevActiveSessionIdsRef.current = currentActiveIds;

    if (!newlyActive.length) return;

    // For each newly active terminal, check for integration edges without attachments
    const data = queryClient.getQueryData<{
      items: DashboardItem[];
      edges: DashboardEdge[];
    }>(["dashboard", dashboardId]);
    if (!data) return;

    for (const terminalItemId of newlyActive) {
      // Find integration edges connected to this terminal
      const integrationEdges = data.edges.filter((edge) => {
        const otherItemId =
          edge.sourceItemId === terminalItemId ? edge.targetItemId :
          edge.targetItemId === terminalItemId ? edge.sourceItemId : null;
        if (!otherItemId) return false;
        const otherItem = data.items.find((i) => i.id === otherItemId);
        return otherItem && isIntegrationBlockType(otherItem.type);
      });

      for (const edge of integrationEdges) {
        handleIntegrationEdge(
          { id: edge.id, sourceItemId: edge.sourceItemId, targetItemId: edge.targetItemId },
          "attach"
        );
      }
    }
  }, [sessions, dashboardId, queryClient, handleIntegrationEdge]);

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
          queryClient.invalidateQueries({
            queryKey: ["integration-labels", dashboardId],
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

  // Handle storage disconnected - invalidate caches so UI reflects removal
  const handleStorageDisconnected = React.useCallback(
    (provider: "google_drive" | "onedrive" | "box" | "github") => {
      console.log(`[handleStorageDisconnected] called for provider: ${provider}`);
      // Invalidate terminal-integrations and available-integrations for all active sessions
      const terminalItems = items.filter((item) => item.type === "terminal");
      for (const terminalItem of terminalItems) {
        const session = sessions.find(
          (s) => s.itemId === terminalItem.id && s.status === "active"
        );
        if (!session?.ptyId) continue;
        queryClient.invalidateQueries({
          queryKey: ["terminal-integrations", dashboardId, session.ptyId],
        });
        queryClient.invalidateQueries({
          queryKey: ["available-integrations", dashboardId, session.ptyId],
        });
      }
      queryClient.invalidateQueries({
        queryKey: ["integration-labels", dashboardId],
      });
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

      // Filter by both real ID and stable key since React Flow edges may use stable keys
      const stableKey = realIdToStableKey.get(itemId);
      const idsToRemove = new Set([itemId]);
      if (stableKey) idsToRemove.add(stableKey);
      setEdges((prev) =>
        prev.filter((edge) => !idsToRemove.has(edge.source) && !idsToRemove.has(edge.target))
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
        const stableKey = realIdToStableKey.get(itemId);
        const idsToRemove = new Set([itemId]);
        if (stableKey) idsToRemove.add(stableKey);
        setEdges((prev) =>
          prev.filter((edge) => !idsToRemove.has(edge.source) && !idsToRemove.has(edge.target))
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

  // Ref to recordAction so flushPendingUpdates can record content undo entries
  const recordActionRef = React.useRef<((entry: Omit<import("@/stores/undo-store").UndoEntry, "id" | "timestamp" | "userId">) => void) | null>(null);

  // Flush pending updates to API (debounced)
  const flushPendingUpdates = useDebouncedCallback(() => {
    // Snapshot and clear pending updates atomically
    const updates = new Map(pendingUpdatesRef.current);
    pendingUpdatesRef.current.clear();

    updates.forEach((changes, itemId) => {
      // Record undo entry for content changes when the debounce fires
      if (changes.content !== undefined && contentBeforeRef.current.has(itemId)) {
        const beforeContent = contentBeforeRef.current.get(itemId)!;
        if (beforeContent !== changes.content) {
          const item = items.find((i) => i.id === itemId);
          if (item && !["terminal"].includes(item.type) && !isIntegrationBlockType(item.type)) {
            recordActionRef.current?.({
              type: "update_item",
              description: `Edited ${item.type} content`,
              undoData: { type: "update_item", itemId, before: { content: beforeContent } },
              redoData: { type: "update_item", itemId, after: { content: changes.content as string } },
            });
          }
        }
        contentBeforeRef.current.delete(itemId);
      }

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

      // Remove from local state immediately (optimistic)
      setEdges((prev) => prev.filter((e) => e.id !== edgeId));

      // Only call server API if the edge exists in query data (has a real server ID)
      if (edgeToDelete) {
        try {
          await deleteEdge(dashboardId, edgeId);
        } catch (err) {
          console.warn("Failed to delete edge from server:", err);
        }
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
        handleIntegrationEdge(
          { id: edgeToDelete.id, sourceItemId: edgeToDelete.sourceItemId, targetItemId: edgeToDelete.targetItemId },
          "detach"
        );
      }
    },
    [dashboardId, queryClient, handleIntegrationEdge, setEdges]
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

  // Track "before" content for undo coalescing (captured on first change in debounce window)
  const contentBeforeRef = React.useRef<Map<string, string>>(new Map());

  // Item change handler - debounced to prevent excessive API calls
  const handleItemChange = React.useCallback((itemId: string, changes: Partial<DashboardItem>) => {
    // Capture "before" content for undo on first content change in this debounce window
    if (changes.content !== undefined && !contentBeforeRef.current.has(itemId)) {
      const currentItem = items.find((i) => i.id === itemId);
      if (currentItem) {
        contentBeforeRef.current.set(itemId, currentItem.content);
      }
    }

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

  // ===== Undo/Redo =====
  const { undo, redo, recordAction, canUndo, canRedo, lastAction, history, beginBatch, commitBatch, cancelBatch } = useUndoRedo({
    dashboardId,
    userId: user?.id || "",
    items,
    edges: edgesFromData,
    createItemMutation: createItemMutation as Parameters<typeof useUndoRedo>[0]["createItemMutation"],
    updateItemMutation: updateItemMutation as Parameters<typeof useUndoRedo>[0]["updateItemMutation"],
    deleteItemMutation: deleteItemMutation as Parameters<typeof useUndoRedo>[0]["deleteItemMutation"],
    createEdgeFn,
    deleteEdgeFn,
    handleItemChange,
  });

  // Keep recordActionRef in sync for flushPendingUpdates
  React.useEffect(() => {
    recordActionRef.current = recordAction;
  }, [recordAction]);

  // Drag complete handler for undo recording
  const handleDragComplete = React.useCallback(
    (itemId: string, before: { x: number; y: number }, after: { x: number; y: number }) => {
      const item = items.find((i) => i.id === itemId);
      if (item && !["terminal"].includes(item.type) && !isIntegrationBlockType(item.type)) {
        recordAction({
          type: "update_item",
          description: "Moved block",
          undoData: { type: "update_item", itemId, before: { position: before } },
          redoData: { type: "update_item", itemId, after: { position: after } },
        });
      }
    },
    [items, recordAction]
  );

  // Resize complete handler for undo recording
  const handleResizeComplete = React.useCallback(
    (
      itemId: string,
      before: { position: { x: number; y: number }; size: { width: number; height: number } },
      after: { position: { x: number; y: number }; size: { width: number; height: number } },
    ) => {
      const item = items.find((i) => i.id === itemId);
      if (item && !["terminal"].includes(item.type) && !isIntegrationBlockType(item.type)) {
        recordAction({
          type: "update_item",
          description: "Resized block",
          undoData: { type: "update_item", itemId, before: { position: before.position, size: before.size } },
          redoData: { type: "update_item", itemId, after: { position: after.position, size: after.size } },
        });
      }
    },
    [items, recordAction]
  );

  // Edge delete wrapper that records undo entries
  const deleteEdgeWithUndo = React.useCallback(
    async (edgeId: string) => {
      // Capture edge data for undo before deletion
      const edge = edgesFromData.find((e) => e.id === edgeId);
      if (edge) {
        const sourceItem = items.find((i) => i.id === edge.sourceItemId);
        const targetItem = items.find((i) => i.id === edge.targetItemId);
        const isIntEdge =
          (sourceItem && isIntegrationBlockType(sourceItem.type)) ||
          (targetItem && isIntegrationBlockType(targetItem.type));
        if (!isIntEdge) {
          recordAction({
            type: "delete_edge",
            description: "Deleted connection",
            undoData: {
              type: "create_edge",
              edge: {
                dashboardId: edge.dashboardId,
                sourceItemId: edge.sourceItemId,
                targetItemId: edge.targetItemId,
                sourceHandle: edge.sourceHandle,
                targetHandle: edge.targetHandle,
              },
            },
            redoData: { type: "delete_edge", edgeId },
          });
        }
      }
      await deleteEdgeFn(edgeId);
    },
    [edgesFromData, items, recordAction, deleteEdgeFn]
  );

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
              type: "integration",
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
          _tempEdgeId: edgeId,
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
      // Build expanded set including stable keys for removed items
      const removedIdSet = new Set(removedItemIds);
      for (const id of removedItemIds) {
        const stableKey = realIdToStableKey.get(id);
        if (stableKey) removedIdSet.add(stableKey);
      }
      setEdges((prev) =>
        prev.filter(
          (edge) =>
            !removedIdSet.has(edge.source) &&
            !removedIdSet.has(edge.target)
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
    const canInvalidate = isConnected && mutationsInFlightRef.current === 0 && !isDraggingRef.current;

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

    // Capture data BEFORE mutation modifies query cache (for undo + detach)
    const data = queryClient.getQueryData<{
      dashboard: Dashboard;
      items: DashboardItem[];
      sessions: Session[];
      edges: DashboardEdge[];
      role: string;
    }>(["dashboard", dashboardId]);

    // Record undo entry for non-terminal, non-integration blocks BEFORE deletion
    if (data) {
      const itemForUndo = data.items.find((i) => i.id === itemId);
      if (itemForUndo && !["terminal"].includes(itemForUndo.type) && !isIntegrationBlockType(itemForUndo.type)) {
        // Capture non-integration edges for restoration
        const nonIntegrationEdges = (data.edges || []).filter((e) => {
          if (e.sourceItemId !== itemId && e.targetItemId !== itemId) return false;
          const otherId = e.sourceItemId === itemId ? e.targetItemId : e.sourceItemId;
          const otherItem = data.items.find((i) => i.id === otherId);
          return otherItem && !isIntegrationBlockType(otherItem.type);
        });

        recordAction({
          type: "delete_item",
          description: `Deleted ${itemForUndo.type} block`,
          undoData: { type: "create_item", item: { ...itemForUndo }, edges: nonIntegrationEdges.map((e) => ({ ...e })) },
          redoData: { type: "delete_item", itemId },
        });
      }
    }

    // Fire mutation FIRST so edges are removed from query cache + React Flow state
    // immediately (onMutate runs synchronously), preventing the edge sync effect
    // from re-adding edges during the async detach operations below.
    deleteItemMutation.mutate(itemId);

    // Fire-and-forget: detach integrations from connected terminals
    if (data) {
      const itemToDelete = data.items.find((i) => i.id === itemId);
      if (itemToDelete && isIntegrationBlockType(itemToDelete.type)) {
        const provider = getProviderForBlockType(itemToDelete.type);
        if (provider) {
          const connectedEdges = data.edges.filter(
            (e) => e.sourceItemId === itemId || e.targetItemId === itemId
          );

          for (const edge of connectedEdges) {
            const otherItemId = edge.sourceItemId === itemId ? edge.targetItemId : edge.sourceItemId;
            const otherItem = data.items.find((i) => i.id === otherItemId);

            if (otherItem?.type === "terminal") {
              const session = data.sessions.find(
                (s) => s.itemId === otherItem.id && s.status === "active"
              );
              if (session?.ptyId) {
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
                  });
              }
            }
          }
        }
      }
    }
  };

  // Batch delete handler for multi-select delete (undo restores all at once)
  const handleItemsDelete = async (itemIds: string[]) => {
    beginBatch();
    try {
      for (const itemId of itemIds) {
        await handleItemDelete(itemId);
      }
      commitBatch(`Deleted ${itemIds.length} blocks`);
    } catch {
      cancelBatch();
    }
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
    // Build set of valid node IDs (real IDs and stable keys) for orphan detection
    const currentNodeIds = new Set(items.map(item => item._stableKey || item.id));
    // Build lookup for enriched data from dataFlow edges
    const dataFlowMap = new Map(edgesFromDataFlow.map((edge) => [edge.id, edge]));
    setEdges((prev) => {
      const existingIds = new Set(prev.map((edge) => edge.id));
      let changed = false;
      const next: typeof prev = [];

      // Keep existing edges, but remove orphaned ones and enrich with data from dataFlow
      for (const edge of prev) {
        if (!currentNodeIds.has(edge.source) || !currentNodeIds.has(edge.target)) {
          // Edge references a node that no longer exists — remove it
          changed = true;
          continue;
        }
        // Enrich existing edge with provider/securityLevel if missing
        const dataFlowEdge = dataFlowMap.get(edge.id);
        if (dataFlowEdge?.data && (!edge.data?.securityLevel || !edge.data?.provider)) {
          const enriched = {
            ...edge,
            data: { ...edge.data, ...dataFlowEdge.data },
          };
          next.push(enriched);
          changed = true;
        } else {
          next.push(edge);
        }
      }

      // Add new edges from data flow that aren't already in local state
      for (const edge of edgesFromDataFlow) {
        if (!existingIds.has(edge.id)) {
          next.push(edge);
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [edgesFromDataFlow, setEdges, items]);

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

            {/* Dev-only sandbox metrics (inline in title bar) */}
            {process.env.NODE_ENV === "development" && (
              <div className="flex items-center">
                <div className="flex items-center gap-1 border border-[var(--border)] bg-[var(--background)] rounded-lg px-1 py-0.5">
                  <Tooltip content={metricsHidden ? "Show metrics" : "Hide metrics"} side="bottom">
                    <button
                      onClick={() => setMetricsHidden(!metricsHidden)}
                      className="flex items-center justify-center w-5 h-5 rounded hover:bg-[var(--background-surface)] transition-colors"
                    >
                      {metricsHidden ? (
                        <Activity className="w-3 h-3 text-[var(--foreground-muted)]" />
                      ) : (
                        <X className="w-3 h-3 text-[var(--foreground-muted)]" />
                      )}
                    </button>
                  </Tooltip>
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
                      <div className="flex items-center gap-1.5 px-1.5 py-0.5">
                        <Activity className="w-3 h-3 text-[var(--foreground-muted)]" />
                        <div className="flex items-center gap-1.5 text-[10px] text-[var(--foreground-muted)]">
                          {typeof metricsQuery.data?.systemMemTotalMB === "number" ? (
                            <>
                              <span>CPU {metricsQuery.data.systemCpuPct.toFixed(1)}%</span>
                              <span>Mem {metricsQuery.data.systemMemPct.toFixed(1)}%</span>
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
          onStorageDisconnected={handleStorageDisconnected}
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
                      data-guidance-target={tool.label.toLowerCase().replace(/\s+/g, "-")}
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
                      data-guidance-target={tool.label.toLowerCase().replace(/\s+/g, "-")}
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

              {/* Messaging integrations section */}
              <div className="flex items-center border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1">
                <Tooltip content={toolbarMessagingCollapsed ? "Expand Messaging" : "Collapse Messaging"} side="bottom">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setToolbarMessagingCollapsed((prev) => !prev)}
                    className="mr-1"
                  >
                    {toolbarMessagingCollapsed ? <Maximize2 className="w-3 h-3" /> : <Minimize2 className="w-3 h-3" />}
                  </Button>
                </Tooltip>
                {!toolbarMessagingCollapsed && messagingTools.map((tool) => (
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

              {/* Undo/Redo */}
              {role !== "viewer" && (
                <div className="flex items-center border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1">
                  <Tooltip content="Undo (Cmd+Z)" side="bottom">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void undo()}
                      disabled={!canUndo}
                    >
                      <Undo2 className="w-4 h-4" />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Redo (Cmd+Shift+Z)" side="bottom">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void redo()}
                      disabled={!canRedo}
                    >
                      <Redo2 className="w-4 h-4" />
                    </Button>
                  </Tooltip>
                </div>
              )}
            </div>
          </div>
          {/* Action history dropdown (canvas overlay, top-right) */}
          {lastAction && (
            <div className="absolute right-4 top-2 z-20 pointer-events-none">
              <div className="pointer-events-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-1.5 border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2.5 py-1 hover:bg-[var(--background-surface)] transition-colors cursor-pointer">
                      <Clock className="w-3 h-3 text-[var(--foreground-muted)]" />
                      <span className="text-[10px] text-[var(--foreground-muted)] truncate max-w-[25vw]">
                        {lastAction.description}
                      </span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64 max-h-80 overflow-y-auto">
                    <DropdownMenuLabel className="text-xs">Recent Actions</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {history.length === 0 ? (
                      <div className="px-2 py-3 text-xs text-[var(--foreground-muted)] text-center">No actions yet</div>
                    ) : (
                      history.map((entry, idx) => (
                        <DropdownMenuItem
                          key={entry.id}
                          className="flex items-center justify-between gap-2 text-xs"
                          disabled
                        >
                          <span className="truncate">{entry.description}</span>
                          <span className="text-[10px] text-[var(--foreground-muted)] whitespace-nowrap shrink-0">
                            {formatTimeAgo(entry.timestamp)}
                          </span>
                        </DropdownMenuItem>
                      ))
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          )}
          <ConnectionDataFlowProvider edges={edgesToRender}>
            <Canvas
              items={items}
              sessions={sessions}
              onItemChange={handleItemChange}
              onItemDelete={handleItemDelete}
              onItemsDelete={role === "viewer" ? undefined : handleItemsDelete}
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
              onStorageDisconnected={handleStorageDisconnected}
              onDuplicate={role === "viewer" ? undefined : handleDuplicate}
              onEdgeLabelClick={role === "viewer" ? undefined : handleEdgeLabelClick}
              onEdgeDelete={role === "viewer" ? undefined : deleteEdgeWithUndo}
              onDragComplete={role === "viewer" ? undefined : handleDragComplete}
              onDragStateChange={handleDragStateChange}
              onResizeComplete={role === "viewer" ? undefined : handleResizeComplete}
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
        viewport={reactFlowInstanceRef.current?.getViewport()}
      />

      {/* Share Dashboard Dialog */}
      <ShareDashboardDialog
        open={isShareDialogOpen}
        onOpenChange={setIsShareDialogOpen}
        dashboardId={dashboardId}
        dashboardName={dashboard?.name || ""}
        currentUserRole={role}
      />

      {/* Onboarding Slideshow */}
      <OnboardingDialog />

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
            queryClient.invalidateQueries({
              queryKey: ["integration-labels", dashboardId],
            });
            setEdgePolicyEditor(null);
          }}
          onPolicyUpdate={(provider, securityLevel) => {
            // Use terminalItemId (dashboard item ID) for edge matching
            handlePolicyUpdate(edgePolicyEditor.terminalItemId, provider, securityLevel);
          }}
        />
      )}

      {/* Orcabot Chat Panel */}
      <ChatPanel dashboardId={dashboardId} onUICommand={uiGuidance.handleCommand} />

      {/* UI Guidance Overlay for Orcabot onboarding */}
      <UIGuidanceOverlay
        highlights={uiGuidance.highlights}
        tooltips={uiGuidance.tooltips}
        onDismissTooltip={uiGuidance.dismissTooltip}
      />
    </div>
  );
}
