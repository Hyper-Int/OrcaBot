"use client";

import * as React from "react";
import { TerminalWSManager, type TerminalWSConfig } from "@/lib/ws";
import type { ConnectionState } from "@/lib/ws";
import type { TurnTakingState, AgentState } from "@/types/terminal";

export interface UseTerminalOptions {
  sessionId: string;
  ptyId: string;
  userId: string;
  userName: string;
  enabled?: boolean;
}

export interface UseTerminalState {
  connectionState: ConnectionState;
  turnTaking: TurnTakingState;
  agentState: AgentState;
  error: Error | null;
}

export interface UseTerminalActions {
  /** Send text input to the terminal */
  sendInput: (data: string) => boolean;
  /** Send raw bytes to the terminal */
  sendRawInput: (data: Uint8Array) => boolean;
  /** Send resize command */
  sendResize: (cols: number, rows: number) => void;
  /** Take control of the terminal */
  takeControl: () => void;
  /** Request control from current controller */
  requestControl: () => void;
  /** Grant control to another user */
  grantControl: (toUserId: string) => void;
  /** Release control */
  revokeControl: () => void;
  /** Reconnect to the terminal */
  reconnect: () => void;
}

export interface UseTerminalCallbacks {
  /** Called when terminal data is received */
  onData?: (data: Uint8Array) => void;
}

const DEFAULT_TURN_TAKING: TurnTakingState = {
  controller: "",
  controllerName: undefined,
  isController: false,
  hasPendingRequest: false,
  pendingRequests: [],
  inputBlocked: true,
  inputBlockReason: "not_controller",
};

/**
 * Hook for managing terminal WebSocket connection and turn-taking
 */
export function useTerminal(
  options: UseTerminalOptions,
  callbacks?: UseTerminalCallbacks
): [UseTerminalState, UseTerminalActions] {
  const { sessionId, ptyId, userId, userName, enabled = true } = options;

  const managerRef = React.useRef<TerminalWSManager | null>(null);
  const [connectionState, setConnectionState] =
    React.useState<ConnectionState>("disconnected");
  const [turnTaking, setTurnTaking] =
    React.useState<TurnTakingState>(DEFAULT_TURN_TAKING);
  const [agentState, setAgentState] = React.useState<AgentState>(null);
  const [error, setError] = React.useState<Error | null>(null);

  // Store callbacks in ref to avoid re-subscribing
  const callbacksRef = React.useRef(callbacks);
  callbacksRef.current = callbacks;

  // Initialize and manage WebSocket connection
  React.useEffect(() => {
    console.log(`[Terminal] useTerminal effect - enabled: ${enabled}, sessionId: ${sessionId}, ptyId: ${ptyId}, userId: ${userId}`);

    if (!enabled || !sessionId || !ptyId || !userId) {
      console.log(`[Terminal] Skipping connection - missing required params`);
      return;
    }

    console.log(`[Terminal] Creating TerminalWSManager for session ${sessionId}, pty ${ptyId}`);
    const config: TerminalWSConfig = {
      userId,
      userName,
    };

    const manager = new TerminalWSManager(sessionId, ptyId, config);
    managerRef.current = manager;

    // Subscribe to state changes
    const unsubState = manager.onStateChange((state) => {
      console.log(`[Terminal] Connection state changed: ${state}`);
      setConnectionState(state);
    });

    // Subscribe to errors
    const unsubError = manager.onError((err) => {
      console.error(`[Terminal] Error:`, err);
      setError(err);
    });

    // Subscribe to turn-taking changes
    const unsubTurnTaking = manager.onTurnTakingChange((state) => {
      setTurnTaking(state);
    });

    // Subscribe to agent state changes
    const unsubAgentState = manager.onAgentStateChange((state) => {
      setAgentState(state);
    });

    // Subscribe to terminal data
    const unsubData = manager.onData((data) => {
      callbacksRef.current?.onData?.(data);
    });

    // Connect
    manager.connect();

    return () => {
      // Cleanup each subscription with error handling and logging
      const cleanups = [
        { name: 'stateChange', fn: unsubState },
        { name: 'error', fn: unsubError },
        { name: 'turnTaking', fn: unsubTurnTaking },
        { name: 'agentState', fn: unsubAgentState },
        { name: 'data', fn: unsubData },
      ];

      for (const { name, fn } of cleanups) {
        try {
          fn();
        } catch (e) {
          console.error(`[Terminal] Failed to cleanup ${name} subscription:`, e);
        }
      }

      try {
        manager.disconnect();
      } catch (e) {
        console.error('[Terminal] Failed to disconnect manager:', e);
      }

      managerRef.current = null;
    };
  }, [sessionId, ptyId, userId, userName, enabled]);

  // Actions
  const sendInput = React.useCallback((data: string): boolean => {
    return managerRef.current?.sendInput(data) ?? false;
  }, []);

  const sendRawInput = React.useCallback((data: Uint8Array): boolean => {
    return managerRef.current?.sendRawInput(data) ?? false;
  }, []);

  const sendResize = React.useCallback((cols: number, rows: number) => {
    managerRef.current?.sendResize(cols, rows);
  }, []);

  const takeControl = React.useCallback(() => {
    managerRef.current?.takeControl();
  }, []);

  const requestControl = React.useCallback(() => {
    managerRef.current?.requestControl();
  }, []);

  const grantControl = React.useCallback((toUserId: string) => {
    managerRef.current?.grantControl(toUserId);
  }, []);

  const revokeControl = React.useCallback(() => {
    managerRef.current?.revokeControl();
  }, []);

  const reconnect = React.useCallback(() => {
    if (managerRef.current) {
      managerRef.current.disconnect();
      managerRef.current.connect();
    }
  }, []);

  const state: UseTerminalState = {
    connectionState,
    turnTaking,
    agentState,
    error,
  };

  const actions: UseTerminalActions = {
    sendInput,
    sendRawInput,
    sendResize,
    takeControl,
    requestControl,
    grantControl,
    revokeControl,
    reconnect,
  };

  return [state, actions];
}

/**
 * Check if input should be blocked based on turn-taking and agent state
 */
export function shouldBlockInput(
  turnTaking: TurnTakingState,
  agentState: AgentState
): { blocked: boolean; reason: string | null } {
  if (agentState === "running") {
    return { blocked: true, reason: "Agent is running" };
  }
  if (!turnTaking.isController) {
    return { blocked: true, reason: "You don't have control" };
  }
  return { blocked: false, reason: null };
}

/**
 * Get the display status for a terminal
 */
export function getTerminalStatus(
  turnTaking: TurnTakingState,
  agentState: AgentState
): {
  status: "control" | "observing" | "agent";
  label: string;
  color: string;
} {
  if (agentState === "running") {
    return {
      status: "agent",
      label: "Agent running",
      color: "var(--status-control-agent)",
    };
  }
  if (agentState === "paused") {
    return {
      status: "agent",
      label: "Agent paused",
      color: "var(--status-control-agent)",
    };
  }
  if (turnTaking.isController) {
    return {
      status: "control",
      label: "You have control",
      color: "var(--status-control-active)",
    };
  }
  return {
    status: "observing",
    label: turnTaking.controllerName
      ? `${turnTaking.controllerName} has control`
      : "Observing",
    color: "var(--foreground-subtle)",
  };
}
