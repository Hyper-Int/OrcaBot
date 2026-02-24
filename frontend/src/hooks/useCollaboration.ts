// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { DashboardWSManager } from "@/lib/ws";
import type { ConnectionState } from "@/lib/ws";
import type {
  PresenceInfo,
  CursorPosition,
  IncomingCollabMessage,
  InboundMessageMessage,
  UICommand,
  UICommandResultMessage,
  AgentTask,
  AgentMemory,
} from "@/types/collaboration";
import type { DashboardItem, DashboardEdge, Session } from "@/types/dashboard";
import { getCurrentUser } from "@/lib/api/cloudflare";

export interface UseCollaborationOptions {
  dashboardId: string;
  userId: string;
  userName: string;
  enabled?: boolean;
  onMessage?: (message: IncomingCollabMessage) => void;
  onUICommand?: (command: UICommand) => void;
  onUICommandResult?: (result: UICommandResultMessage) => void;
}

export interface UseCollaborationState {
  connectionState: ConnectionState;
  presence: PresenceInfo[];
  items: DashboardItem[];
  edges: DashboardEdge[];
  sessions: Session[];
  tasks: AgentTask[];
  memories: AgentMemory[];
  error: Error | null;
  /** Last task-related message for components that need real-time updates */
  lastTaskMessage: IncomingCollabMessage | null;
  /** Last inbound messaging event for triggering connection data flow */
  lastInboundMessage: InboundMessageMessage | null;
}

export interface UseCollaborationActions {
  sendCursor: (position: CursorPosition) => void;
  selectItem: (itemId: string | null) => void;
  updateItem: (
    itemId: string,
    changes: {
      content?: string;
      position?: { x: number; y: number };
      size?: { width: number; height: number };
    }
  ) => void;
  createItem: (item: {
    type: string;
    content: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
  }) => void;
  deleteItem: (itemId: string) => void;
  reconnect: () => void;
}

