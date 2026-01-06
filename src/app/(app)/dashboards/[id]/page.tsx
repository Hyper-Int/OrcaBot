"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  StickyNote,
  CheckSquare,
  Link2,
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
import type { DashboardItem, Dashboard, Session } from "@/types/dashboard";
import type { PresenceUser } from "@/types/collaboration";

type BlockType = DashboardItem["type"];

// Only include types that exist in the DB schema
const blockTools: { type: BlockType; icon: React.ReactNode; label: string }[] = [
  { type: "note", icon: <StickyNote className="w-4 h-4" />, label: "Note" },
  { type: "todo", icon: <CheckSquare className="w-4 h-4" />, label: "Todo" },
  { type: "link", icon: <Link2 className="w-4 h-4" />, label: "Link" },
  { type: "terminal", icon: <Terminal className="w-4 h-4" />, label: "Terminal" },
  // Recipe is not in DB schema yet - uncomment when added:
  // { type: "recipe", icon: <Workflow className="w-4 h-4" />, label: "Recipe" },
];

const defaultSizes: Record<string, { width: number; height: number }> = {
  note: { width: 200, height: 120 },
  todo: { width: 280, height: 160 },
  link: { width: 260, height: 140 },
  terminal: { width: 600, height: 360 },
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

  const { user, isAuthenticated } = useAuthStore();

  // Dialog states
  const [isAddLinkOpen, setIsAddLinkOpen] = React.useState(false);
  const [newLinkUrl, setNewLinkUrl] = React.useState("");

  // Canvas container ref for cursor tracking
  const canvasContainerRef = React.useRef<HTMLDivElement>(null);

  // Collaboration hook - real-time presence and updates
  const [collabState, collabActions] = useCollaboration({
    dashboardId,
    userId: user?.id || "",
    userName: user?.name || "",
    userEmail: user?.email || "",
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

  // Create item mutation
  const createItemMutation = useMutation({
    mutationFn: (item: Parameters<typeof createItem>[1]) =>
      createItem(dashboardId, item),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
      toast.success("Block added");
    },
    onError: (error) => {
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard", dashboardId] });
      toast.success("Block deleted");
    },
    onError: (error) => {
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
  const handleAddBlock = (type: BlockType) => {
    if (type === "link") {
      setIsAddLinkOpen(true);
      return;
    }

    const defaultContent = type === "todo" ? "[]" : "";

    createItemMutation.mutate({
      type,
      content: defaultContent,
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
      size: defaultSizes[type] || { width: 200, height: 120 },
    });
  };

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
  }, [collabState.items, collabState.sessions, queryClient, dashboardId]);

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

  const { dashboard, items, sessions, role } = data;

  // Connection status indicator
  const isCollaborationConnected = collabState.connectionState === "connected";

  return (
    <div className="h-screen flex flex-col bg-[var(--background)]">
      {/* Header */}
      <header className="h-12 border-b border-[var(--border)] bg-[var(--background-elevated)] flex items-center px-4 gap-4">
        {/* Back button */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => router.push("/dashboards")}
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>

        {/* Dashboard name */}
        <h1 className="text-sm font-medium text-[var(--foreground)] truncate">
          {dashboard.name}
        </h1>

        {/* Role badge */}
        {role !== "owner" && (
          <span className="text-xs text-[var(--foreground-subtle)] px-2 py-0.5 bg-[var(--background)] rounded">
            {role}
          </span>
        )}

        <div className="flex-1" />

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
      </header>

      {/* Main content area */}
      <div className="flex-1 flex">
        {/* Toolbar */}
        <aside className="w-12 border-r border-[var(--border)] bg-[var(--background-elevated)] flex flex-col items-center py-3 gap-1">
          {blockTools.map((tool) => (
            <Tooltip key={tool.type} content={tool.label} side="right">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => handleAddBlock(tool.type)}
                disabled={createItemMutation.isPending}
              >
                {tool.icon}
              </Button>
            </Tooltip>
          ))}
        </aside>

        {/* Canvas with cursor tracking */}
        <main
          ref={canvasContainerRef}
          className="flex-1 relative"
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
        >
          <Canvas
            items={items}
            sessions={sessions}
            onItemChange={handleItemChange}
            onItemDelete={handleItemDelete}
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
