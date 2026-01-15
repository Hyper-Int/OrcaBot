/**
 * WebSocket manager for terminal PTY streaming and turn-taking
 *
 * Protocol (per sandbox CLAUDE.md):
 * - Binary frames: PTY I/O (raw bytes)
 * - JSON frames: control messages (resize, turn-taking, agent state)
 */

import {
  BaseWebSocketManager,
  type WebSocketConfig,
} from "./BaseWebSocketManager";
import type {
  TurnTakingState,
  AgentState,
  IncomingControlEvent,
  OutgoingControlMessage,
} from "@/types/terminal";
import { API } from "@/config/env";

export interface TerminalWSConfig extends WebSocketConfig {
  userId: string;
  userName: string;
}

export class TerminalWSManager extends BaseWebSocketManager {
  private sessionId: string;
  private ptyId: string;
  private userId: string;
  private userName: string;

  // Turn-taking state
  private turnTaking: TurnTakingState = {
    controller: "",
    controllerName: undefined,
    isController: false,
    hasPendingRequest: false,
    pendingRequests: [],
    inputBlocked: true,
    inputBlockReason: "not_controller",
  };

  // Agent state
  private agentState: AgentState = null;

  // Callbacks
  private onDataHandlers: Set<(data: Uint8Array) => void> = new Set();
  private onTurnTakingChangeHandlers: Set<(state: TurnTakingState) => void> =
    new Set();
  private onAgentStateChangeHandlers: Set<(state: AgentState) => void> =
    new Set();
  private onPtyClosedHandlers: Set<() => void> = new Set();

  constructor(
    sessionId: string,
    ptyId: string,
    config: TerminalWSConfig
  ) {
    const url = `${API.cloudflare.terminalWs(sessionId, ptyId)}?user_id=${encodeURIComponent(config.userId)}`;
    super(url, config);

    this.sessionId = sessionId;
    this.ptyId = ptyId;
    this.userId = config.userId;
    this.userName = config.userName;
  }

  /**
   * Send PTY input as binary data
   * Returns false if input is blocked
   */
  sendInput(data: string): boolean {
    if (this.turnTaking.inputBlocked) {
      console.warn(
        "Input blocked:",
        this.turnTaking.inputBlockReason
      );
      return false;
    }

    // Convert string to binary and send as raw bytes
    const encoder = new TextEncoder();
    const bytes = encoder.encode(data);
    return this.sendBinary(bytes);
  }

  /**
   * Send raw bytes to the terminal (binary frame)
   */
  sendRawInput(data: Uint8Array): boolean {
    if (this.turnTaking.inputBlocked) {
      console.warn(
        "Input blocked:",
        this.turnTaking.inputBlockReason
      );
      return false;
    }

    return this.sendBinary(data);
  }

  /**
   * Send resize command (JSON control message)
   */
  sendResize(cols: number, rows: number): void {
    this.sendJSON({
      type: "resize",
      cols,
      rows,
    });
  }

  /**
   * Take control of the terminal (if available)
   */
  takeControl(): void {
    this.sendJSON({ type: "take_control" });
  }

  /**
   * Request control from current controller
   */
  requestControl(): void {
    this.sendJSON({ type: "request_control" });
    // Optimistically update local state
    this.turnTaking = {
      ...this.turnTaking,
      hasPendingRequest: true,
    };
    this.notifyTurnTakingChange();
  }

  /**
   * Grant control to another user
   */
  grantControl(toUserId: string): void {
    this.sendJSON({ type: "grant_control", to: toUserId });
  }

  /**
   * Revoke control (release control)
   */
  revokeControl(): void {
    this.sendJSON({ type: "revoke_control" });
  }

  /**
   * Get current turn-taking state
   */
  getTurnTakingState(): TurnTakingState {
    return { ...this.turnTaking };
  }

  /**
   * Get current agent state
   */
  getAgentState(): AgentState {
    return this.agentState;
  }

  /**
   * Check if input is allowed
   */
  canSendInput(): boolean {
    return !this.turnTaking.inputBlocked;
  }

  /**
   * Subscribe to PTY data (binary output from terminal)
   */
  onData(handler: (data: Uint8Array) => void): () => void {
    this.onDataHandlers.add(handler);
    return () => this.onDataHandlers.delete(handler);
  }

  /**
   * Subscribe to turn-taking changes
   */
  onTurnTakingChange(
    handler: (state: TurnTakingState) => void
  ): () => void {
    this.onTurnTakingChangeHandlers.add(handler);
    return () => this.onTurnTakingChangeHandlers.delete(handler);
  }

