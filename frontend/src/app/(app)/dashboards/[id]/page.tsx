// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

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
import { Canvas } from "@/components/canvas";
import { CursorOverlay, PresenceList } from "@/components/multiplayer";
import { useAuthStore } from "@/stores/auth-store";
import { useCollaboration, useDebouncedCallback, useUICommands } from "@/hooks";
import { getDashboard, createItem, updateItem, deleteItem, createEdge, deleteEdge, getDashboardMetrics, startDashboardBrowser, stopDashboardBrowser, sendUICommandResult } from "@/lib/api/cloudflare";
import { generateId } from "@/lib/utils";
import type { DashboardItem, Dashboard, Session, DashboardEdge } from "@/types/dashboard";
import type { PresenceUser } from "@/types/collaboration";
import { ConnectionDataFlowProvider } from "@/contexts/ConnectionDataFlowContext";

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
  {
    type: "terminal",
    label: "OpenCode",
    icon: <img src="/icons/opencode.ico" alt="" className="w-4 h-4 object-contain" />,
    terminalPreset: { command: "opencode", agentic: true },
  },
  {
    type: "terminal",
    label: "GitHub Copilot CLI",
    icon: <img src="/icons/github.png" alt="" className="w-4 h-4 object-contain" />,
    terminalPreset: { command: "copilot", agentic: true },
  },
  {
    type: "terminal",
    label: "Droid",
    icon: <img src="/icons/droid.png" alt="" className="w-4 h-4 object-contain" />,
    terminalPreset: { command: "droid", agentic: true },
  },
  {
    type: "terminal",
    label: "Moltbot",
    icon: <img src="/icons/moltbot.png" alt="" className="w-4 h-4 object-contain" />,
    terminalPreset: { command: "clawdbot tui", agentic: true },
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
  browser: { width: 680, height: 480 },
  workspace: { width: 620, height: 130 },
  recipe: { width: 320, height: 200 },
  gmail: { width: 280, height: 280 },
  calendar: { width: 280, height: 280 },
  contacts: { width: 280, height: 280 },
  sheets: { width: 300, height: 260 },
  forms: { width: 280, height: 280 },
};

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
  const [connectorMode, setConnectorMode] = React.useState(false);
  const [pendingConnection, setPendingConnection] = React.useState<PendingConnection | null>(null);
  const hasPendingConnection = Boolean(pendingConnection);
  const [connectionCursor, setConnectionCursor] = React.useState<{ x: number; y: number } | null>(null);
  const cursorRef = React.useRef<{ x: number; y: number } | null>(null);

  // Toolbar section collapse states
  const [toolbarAgentsCollapsed, setToolbarAgentsCollapsed] = React.useState(false);
  const [toolbarBlocksCollapsed, setToolbarBlocksCollapsed] = React.useState(false);
  const [toolbarGoogleCollapsed, setToolbarGoogleCollapsed] = React.useState(false);

  // Canvas container ref for cursor tracking
  const canvasContainerRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = React.useRef({ x: 0, y: 0, zoom: 1 });
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
  // Track previous collaboration items to detect what actually changed
  const prevCollabItemsRef = React.useRef<DashboardItem[]>([]);
  const prevCollabEdgesRef = React.useRef<DashboardEdge[]>([]);
  const prevCollabSessionsRef = React.useRef<Session[]>([]);
  const workspaceCreateRequestedRef = React.useRef(false);

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
  });

  const dashboard = data?.dashboard;
  const items = data?.items ?? [];
  const sessions = data?.sessions ?? [];
  const edgesFromData = data?.edges ?? [];
  const role = data?.role ?? "viewer";
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

  const [cpuPercent, setCpuPercent] = React.useState<number | null>(null);
  const cpuSampleRef = React.useRef<{ totalMs: number; ts: number } | null>(null);

  React.useEffect(() => {
    if (!metricsQuery.data) {
      return;
    }
    const totalMs = metricsQuery.data.cpuUserMs + metricsQuery.data.cpuSystemMs;
    const now = Date.now();
    const previous = cpuSampleRef.current;
    cpuSampleRef.current = { totalMs, ts: now };
    if (!previous) {
      return;
    }
    const deltaMs = totalMs - previous.totalMs;
    const deltaTime = now - previous.ts;
    if (deltaTime <= 0) {
      return;
    }
    const percent = (deltaMs / deltaTime) * 100;
    setCpuPercent(Math.max(0, Math.min(100, percent)));
  }, [metricsQuery.data?.cpuUserMs, metricsQuery.data?.cpuSystemMs]);

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
    },
    onError: (error) => {
      toast.error(`Failed to save connection: ${error.message}`);
    },
  });

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
      // Decrement mutations in-flight counter
      mutationsInFlightRef.current--;

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
      // Decrement mutations in-flight counter
      mutationsInFlightRef.current--;

      if (context?.previous) {
        queryClient.setQueryData(["dashboard", dashboardId], context.previous);
      }
      if (context?.previousEdges) {
        setEdges(context.previousEdges);
      }
      toast.error(`Failed to delete block: ${error.message}`);
    },
  });

  // Flush pending updates to API (debounced)
  const flushPendingUpdates = useDebouncedCallback(() => {
    pendingUpdatesRef.current.forEach((changes, itemId) => {
      updateItemMutation.mutate(
        { itemId, changes },
        {
          onSettled: () => {
            // Clear from pending tracking after mutation completes (success or error)
            pendingItemIdsRef.current.delete(itemId);
          },
        }
      );
    });
    pendingUpdatesRef.current.clear();
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
    },
    [dashboardId, queryClient]
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
    const terminalContent = tool.type === "terminal" && tool.terminalPreset
      ? JSON.stringify({
          name: tool.label,
          subagentIds: [],
          skillIds: [],
          agentic: tool.terminalPreset.agentic ?? false,
          bootCommand: tool.terminalPreset.command ?? "",
        })
      : defaultContent;

    createItemMutation.mutate({
      type: tool.type,
      content: tool.type === "terminal" && tool.terminalPreset ? terminalContent : defaultContent,
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
      size: defaultSizes[tool.type] || { width: 200, height: 120 },
    });
  };

  const handleCreateBrowserBlock = React.useCallback(
    (url: string, anchor?: { x: number; y: number }, sourceId?: string) => {
      if (!url) return;
      const position = anchor
        ? { x: Math.round(anchor.x), y: Math.round(anchor.y) }
        : { x: 140 + Math.random() * 200, y: 140 + Math.random() * 200 };
      createItemMutation.mutate({
        type: "browser",
        content: url,
        position,
        size: defaultSizes.browser,
        sourceId,
        sourceHandle: "right-out",
        targetHandle: "left-in",
      });
    },
    [createItemMutation]
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
      createItemMutation.mutate({
        type: "link",
        content: newLinkUrl.trim(),
        position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
        size: defaultSizes.link,
      });
      setNewLinkUrl("");
      setIsAddLinkOpen(false);
    }
  };

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
      if (role === "viewer" || !connectorMode) return;

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
    [connectorMode, role, setEdges, createEdgeMutation]
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
        (id) => !pendingItemIdsRef.current.has(id) && !recentlyCreatedItemsRef.current.has(id)
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
  const handleItemDelete = (itemId: string) => {
    // Remove from pending tracking
    pendingUpdatesRef.current.delete(itemId);
    pendingItemIdsRef.current.delete(itemId);
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

  React.useEffect(() => {
    if (!data) return;
    if (role === "viewer") return;
    const hasWorkspace = items.some((item) => item.type === "workspace");
    if (hasWorkspace) {
      workspaceCreateRequestedRef.current = false;
      return;
    }
    if (workspaceCreateRequestedRef.current) return;

    workspaceCreateRequestedRef.current = true;
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    const viewport = viewportRef.current;
    const screenX = 100;
    const screenY = rect
      ? Math.max(100, Math.round(rect.height - (defaultSizes.workspace.height * viewport.zoom) - 50))
      : 520;
    const x = Math.round((screenX - viewport.x) / viewport.zoom);
    const y = Math.round((screenY - viewport.y) / viewport.zoom);
    createItemMutation.mutate({
      type: "workspace",
      content: "",
      position: { x, y },
      size: defaultSizes.workspace,
    });
    // Note: Don't reset workspaceCreateRequestedRef on error - that would cause retry loops.
    // If creation fails, user can refresh the page to retry.
  }, [data, role, items, createItemMutation]);

  React.useEffect(() => {
    if (!data) return;
    const workspaceItem = items.find((item) => item.type === "workspace");
    if (!workspaceItem) return;
    const terminalIds = items
      .filter((item) => item.type === "terminal")
      .map((item) => item.id);

    const createdEdges: Array<{ sourceItemId: string; targetItemId: string }> = [];

    setEdges((prev) => {
      let changed = false;
      const next = [...prev];
      terminalIds.forEach((terminalId) => {
        const alreadyLinked = prev.some(
          (edge) =>
            edge.source === terminalId &&
            edge.target === workspaceItem.id &&
            edge.sourceHandle === "bottom-out" &&
            edge.targetHandle === "top-in"
        );
        if (alreadyLinked) return;
        const edgeId = `edge-${terminalId}-${workspaceItem.id}-workspace`;
        next.push({
          id: edgeId,
          source: terminalId,
          target: workspaceItem.id,
          sourceHandle: "bottom-out",
          targetHandle: "top-in",
          type: "smoothstep",
          animated: true,
          style: { stroke: "var(--accent-primary)", strokeWidth: 2 },
        });
        changed = true;
        if (!terminalId.startsWith("temp-") && !workspaceItem.id.startsWith("temp-")) {
          createdEdges.push({ sourceItemId: terminalId, targetItemId: workspaceItem.id });
        }
      });
      return changed ? next : prev;
    });

    createdEdges.forEach(({ sourceItemId, targetItemId }) => {
      createEdgeMutation.mutate({
        sourceItemId,
        targetItemId,
        sourceHandle: "bottom-out",
        targetHandle: "top-in",
      });
    });
  }, [data, items, setEdges, createEdgeMutation]);

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
              <Tooltip content="Settings">
                <Button variant="ghost" size="icon-sm">
                  <Settings className="w-4 h-4" />
                </Button>
              </Tooltip>
            </div>
          </div>
        </div>
      </header>

      {/* Main content area */}
      <div className="flex-1 flex relative">
        {/* Canvas with cursor tracking */}
        <main
          ref={canvasContainerRef}
          className="flex-1 relative"
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
        >
          <div className="absolute left-4 top-2 z-20 pointer-events-none">
            <div className="flex items-center gap-2 pointer-events-auto">
              {/* Back button */}
              <div className="flex items-center border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1">
                <Tooltip content="Back to dashboards" side="bottom">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => router.push("/dashboards")}
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                </Tooltip>
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
              <div className="flex items-center gap-1 w-fit border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1 pointer-events-auto">
                <Tooltip
                  content={
                    typeof metricsQuery.data?.heapMB === "number"
                      ? `CPU ${(cpuPercent ?? 0).toFixed(1)}% · Heap ${metricsQuery.data.heapMB.toFixed(1)}MB · Sys ${metricsQuery.data.sysMB.toFixed(1)}MB · Goroutines ${metricsQuery.data.goroutines}`
                      : "Sandbox metrics unavailable"
                  }
                  side="bottom"
                >
                  <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1">
                    <Activity className="w-3.5 h-3.5 text-[var(--foreground-muted)]" />
                    <div className="flex items-center gap-2 text-[10px] text-[var(--foreground-muted)]">
                      {typeof metricsQuery.data?.heapMB === "number" ? (
                        <>
                          <span>CPU {cpuPercent === null ? "…" : `${cpuPercent.toFixed(1)}%`}</span>
                          <span>Heap {metricsQuery.data.heapMB.toFixed(1)}MB</span>
                          <span>Sys {metricsQuery.data.sysMB.toFixed(1)}MB</span>
                        </>
                      ) : (
                        <span>Metrics…</span>
                      )}
                    </div>
                  </div>
                </Tooltip>
              </div>
            </div>
          )}
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
              onCursorMove={connectorMode ? handleCursorMove : undefined}
              onCanvasClick={() => {
                if (connectorMode) setConnectorMode(false);
              }}
              onConnectorClick={role === "viewer" ? undefined : handleConnectorClick}
              connectorMode={connectorMode}
              fitViewEnabled={false}
              extraNodes={extraNodes}
              readOnly={role === "viewer"}
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
    </div>
  );
}
