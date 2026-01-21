// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { DashboardItem, DashboardEdge, Session } from "./dashboard";

/**
 * Cursor position on the canvas
 */
export interface CursorPosition {
  x: number;
  y: number;
}

/**
 * Presence info for a user (internal representation)
 */
export interface PresenceInfo {
  userId: string;
  userName: string;
  color: string;
  cursor: CursorPosition | null;
  selectedItem: string | null;
  isTyping: boolean;
}

/**
 * Presence user with additional context
 */
export interface PresenceUser extends PresenceInfo {
  isCurrentUser: boolean;
}

// ===== WebSocket Message Types (Cloudflare) =====
// Using snake_case to match WebSocket message format

/**
 * Join message (server -> client)
 */
export interface JoinMessage {
  type: "join";
  user_id: string;
  user_name: string;
}

/**
 * Leave message (server -> client)
 */
export interface LeaveMessage {
  type: "leave";
  user_id: string;
}

/**
 * Cursor message (bidirectional)
 */
export interface CursorMessage {
  type: "cursor";
  user_id?: string; // Set by server on incoming
  x: number;
  y: number;
}

/**
 * Select message (bidirectional)
 */
export interface SelectMessage {
  type: "select";
  user_id?: string; // Set by server on incoming
  item_id: string | null;
}

/**
 * Item update message (client -> server)
 */
export interface ItemUpdateOutgoing {
  type: "item_update";
  item_id: string;
  content?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Item update message (server -> client)
 */
export interface ItemUpdateIncoming {
  type: "item_update";
  item: DashboardItem;
}

/**
 * Item create message (client -> server)
 */
export interface ItemCreateOutgoing {
  type: "item_create";
  // The item type field - using explicit property instead of 'type' to avoid confusion
  item_type?: string;
  content: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
}

/**
 * Item create message (server -> client)
 */
export interface ItemCreateIncoming {
  type: "item_create";
  item: DashboardItem;
}

/**
 * Item delete message (bidirectional)
 */
export interface ItemDeleteMessage {
  type: "item_delete";
  item_id: string;
}

/**
 * Presence user info from server
 */
export interface PresenceUserInfo {
  user_id: string;
  user_name: string;
  cursor?: { x: number; y: number };
  selected_item?: string;
}

/**
 * Presence message (server -> client)
 */
export interface PresenceMessage {
  type: "presence";
  users: PresenceUserInfo[];
}

/**
 * Session update message (server -> client)
 */
export interface SessionUpdateMessage {
  type: "session_update";
  session: Session;
}

export interface EdgeCreateMessage {
  type: "edge_create";
  edge: DashboardEdge;
}

export interface EdgeDeleteMessage {
  type: "edge_delete";
  edge_id: string;
}

export interface BrowserOpenMessage {
  type: "browser_open";
  url: string;
}

/**
 * All incoming collaboration messages
 */
export type IncomingCollabMessage =
  | JoinMessage
  | LeaveMessage
  | (CursorMessage & { user_id: string })
  | (SelectMessage & { user_id: string })
  | ItemUpdateIncoming
  | ItemCreateIncoming
  | ItemDeleteMessage
  | EdgeCreateMessage
  | EdgeDeleteMessage
  | PresenceMessage
  | SessionUpdateMessage
  | BrowserOpenMessage;

/**
 * All outgoing collaboration messages
 */
export type OutgoingCollabMessage =
  | Omit<CursorMessage, "user_id">
  | Omit<SelectMessage, "user_id">
  | ItemUpdateOutgoing
  | ItemCreateOutgoing
  | ItemDeleteMessage;
