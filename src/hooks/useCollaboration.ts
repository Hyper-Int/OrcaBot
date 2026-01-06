"use client";

import * as React from "react";
import { DashboardWSManager } from "@/lib/ws";
import type { ConnectionState } from "@/lib/ws";
import type {
  PresenceInfo,
  CursorPosition,
  IncomingCollabMessage,
} from "@/types/collaboration";
import type { DashboardItem, Session } from "@/types/dashboard";

export interface UseCollaborationOptions {
  dashboardId: string;
  userId: string;
  userName: string;
  userEmail: string;
  enabled?: boolean;
}

export interface UseCollaborationState {
  connectionState: ConnectionState;
  presence: PresenceInfo[];
  items: DashboardItem[];
  sessions: Session[];
  error: Error | null;
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
  const { dashboardId, userId, userName, userEmail, enabled = true } = options;

  const managerRef = React.useRef<DashboardWSManager | null>(null);
  const [connectionState, setConnectionState] =
    React.useState<ConnectionState>("disconnected");
  const [presence, setPresence] = React.useState<PresenceInfo[]>([]);
  const [items, setItems] = React.useState<DashboardItem[]>([]);
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [error, setError] = React.useState<Error | null>(null);

  // Initialize and manage WebSocket connection
  React.useEffect(() => {
    if (!enabled || !dashboardId || !userId || !userEmail) {
      console.log(`[Collab] Skipping connection - enabled: ${enabled}, dashboardId: ${dashboardId}, userId: ${userId}, userEmail: ${userEmail}`);
      return;
    }

    console.log(`[Collab] Initializing collaboration for dashboard ${dashboardId}`);

    // First, make a diagnostic HTTP request to check if the endpoint is reachable
    // This helps us see the actual error response
    const wsUrl = `wss://hyper-cloudflare.robbomacrae.workers.dev/dashboards/${dashboardId}/ws?user_id=${encodeURIComponent(userId)}&user_name=${encodeURIComponent(userName)}&user_email=${encodeURIComponent(userEmail)}`;
    const httpUrl = wsUrl.replace("wss://", "https://").replace("ws://", "http://");

    console.log(`[Collab] Testing endpoint: ${httpUrl}`);
    fetch(httpUrl, { method: "GET" })
      .then(async (response) => {
        const text = await response.text();
        console.log(`[Collab] HTTP probe response: ${response.status} ${response.statusText}`, text.substring(0, 500));
      })
      .catch((err) => {
        console.log(`[Collab] HTTP probe error:`, err);
      });

    const manager = new DashboardWSManager(dashboardId, userId, userName, userEmail);
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
    });

    // Connect
    manager.connect();

    return () => {
      console.log(`[Collab] Cleanup - disconnecting`);
      unsubState();
      unsubError();
      unsubMessage();
      manager.disconnect();
      managerRef.current = null;
    };
  }, [dashboardId, userId, userName, userEmail, enabled]);

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
        setItems((prev) => [...prev, message.item]);
        break;

      case "item_delete":
        setItems((prev) =>
          prev.filter((item) => item.id !== message.item_id)
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
    }
  }, []);

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
    sessions,
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
