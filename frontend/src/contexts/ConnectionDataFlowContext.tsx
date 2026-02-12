// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import type { Edge } from "@xyflow/react";

/**
 * Payload sent through connections
 */
export interface DataPayload {
  text: string;
  execute?: boolean; // Whether to auto-execute (e.g., press Enter in terminal)
  newSession?: boolean; // Clear agent session before sending (e.g., /clear for Claude, /new for Codex)
}

type InputHandler = (payload: DataPayload) => void;

interface ConnectionDataFlowContextValue {
  /**
   * Fire data through an output connector to all connected targets
   */
  fireOutput: (sourceNodeId: string, sourceHandle: string, payload: DataPayload) => void;
  /**
   * Register a handler for incoming data on a specific connector
   * Returns a cleanup function to unregister
   */
  registerInputHandler: (
    nodeId: string,
    handleId: string,
    handler: InputHandler
  ) => () => void;
}

const ConnectionDataFlowContext = React.createContext<ConnectionDataFlowContextValue | null>(null);

interface ConnectionDataFlowProviderProps {
  children: React.ReactNode;
  edges: Edge[];
}

export function ConnectionDataFlowProvider({
  children,
  edges,
}: ConnectionDataFlowProviderProps) {
  // Map of "nodeId:handleId" -> handler (single handler per connector)
  const handlersRef = React.useRef<Map<string, InputHandler>>(new Map());

  const registerInputHandler = React.useCallback(
    (nodeId: string, handleId: string, handler: InputHandler) => {
      const key = `${nodeId}:${handleId}`;
      handlersRef.current.set(key, handler);

      // Return cleanup function
      return () => {
        // Only delete if it's still the same handler (prevents race conditions)
        if (handlersRef.current.get(key) === handler) {
          handlersRef.current.delete(key);
        }
      };
    },
    []
  );

  const fireOutput = React.useCallback(
    (sourceNodeId: string, sourceHandle: string, payload: DataPayload) => {
      // Find unique target nodes (dedupe by target + handle)
      const seenTargets = new Set<string>();

      for (const edge of edges) {
        if (edge.source !== sourceNodeId || edge.sourceHandle !== sourceHandle) {
          continue;
        }

        const targetNodeId = edge.target;
        const targetHandle = edge.targetHandle;
        if (!targetHandle) continue;

        const targetKey = `${targetNodeId}:${targetHandle}`;
        if (seenTargets.has(targetKey)) continue;
        seenTargets.add(targetKey);

        const handler = handlersRef.current.get(targetKey);
        if (!handler) continue;

        try {
          handler(payload);
        } catch (error) {
          console.error(
            `Error in connection handler for ${targetKey}`,
            error
          );
        }
      }
    },
    [edges]
  );

  const value = React.useMemo(
    () => ({ fireOutput, registerInputHandler }),
    [fireOutput, registerInputHandler]
  );

  return (
    <ConnectionDataFlowContext.Provider value={value}>
      {children}
    </ConnectionDataFlowContext.Provider>
  );
}

/**
 * Hook to access connection data flow context
 */
export function useConnectionDataFlow() {
  return React.useContext(ConnectionDataFlowContext);
}
