// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: connected-handles-v1-context
const MODULE_REVISION = "connected-handles-v1-context";
console.log(`[ConnectedHandlesContext] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";

/**
 * Context providing a map of node IDs to their connected handle IDs.
 * Computed once in Canvas from edges, consumed by ConnectionHandles
 * to show secondary (reverse-direction) connectors next to connected handles.
 */
export const ConnectedHandlesContext = React.createContext<Map<string, Set<string>>>(
  new Map()
);

const EMPTY_SET = new Set<string>();

/**
 * Returns the set of handle IDs that have active connections for the given node.
 */
export function useConnectedHandles(nodeId: string): Set<string> {
  const map = React.useContext(ConnectedHandlesContext);
  return map.get(nodeId) ?? EMPTY_SET;
}
