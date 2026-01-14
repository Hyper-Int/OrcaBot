"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { type Edge, useEdgesState } from "@xyflow/react";
import {
  ArrowLeft,
  StickyNote,
  CheckSquare,
  Link2,
  Globe,
  Terminal,
  Users,
  Settings,
  Share2,
} from "lucide-react";
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
} from "@/components/ui";
import { Canvas } from "@/components/canvas";
import { CursorOverlay, PresenceList } from "@/components/multiplayer";
import { useAuthStore } from "@/stores/auth-store";
import { useCollaboration } from "@/hooks/useCollaboration";
import { getDashboard, createItem, updateItem, deleteItem } from "@/lib/api/cloudflare";
import { generateId } from "@/lib/utils";
import type { DashboardItem, Dashboard, Session } from "@/types/dashboard";
import type { PresenceUser } from "@/types/collaboration";

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

// Only include types that exist in the DB schema
const blockTools: BlockTool[] = [
  { type: "note", icon: <StickyNote className="w-4 h-4" />, label: "Note" },
  { type: "todo", icon: <CheckSquare className="w-4 h-4" />, label: "Todo" },
  { type: "link", icon: <Link2 className="w-4 h-4" />, label: "Link" },
  { type: "browser", icon: <Globe className="w-4 h-4" />, label: "Browser" },
  // Recipe is not in DB schema yet - uncomment when added:
  // { type: "recipe", icon: <Workflow className="w-4 h-4" />, label: "Recipe" },
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
    label: "Terminal",
    icon: <Terminal className="w-4 h-4" />,
  },
];

const defaultSizes: Record<string, { width: number; height: number }> = {
  note: { width: 200, height: 120 },
  todo: { width: 280, height: 160 },
  link: { width: 260, height: 140 },
  terminal: { width: 360, height: 400 },
  browser: { width: 520, height: 360 },
  workspace: { width: 620, height: 130 },
  recipe: { width: 320, height: 200 },
};

// Debounce helper
function useDebouncedCallback<T extends (...args: unknown[]) => void>(
  callback: T,
  delay: number
): T {
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = React.useRef(callback);
  callbackRef.current = callback;

  return React.useCallback(
    ((...args: unknown[]) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = setTimeout(() => {
        callbackRef.current(...args);
      }, delay);
    }) as T,
    [delay]
  );
}

