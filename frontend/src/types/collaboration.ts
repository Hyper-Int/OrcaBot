// Copyright 2026 Rob Macrae. All rights reserved.
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
 * Pending approval notification (server -> client)
 */
export interface PendingApprovalMessage {
  type: "pending_approval";
  secret_name: string;
  domain: string;
}

// ===== Agent State Message Types =====

/**
 * Agent task (from control plane)
 */
export interface AgentTask {
  id: string;
  dashboardId: string;
  sessionId?: string;
  parentId?: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
  priority: number;
  blockedBy: string[];
  blocks: string[];
  ownerAgent?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Agent memory (from control plane)
 */
export interface AgentMemory {
  id: string;
  dashboardId: string;
  sessionId?: string;
  key: string;
  value: unknown;
  memoryType: 'fact' | 'context' | 'preference' | 'summary' | 'checkpoint';
  tags: string[];
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Task create message (server -> client)
 */
export interface TaskCreateMessage {
  type: "task_create";
  task: AgentTask;
}

/**
 * Task update message (server -> client)
 */
export interface TaskUpdateMessage {
  type: "task_update";
  task: AgentTask;
}

/**
 * Task delete message (server -> client)
 */
export interface TaskDeleteMessage {
  type: "task_delete";
  taskId: string;
}

/**
 * Memory update message (server -> client)
 * Note: memory is null when a memory entry is deleted
 * sessionId distinguishes dashboard-wide (null) vs session-scoped memory
 */
export interface MemoryUpdateMessage {
  type: "memory_update";
  key: string;
  memory: AgentMemory | null;
  sessionId: string | null;
}

/**
 * Inbound message notification (server -> client)
 * Triggers connection data flow from messaging block to downstream blocks.
 */
export interface InboundMessageMessage {
  type: "inbound_message";
  item_id: string;
  text: string;
  provider: string;
  sender_name: string;
  message_id: string;
  is_orcabot_chat?: boolean;
}

/**
 * Egress approval needed (server -> client via sandbox broadcast)
 * Shown when the egress proxy holds a connection to an unknown domain.
 */
export interface EgressApprovalNeededMessage {
  type: "egress_approval_needed";
  domain: string;
  port: number;
  request_id: string;
}

/**
 * Egress approval resolved (server -> client via sandbox broadcast)
 * Sent when a held connection is approved or denied.
 */
export interface EgressApprovalResolvedMessage {
  type: "egress_approval_resolved";
  domain: string;
  port: number;
  request_id: string;
  decision: string;
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
  | BrowserOpenMessage
  | PendingApprovalMessage
  | UICommandMessage
  | UICommandResultMessage
  | TaskCreateMessage
  | TaskUpdateMessage
  | TaskDeleteMessage
  | MemoryUpdateMessage
  | InboundMessageMessage
  | EgressApprovalNeededMessage
  | EgressApprovalResolvedMessage;

/**
 * All outgoing collaboration messages
 */
export type OutgoingCollabMessage =
  | Omit<CursorMessage, "user_id">
  | Omit<SelectMessage, "user_id">
  | ItemUpdateOutgoing
  | ItemCreateOutgoing
  | ItemDeleteMessage;

// ============================================
// UI Command Types (from MCP UI Server)
// ============================================

/**
 * UI Command types that can be sent from agents to control the dashboard
 */
export type UICommandType =
  | 'create_browser'
  | 'create_todo'
  | 'create_note'
  | 'create_terminal'
  | 'update_item'
  | 'delete_item'
  | 'connect_nodes'
  | 'disconnect_nodes'
  | 'navigate_browser'
  | 'add_todo_item'
  | 'toggle_todo_item';

/**
 * Base UI command structure
 */
export interface UICommandBase {
  type: UICommandType;
  command_id: string;
  source_terminal_id?: string;
}

/**
 * Create browser command
 */
export interface CreateBrowserCommand extends UICommandBase {
  type: 'create_browser';
  url: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Create todo command
 */
export interface CreateTodoCommand extends UICommandBase {
  type: 'create_todo';
  title: string;
  items?: Array<{ text: string; completed?: boolean }>;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Create note command
 */
export interface CreateNoteCommand extends UICommandBase {
  type: 'create_note';
  text: string;
  color?: 'yellow' | 'blue' | 'green' | 'pink' | 'purple';
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Create terminal command
 */
export interface CreateTerminalCommand extends UICommandBase {
  type: 'create_terminal';
  name?: string;
  boot_command?: string;
  agentic?: boolean;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Update item command
 */
export interface UpdateItemCommand extends UICommandBase {
  type: 'update_item';
  item_id: string;
  content?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
}

/**
 * Delete item command
 */
export interface DeleteItemCommand extends UICommandBase {
  type: 'delete_item';
  item_id: string;
}

/**
 * Connect nodes command
 */
export interface ConnectNodesCommand extends UICommandBase {
  type: 'connect_nodes';
  source_item_id: string;
  target_item_id: string;
  source_handle?: string;
  target_handle?: string;
}

/**
 * Disconnect nodes command
 */
export interface DisconnectNodesCommand extends UICommandBase {
  type: 'disconnect_nodes';
  source_item_id: string;
  target_item_id: string;
  source_handle?: string;
  target_handle?: string;
}

/**
 * Navigate browser command
 */
export interface NavigateBrowserCommand extends UICommandBase {
  type: 'navigate_browser';
  item_id: string;
  url: string;
}

/**
 * Add todo item command
 */
export interface AddTodoItemCommand extends UICommandBase {
  type: 'add_todo_item';
  item_id: string;
  text: string;
  completed?: boolean;
}

/**
 * Toggle todo item command
 */
export interface ToggleTodoItemCommand extends UICommandBase {
  type: 'toggle_todo_item';
  item_id: string;
  todo_item_id: string;
}

/**
 * Union of all UI commands
 */
export type UICommand =
  | CreateBrowserCommand
  | CreateTodoCommand
  | CreateNoteCommand
  | CreateTerminalCommand
  | UpdateItemCommand
  | DeleteItemCommand
  | ConnectNodesCommand
  | DisconnectNodesCommand
  | NavigateBrowserCommand
  | AddTodoItemCommand
  | ToggleTodoItemCommand;

/**
 * UI command message (server -> client)
 */
export interface UICommandMessage {
  type: 'ui_command';
  command: UICommand;
}

/**
 * UI command result message (bidirectional)
 */
export interface UICommandResultMessage {
  type: 'ui_command_result';
  command_id: string;
  success: boolean;
  error?: string;
  created_item_id?: string;
}