  /**
   * Subscribe to agent state changes
   */
  onAgentStateChange(handler: (state: AgentState) => void): () => void {
    this.onAgentStateChangeHandlers.add(handler);
    return () => this.onAgentStateChangeHandlers.delete(handler);
  }

  /**
   * Subscribe to PTY closed events
   */
  onPtyClosed(handler: () => void): () => void {
    this.onPtyClosedHandlers.add(handler);
    return () => this.onPtyClosedHandlers.delete(handler);
  }

  // ===== Protected overrides =====

  protected handleBinaryMessage(data: ArrayBuffer): void {
    // Binary frames are PTY output - pass directly to handlers
    const bytes = new Uint8Array(data);
    this.notifyData(bytes);
  }

  protected handleTextMessage(data: string): void {
    // Text frames are JSON control messages
    try {
      const message = JSON.parse(data) as IncomingControlEvent;
      this.handleControlMessage(message);
    } catch (error) {
      console.error("Failed to parse control message:", error);
    }
  }

  protected onConnected(): void {
    console.log(`Connected to terminal ${this.sessionId}/${this.ptyId}`);
  }

  protected onDisconnected(): void {
    console.log(`Disconnected from terminal ${this.sessionId}/${this.ptyId}`);
    // Reset turn-taking state on disconnect
    this.turnTaking = {
      controller: "",
      controllerName: undefined,
      isController: false,
      hasPendingRequest: false,
      pendingRequests: [],
      inputBlocked: true,
      inputBlockReason: "not_controller",
    };
    this.notifyTurnTakingChange();
  }

  // ===== Private methods =====

  private handleControlMessage(message: IncomingControlEvent): void {
    switch (message.type) {
      case "control_state":
        this.updateTurnTaking({
          controller: message.controller,
          pendingRequests: message.requests,
        });
        if (message.agent_state) {
          this.updateAgentState(message.agent_state);
        }
        break;

      case "control_taken":
        this.updateTurnTaking({
          controller: message.controller,
          hasPendingRequest: false,
        });
        break;

      case "control_requested":
        this.updateTurnTaking({
          pendingRequests: message.requests,
        });
        break;

      case "control_granted":
        this.updateTurnTaking({
          controller: message.controller,
          hasPendingRequest: false,
        });
        break;

      case "control_revoked":
        this.updateTurnTaking({
          controller: "",
        });
        break;

      case "control_expired":
        this.updateTurnTaking({
          controller: message.controller,
          hasPendingRequest: false,
        });
        break;

      case "agent_state":
        this.updateAgentState(message.agent_state);
        break;

      case "pty_closed":
        this.notifyPtyClosed();
        break;
    }
  }

  private updateTurnTaking(
    updates: Partial<Omit<TurnTakingState, "isController" | "inputBlocked" | "inputBlockReason">>
  ): void {
    const newController = updates.controller ?? this.turnTaking.controller;
    const isController = newController === this.userId;

    // Determine input block reason
    let inputBlocked = false;
    let inputBlockReason: TurnTakingState["inputBlockReason"] = null;

    if (this.agentState === "running") {
      inputBlocked = true;
      inputBlockReason = "agent_running";
    } else if (!isController) {
      inputBlocked = true;
      inputBlockReason = "not_controller";
    }

    this.turnTaking = {
      ...this.turnTaking,
      ...updates,
      controller: newController,
      isController,
      inputBlocked,
      inputBlockReason,
    };

    this.notifyTurnTakingChange();
  }

  private updateAgentState(state: "running" | "paused" | "stopped"): void {
    this.agentState = state;

    // Update input blocking
    if (state === "running") {
      this.turnTaking = {
        ...this.turnTaking,
        inputBlocked: true,
        inputBlockReason: "agent_running",
      };
      this.notifyTurnTakingChange();
    } else if (this.turnTaking.isController) {
      this.turnTaking = {
        ...this.turnTaking,
        inputBlocked: false,
        inputBlockReason: null,
      };
      this.notifyTurnTakingChange();
    }

    this.notifyAgentStateChange();
  }

  private notifyData(data: Uint8Array): void {
    this.onDataHandlers.forEach((handler) => handler(data));
  }

  private notifyTurnTakingChange(): void {
    this.onTurnTakingChangeHandlers.forEach((handler) =>
      handler({ ...this.turnTaking })
    );
  }

  private notifyAgentStateChange(): void {
    this.onAgentStateChangeHandlers.forEach((handler) =>
      handler(this.agentState)
    );
  }

  private notifyPtyClosed(): void {
    this.onPtyClosedHandlers.forEach((handler) => handler());
  }
}