export default function DashboardPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const dashboardId = params.id as string;
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const { user, isAuthenticated } = useAuthStore();

  // Dialog states
  const [isAddLinkOpen, setIsAddLinkOpen] = React.useState(false);
  const [newLinkUrl, setNewLinkUrl] = React.useState("");

  // Canvas container ref for cursor tracking
  const canvasContainerRef = React.useRef<HTMLDivElement>(null);
  const viewportRef = React.useRef({ x: 0, y: 0, zoom: 1 });

  // Collaboration hook - real-time presence and updates
  const [collabState, collabActions] = useCollaboration({
    dashboardId,
    userId: user?.id || "",
    userName: user?.name || "",
    enabled: isAuthenticated && !!dashboardId && !!user?.id,
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
  // Track previous collaboration items to detect what actually changed
  const prevCollabItemsRef = React.useRef<DashboardItem[]>([]);
  const workspaceCreateRequestedRef = React.useRef(false);

  // Fetch dashboard data with better caching
  const {
    data,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["dashboard", dashboardId],
    queryFn: () => getDashboard(dashboardId),
    enabled: isAuthenticated && !!dashboardId,
    staleTime: 30000, // Consider data fresh for 30 seconds
    refetchOnWindowFocus: false, // Don't refetch on window focus
    refetchInterval: false, // Don't auto-refetch
  });

  const dashboard = data?.dashboard;
  const items = data?.items ?? [];
  const sessions = data?.sessions ?? [];
  const role = data?.role ?? "viewer";

  // Create item mutation
  const createItemMutation = useMutation({
    mutationFn: ({
      clientTempId: _clientTempId,
      sourceId: _sourceId,
      ...item
    }: Parameters<typeof createItem>[1] & { clientTempId?: string; sourceId?: string; sourceHandle?: string }) =>
      createItem(dashboardId, item),
    onMutate: async (item) => {
      await queryClient.cancelQueries({ queryKey: ["dashboard", dashboardId] });
      const previous = queryClient.getQueryData<{
        dashboard: Dashboard;
        items: DashboardItem[];
        sessions: Session[];
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
      };

      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            items: [...oldData.items, optimisticItem],
          };
        }
      );

      if (item.sourceId) {
        const edgeId = `edge-${item.sourceId}-${tempId}`;
        setEdges((prev) => {
          if (prev.some((edge) => edge.id === edgeId)) return prev;
          return [
            ...prev,
            {
              id: edgeId,
              source: item.sourceId as string,
              target: tempId,
              sourceHandle: item.sourceHandle,
              type: "smoothstep",
              animated: true,
              style: { stroke: "var(--accent-primary)", strokeWidth: 2 },
            },
          ];
        });
      }

      return { previous, tempId, sourceId: item.sourceId, sourceHandle: item.sourceHandle };
    },
    onSuccess: (createdItem, _variables, context) => {
      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          const hasTemp = context?.tempId
            ? oldData.items.some((item) => item.id === context.tempId)
            : false;
          const nextItems = hasTemp
            ? oldData.items.map((item) =>
                item.id === context?.tempId ? createdItem : item
              )
            : [...oldData.items, createdItem];
          return {
            ...oldData,
            items: nextItems,
          };
        }
      );
      if (context?.sourceId) {
        setEdges((prev) => {
          const next = prev.filter(
            (edge) =>
              !(edge.source === context.sourceId && edge.target === context.tempId)
          );
          next.push({
            id: `edge-${context.sourceId}-${createdItem.id}`,
            source: context.sourceId,
            target: createdItem.id,
            sourceHandle: context.sourceHandle,
            type: "smoothstep",
            animated: true,
            style: { stroke: "var(--accent-primary)", strokeWidth: 2 },
          });
          return next;
        });
      }
      toast.success("Block added");
    },
    onError: (error, _variables, context) => {
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
      await queryClient.cancelQueries({ queryKey: ["dashboard", dashboardId] });
      const previous = queryClient.getQueryData<{
        dashboard: Dashboard;
        items: DashboardItem[];
        sessions: Session[];
        role: string;
      }>(["dashboard", dashboardId]);
      const previousEdges = edges;

      queryClient.setQueryData(
        ["dashboard", dashboardId],
        (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; role: string } | undefined) => {
          if (!oldData) return oldData;
          return {
            ...oldData,
            items: oldData.items.filter((item) => item.id !== itemId),
          };
        }
      );

      setEdges((prev) =>
        prev.filter((edge) => edge.source !== itemId && edge.target !== itemId)
      );

      return { previous, previousEdges };
    },
    onSuccess: () => {
      toast.success("Block deleted");
    },
    onError: (error, _itemId, context) => {
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

  // Add block handler
  const handleAddBlock = (tool: BlockTool) => {
    if (tool.type === "link") {
      setIsAddLinkOpen(true);
      return;
    }

    const defaultContent = tool.type === "todo" ? "[]" : "";
    const terminalContent = tool.type === "terminal" && tool.terminalPreset
      ? JSON.stringify({
          name: tool.label,
          subagentIds: [],
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
      sourceHandle: "terminal-right",
    });
  },
  [createItemMutation]
);

  // Add link handler
  const handleAddLink = (e: React.FormEvent) => {
    e.preventDefault();
    if (newLinkUrl.trim()) {
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
      (oldData: { dashboard: Dashboard; items: DashboardItem[]; sessions: Session[]; role: string } | undefined) => {
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

    if (removedItemIds.length > 0) {
      setEdges((prev) =>
        prev.filter(
          (edge) =>
            !removedItemIds.includes(edge.source) &&
            !removedItemIds.includes(edge.target)
        )
      );
    }

    // Only invalidate if changed items are from remote users (not in our pending set)
    if (changedItemIds.size > 0) {
      const hasRemoteChanges = Array.from(changedItemIds).some(
        (id) => !pendingItemIdsRef.current.has(id)
      );
      if (hasRemoteChanges) {
        queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
      }
    }

    // Session updates are always from the server, so always invalidate
    if (collabState.sessions.length > 0) {
      queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
    }
  }, [collabState.items, collabState.sessions, queryClient, dashboardId, setEdges]);

  // Item delete handler
  const handleItemDelete = (itemId: string) => {
    // Remove from pending tracking
    pendingUpdatesRef.current.delete(itemId);
    pendingItemIdsRef.current.delete(itemId);
    deleteItemMutation.mutate(itemId);
  };

  // Redirect if not authenticated
  React.useEffect(() => {
    if (!isAuthenticated) {
      router.push("/login");
    }
  }, [isAuthenticated, router]);

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
    }, {
      onError: () => {
        workspaceCreateRequestedRef.current = false;
      },
    });
  }, [data, role, items, createItemMutation]);

  React.useEffect(() => {
    if (!data) return;
    const workspaceItem = items.find((item) => item.type === "workspace");
    if (!workspaceItem) return;
    const terminalIds = items
      .filter((item) => item.type === "terminal")
      .map((item) => item.id);

    setEdges((prev) => {
      const next = [...prev];
      terminalIds.forEach((terminalId) => {
        const edgeId = `edge-${terminalId}-${workspaceItem.id}`;
        if (next.some((edge) => edge.id === edgeId)) return;
        next.push({
          id: edgeId,
          source: terminalId,
          target: workspaceItem.id,
          sourceHandle: "workspace",
          type: "smoothstep",
          animated: true,
          style: { stroke: "var(--accent-primary)", strokeWidth: 2 },
        });
      });
      return next;
    });
  }, [data, items, setEdges]);

  if (!isAuthenticated) {
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

  if (error || !data) {
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
          <p className="text-[var(--status-error)]">Failed to load dashboard</p>
          <Button
            variant="secondary"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] })}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // Connection status indicator
  const isCollaborationConnected = collabState.connectionState === "connected";

  return (
    <div className="h-screen flex flex-col bg-[var(--background)]">
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
              {dashboard.name}
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
              <Tooltip content="Share">
                <Button variant="ghost" size="icon-sm">
                  <Share2 className="w-4 h-4" />
                </Button>
              </Tooltip>
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
            <div className="flex items-center gap-1 w-fit border border-[var(--border)] bg-[var(--background-elevated)] rounded-lg px-2 py-1 pointer-events-auto">
              <Tooltip content="Back to dashboards" side="bottom">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => router.push("/dashboards")}
                >
                  <ArrowLeft className="w-4 h-4" />
                </Button>
              </Tooltip>
              <div className="h-6 w-px bg-[var(--border)] mx-2" />
              {terminalTools.map((tool) => (
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
              <div className="h-6 w-px bg-[var(--border)] mx-2" />
              {blockTools.map((tool) => (
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
          </div>
          <Canvas
            items={items}
            sessions={sessions}
            onItemChange={handleItemChange}
            onItemDelete={handleItemDelete}
            edges={edges}
            onEdgesChange={onEdgesChange}
            onCreateBrowserBlock={role === "viewer" ? undefined : handleCreateBrowserBlock}
            onViewportChange={(next) => {
              viewportRef.current = next;
            }}
            fitViewEnabled={false}
            readOnly={role === "viewer"}
          />
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
    </div>
  );
}
