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
  cwd?: string;
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
 * Audio event (server -> client)
 * Used by talkito and other TTS tools to play audio in the browser
 */
export interface AudioEvent {
  type: "audio";
  action: "play" | "stop";
  path?: string;   // file path in workspace (for file-based audio)
  data?: string;   // base64-encoded audio (for inline audio)
  format?: string; // "mp3", "wav", etc.
}

/**
 * TTS status event (server -> client)
 * Sent by talkito to report TTS configuration status
 */
export interface TtsStatusEvent {
  type: "tts_status";
  enabled: boolean;
  initialized: boolean;
  mode?: string;     // "full", "partial", etc.
  provider?: string; // "openai", "elevenlabs", etc.
  voice?: string;    // voice name/ID
}

/**
 * Talkito notice event (server -> client)
 * Log/notice messages from talkito to display in console
 */
export interface TalkitoNoticeEvent {
  type: "talkito_notice";
  level: "info" | "warning" | "error";
  message: string;
  category?: string; // e.g. "tts"
}

/**
 * Agent stopped event (server -> client)
 * Emitted when an agentic coder finishes its turn via native stop hooks.
 * Supported agents: Claude Code, Gemini CLI, GitHub Copilot CLI, OpenCode,
 * OpenClaw, Droid, Codex CLI.
 */
export interface AgentStoppedEvent {
  type: "agent_stopped";
  agent: string; // claude-code, gemini, codex, copilot, opencode, openclaw/moltbot, droid
  lastMessage: string; // the agent's final response (truncated to 4KB)
  reason: "complete" | "interrupted" | "error" | "unknown";
  timestamp: string; // ISO 8601
}

/**
 * Cwd changed event (server -> client)
 * Sent when the PTY process changes its working directory
 */
export interface CwdChangedEvent {
  type: "cwd_changed";
  cwd: string; // relative to workspace root
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
  | PtyClosedEvent
  | AudioEvent
  | TtsStatusEvent
  | TalkitoNoticeEvent
  | AgentStoppedEvent
  | CwdChangedEvent;
