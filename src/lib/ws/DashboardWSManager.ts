/**
 * WebSocket manager for dashboard collaboration
 * Handles: presence, cursors, selections, item updates
 *
 * Protocol: JSON text frames only (no binary)
 */

import {
  BaseWebSocketManager,
  type WebSocketConfig,
} from "./BaseWebSocketManager";
import type {
  IncomingCollabMessage,
  OutgoingCollabMessage,
  PresenceInfo,
  CursorPosition,
} from "@/types/collaboration";
import { getCollaborationWsUrl } from "@/lib/api/cloudflare";
import { getUserColor } from "@/lib/utils";

// Throttle cursor updates to 50ms
const CURSOR_THROTTLE_MS = 50;

export class DashboardWSManager extends BaseWebSocketManager {
  private dashboardId: string;
  private userId: string;
  private userName: string;
  private userEmail: string;
  private lastCursorSend = 0;
  private pendingCursor: CursorPosition | null = null;
  private cursorThrottleTimeout: ReturnType<typeof setTimeout> | null = null;

  // Local state
  private presence: Map<string, PresenceInfo> = new Map();
  private selections: Map<string, string> = new Map(); // userId -> itemId

  // Message handlers
  private onMessageHandlers: Set<(message: IncomingCollabMessage) => void> = new Set();

  constructor(
    dashboardId: string,
    userId: string,
    userName: string,
    userEmail: string,
    config?: WebSocketConfig
  ) {
    const url = getCollaborationWsUrl(dashboardId, userId, userName, userEmail);
    super(url, config);

    this.dashboardId = dashboardId;
    this.userId = userId;
    this.userName = userName;
    this.userEmail = userEmail;
  }

  /**
   * Subscribe to messages
   */
  onMessage(handler: (message: IncomingCollabMessage) => void): () => void {
    this.onMessageHandlers.add(handler);
    return () => this.onMessageHandlers.delete(handler);
  }

  /**
   * Send cursor position (throttled)
   */
  sendCursor(position: CursorPosition): void {
    const now = Date.now();
    const timeSinceLastSend = now - this.lastCursorSend;

    if (timeSinceLastSend >= CURSOR_THROTTLE_MS) {
      this.doSendCursor(position);
    } else {
      // Queue the cursor update
      this.pendingCursor = position;
      if (!this.cursorThrottleTimeout) {
        this.cursorThrottleTimeout = setTimeout(() => {
          if (this.pendingCursor) {
            this.doSendCursor(this.pendingCursor);
            this.pendingCursor = null;
          }
          this.cursorThrottleTimeout = null;
        }, CURSOR_THROTTLE_MS - timeSinceLastSend);
      }
    }
  }

  private doSendCursor(position: CursorPosition): void {
    this.sendJSON({
      type: "cursor",
      ...position,
    } as OutgoingCollabMessage);
    this.lastCursorSend = Date.now();
  }

  /**
   * Send item selection
   */
  selectItem(itemId: string | null): void {
    this.sendJSON({
      type: "select",
      item_id: itemId,
    } as OutgoingCollabMessage);
  }

  /**
   * Send item update
   */
  updateItem(
    itemId: string,
    changes: {
      content?: string;
      position?: { x: number; y: number };
      size?: { width: number; height: number };
    }
  ): void {
    this.sendJSON({
      type: "item_update",
      item_id: itemId,
      ...changes,
    } as OutgoingCollabMessage);
  }

  /**
   * Send item create
   */
  createItem(item: {
    type: string;
    content: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
  }): void {
    this.sendJSON({
      type: "item_create",
      item_type: item.type,
      content: item.content,
      position: item.position,
      size: item.size,
    } as OutgoingCollabMessage);
  }

  /**
   * Send item delete
   */
  deleteItem(itemId: string): void {
    this.sendJSON({
      type: "item_delete",
      item_id: itemId,
    } as OutgoingCollabMessage);
  }

  /**
   * Get current presence list
   */
  getPresence(): PresenceInfo[] {
    return Array.from(this.presence.values());
  }

  /**
   * Get selection map
   */
  getSelections(): Map<string, string> {
    return new Map(this.selections);
  }

  // ===== Protected overrides =====

  protected handleTextMessage(data: string): void {
    try {
      const message = JSON.parse(data) as IncomingCollabMessage;
      this.handleCollabMessage(message);
      // Notify subscribers
      this.onMessageHandlers.forEach((handler) => handler(message));
    } catch (error) {
      console.error("Failed to parse collaboration message:", error);
    }
  }

  protected onConnected(): void {
    console.log(`Connected to dashboard ${this.dashboardId}`);
  }

  protected onDisconnected(): void {
    console.log(`Disconnected from dashboard ${this.dashboardId}`);
    // Clear presence on disconnect
    this.presence.clear();
    this.selections.clear();
  }

  // ===== Private methods =====

  private handleCollabMessage(message: IncomingCollabMessage): void {
    switch (message.type) {
      case "join":
        this.presence.set(message.user_id, {
          userId: message.user_id,
          userName: message.user_name,
          color: getUserColor(message.user_id),
          cursor: null,
          selectedItem: null,
          isTyping: false,
        });
        break;

      case "leave":
        this.presence.delete(message.user_id);
        this.selections.delete(message.user_id);
        break;

      case "cursor":
        const cursorPresence = this.presence.get(message.user_id);
        if (cursorPresence) {
          cursorPresence.cursor = { x: message.x, y: message.y };
        }
        break;

      case "select":
        if (message.item_id) {
          this.selections.set(message.user_id, message.item_id);
        } else {
          this.selections.delete(message.user_id);
        }
        const selectPresence = this.presence.get(message.user_id);
        if (selectPresence) {
          selectPresence.selectedItem = message.item_id || null;
        }
        break;

      case "presence":
        // Full presence sync
        this.presence.clear();
        for (const user of message.users) {
          this.presence.set(user.user_id, {
            userId: user.user_id,
            userName: user.user_name,
            color: getUserColor(user.user_id),
            cursor: user.cursor ? { x: user.cursor.x, y: user.cursor.y } : null,
            selectedItem: user.selected_item || null,
            isTyping: false,
          });
        }
        break;

      case "item_update":
      case "item_create":
      case "item_delete":
      case "session_update":
        // These are handled by subscribers via onMessage
        break;
    }
  }

}