export function useCollaboration(
  options: UseCollaborationOptions
): [UseCollaborationState, UseCollaborationActions] {
  const { dashboardId, userId, userName, enabled = true, onMessage, onUICommand, onUICommandResult } = options;

  const managerRef = React.useRef<DashboardWSManager | null>(null);
  const onMessageRef = React.useRef<UseCollaborationOptions["onMessage"]>(onMessage);
  const onUICommandRef = React.useRef<UseCollaborationOptions["onUICommand"]>(onUICommand);
  const onUICommandResultRef = React.useRef<UseCollaborationOptions["onUICommandResult"]>(onUICommandResult);
  const [isBootstrapped, setIsBootstrapped] = React.useState(false);
  const [connectionState, setConnectionState] =
    React.useState<ConnectionState>("disconnected");
  const [presence, setPresence] = React.useState<PresenceInfo[]>([]);
  const [items, setItems] = React.useState<DashboardItem[]>([]);
  const [edges, setEdges] = React.useState<DashboardEdge[]>([]);
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [tasks, setTasks] = React.useState<AgentTask[]>([]);
  const [memories, setMemories] = React.useState<AgentMemory[]>([]);
  const [lastTaskMessage, setLastTaskMessage] = React.useState<IncomingCollabMessage | null>(null);
  const [lastInboundMessage, setLastInboundMessage] = React.useState<InboundMessageMessage | null>(null);
  const [error, setError] = React.useState<Error | null>(null);

  // Ensure user exists (dev-auth bootstrap) before connecting to WS
  React.useEffect(() => {
    let cancelled = false;

    if (!enabled || !dashboardId || !userId) {
      setIsBootstrapped(false);
      return;
    }

    setIsBootstrapped(false);
    getCurrentUser()
      .then(() => {
        if (!cancelled) {
          setIsBootstrapped(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error("Failed to load user"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, dashboardId, userId]);

  React.useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  React.useEffect(() => {
    onUICommandRef.current = onUICommand;
  }, [onUICommand]);

  React.useEffect(() => {
    onUICommandResultRef.current = onUICommandResult;
  }, [onUICommandResult]);

  // Handle incoming messages
  const handleMessage = React.useCallback((message: IncomingCollabMessage) => {
    switch (message.type) {
      case "join":
      case "leave":
      case "cursor":
      case "select":
      case "presence":
        // Presence updates are handled internally by the manager
        // Update our local state from manager's state
        if (managerRef.current) {
          setPresence(managerRef.current.getPresence());
        }
        break;

      case "item_update":
        setItems((prev) =>
          prev.map((item) =>
            item.id === message.item.id ? message.item : item
          )
        );
        break;

      case "item_create":
        setItems((prev) => {
          // Don't add if item already exists (from optimistic update)
          if (prev.some((item) => item.id === message.item.id)) {
            return prev;
          }
          return [...prev, message.item];
        });
        break;

      case "item_delete":
        setItems((prev) =>
          prev.filter((item) => item.id !== message.item_id)
        );
        // Also remove any sessions associated with this item (session is cascade-deleted on backend)
        setSessions((prev) =>
          prev.filter((session) => session.itemId !== message.item_id)
        );
        break;

      case "session_update":
        setSessions((prev) => {
          const index = prev.findIndex((s) => s.id === message.session.id);
          if (index >= 0) {
            const updated = [...prev];
            updated[index] = message.session;
            return updated;
          }
          return [...prev, message.session];
        });
        break;

      case "edge_create":
        setEdges((prev) => {
          if (prev.some((edge) => edge.id === message.edge.id)) return prev;
          return [...prev, message.edge];
        });
        break;

      case "edge_delete":
        setEdges((prev) => prev.filter((edge) => edge.id !== message.edge_id));
        break;
      case "browser_open":
        break;

      // Agent state messages
      case "task_create":
        setLastTaskMessage(message);
        setTasks((prev) => {
          if (prev.some((t) => t.id === message.task.id)) return prev;
          return [...prev, message.task];
        });
        break;

      case "task_update":
        setLastTaskMessage(message);
        setTasks((prev) =>
          prev.map((t) => (t.id === message.task.id ? message.task : t))
        );
        break;

      case "task_delete":
        setLastTaskMessage(message);
        setTasks((prev) => prev.filter((t) => t.id !== message.taskId));
        break;

      case "inbound_message":
        setLastInboundMessage(message);
        break;

      case "memory_update":
        setMemories((prev) => {
          // Use (key, sessionId) as composite identity to distinguish scopes
          const matchesIdentity = (m: AgentMemory) =>
            m.key === message.key &&
            (m.sessionId ?? null) === (message.sessionId ?? null);

          // memory is null when deleted
          if (message.memory === null) {
            return prev.filter((m) => !matchesIdentity(m));
          }
          const existing = prev.findIndex(matchesIdentity);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = message.memory;
            return updated;
          }
          return [...prev, message.memory];
        });
        break;
    }
  }, []);

  // Initialize and manage WebSocket connection
  React.useEffect(() => {
    if (!enabled || !dashboardId || !userId || !isBootstrapped) {
      console.log(`[Collab] Skipping connection - enabled: ${enabled}, dashboardId: ${dashboardId}, userId: ${userId}`);
      return;
    }

    console.log(`[Collab] Initializing collaboration for dashboard ${dashboardId}`);

    const manager = new DashboardWSManager(dashboardId, userId, userName);
    managerRef.current = manager;

    // Subscribe to state changes
    const unsubState = manager.onStateChange((state) => {
      console.log(`[Collab] Connection state changed: ${state}`);
      setConnectionState(state);
    });

    // Subscribe to errors
    const unsubError = manager.onError((err) => {
      console.error(`[Collab] Error:`, err);
      setError(err);
    });

    // Subscribe to messages
    const unsubMessage = manager.onMessage((message) => {
      console.log(`[Collab] Message received:`, message.type);
      handleMessage(message);
      onMessageRef.current?.(message);
    });

    // Subscribe to UI commands
    const unsubUICommand = manager.onUICommand((command) => {
      console.log(`[Collab] UI command received:`, command.type);
      onUICommandRef.current?.(command);
    });

    // Subscribe to UI command results
    const unsubUICommandResult = manager.onUICommandResult((result) => {
      console.log(`[Collab] UI command result:`, result.command_id, result.success);
      onUICommandResultRef.current?.(result);
    });

    // Connect
    manager.connect();

    return () => {
      console.log(`[Collab] Cleanup - disconnecting`);
      unsubState();
      unsubError();
      unsubMessage();
      unsubUICommand();
      unsubUICommandResult();
      manager.disconnect();
      managerRef.current = null;
    };
  }, [dashboardId, userId, userName, enabled, isBootstrapped, handleMessage]);

  // Actions
  const sendCursor = React.useCallback((position: CursorPosition) => {
    managerRef.current?.sendCursor(position);
  }, []);

  const selectItem = React.useCallback((itemId: string | null) => {
    managerRef.current?.selectItem(itemId);
  }, []);

  const updateItem = React.useCallback(
    (
      itemId: string,
      changes: {
        content?: string;
        position?: { x: number; y: number };
        size?: { width: number; height: number };
      }
    ) => {
      managerRef.current?.updateItem(itemId, changes);
    },
    []
  );

  const createItem = React.useCallback(
    (item: {
      type: string;
      content: string;
      position: { x: number; y: number };
      size: { width: number; height: number };
    }) => {
      managerRef.current?.createItem(item);
    },
    []
  );

  const deleteItem = React.useCallback((itemId: string) => {
    managerRef.current?.deleteItem(itemId);
  }, []);

  const reconnect = React.useCallback(() => {
    if (managerRef.current) {
      managerRef.current.disconnect();
      managerRef.current.connect();
    }
  }, []);

  const state: UseCollaborationState = {
    connectionState,
    presence,
    items,
    edges,
    sessions,
    tasks,
    memories,
    lastTaskMessage,
    lastInboundMessage,
    error,
  };

  const actions: UseCollaborationActions = {
    sendCursor,
    selectItem,
    updateItem,
    createItem,
    deleteItem,
    reconnect,
  };

  return [state, actions];
}
