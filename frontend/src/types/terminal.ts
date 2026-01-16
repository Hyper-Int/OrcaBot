// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Terminal control state
 */
export type ControlState = "has-control" | "observing" | "requesting";

/**
 * Agent state
 */
export type AgentState = "idle" | "running" | "paused" | "stopped" | null;

/**
 * Turn-taking state for a terminal
 */
export interface TurnTakingState {
  /** Current controller user ID (empty string = no one) */
  controller: string;
  /** Current controller display name */
  controllerName?: string;
  /** Whether current user is the controller */
  isController: boolean;
  /** Whether current user has a pending request */
  hasPendingRequest: boolean;
  /** List of users requesting control */
  pendingRequests: string[];
  /** Whether input is blocked */
  inputBlocked: boolean;
  /** Reason for input block */
  inputBlockReason: "not_controller" | "agent_running" | null;
}

/**
 * Terminal connection status
 */
export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

/**
 * Terminal state for the store
 */
export interface TerminalState {
  connectionStatus: ConnectionStatus;
  turnTaking: TurnTakingState;
  agentState: AgentState;
  isAgentTerminal: boolean;
  error: string | null;
}

/**
 * PTY info from sandbox
 */
export interface PTYInfo {
  id: string;
  sessionId: string;
}

// ===== WebSocket Message Types =====

/**
 * Resize message (client -> server)
 */
export interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

/**
 * Take control message (client -> server)
 */
export interface TakeControlMessage {
  type: "take_control";
}

/**
 * Request control message (client -> server)
 */
export interface RequestControlMessage {
  type: "request_control";
}

/**
 * Grant control message (client -> server)
 */
export interface GrantControlMessage {
  type: "grant_control";
  to: string;
}

/**
 * Revoke control message (client -> server)
 */
export interface RevokeControlMessage {
  type: "revoke_control";
}

/**
 * All outgoing control messages
 */
export type OutgoingControlMessage =
  | ResizeMessage
  | TakeControlMessage
  | RequestControlMessage
  | GrantControlMessage
  | RevokeControlMessage;

/**
 * Control state event (server -> client)
 */
export interface ControlStateEvent {
  type: "control_state";
  controller: string;
  requests: string[];
  agent_state?: "running" | "paused" | "stopped";
}

/**
 * Control taken event (server -> client)
 */
export interface ControlTakenEvent {
  type: "control_taken";
  controller: string;
}

/**
 * Control requested event (server -> client)
 */
export interface ControlRequestedEvent {
  type: "control_requested";
  from: string;
  requests: string[];
}

/**
 * Control granted event (server -> client)
 */
export interface ControlGrantedEvent {
  type: "control_granted";
  from: string;
  to: string;
  controller: string;
}

/**
 * Control revoked event (server -> client)
 */
export interface ControlRevokedEvent {
  type: "control_revoked";
  from: string;
}

/**
 * Control expired event (server -> client)
 */
export interface ControlExpiredEvent {
  type: "control_expired";
  from: string;
  controller: string;
}

/**
 * Agent state event (server -> client)
 */
export interface AgentStateEvent {
  type: "agent_state";
  agent_state: "running" | "paused" | "stopped";
}

/**
 * PTY closed event (server -> client)
 */
export interface PtyClosedEvent {
  type: "pty_closed";
}

/**
 * All incoming control events
 */
export type IncomingControlEvent =
  | ControlStateEvent
  | ControlTakenEvent
  | ControlRequestedEvent
  | ControlGrantedEvent
  | ControlRevokedEvent
  | ControlExpiredEvent
  | AgentStateEvent
  | PtyClosedEvent;
