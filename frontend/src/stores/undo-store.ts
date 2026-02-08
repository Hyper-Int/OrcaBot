// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: undo-v1-store
const MODULE_REVISION = "undo-v1-store";
console.log(`[undo-store] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { create } from "zustand";
import type { DashboardItem, DashboardEdge } from "@/types/dashboard";

// ===== Types =====

export type UndoActionType =
  | "create_item"
  | "delete_item"
  | "update_item"
  | "create_edge"
  | "delete_edge";

/**
 * Data needed to reverse an action
 */
export type UndoPayload =
  | { type: "delete_item"; itemId: string }
  | { type: "create_item"; item: DashboardItem; edges?: DashboardEdge[] }
  | { type: "update_item"; itemId: string; before: Partial<DashboardItem> }
  | { type: "delete_edge"; edgeId: string }
  | { type: "create_edge"; edge: Omit<DashboardEdge, "id" | "createdAt" | "updatedAt"> };

/**
 * Data needed to replay an action
 */
export type RedoPayload =
  | { type: "create_item"; item: Pick<DashboardItem, "type" | "content" | "position" | "size" | "metadata" | "dashboardId"> }
  | { type: "delete_item"; itemId: string }
  | { type: "update_item"; itemId: string; after: Partial<DashboardItem> }
  | { type: "create_edge"; edge: Omit<DashboardEdge, "id" | "createdAt" | "updatedAt"> }
  | { type: "delete_edge"; edgeId: string };

export interface UndoEntry {
  id: string;
  type: UndoActionType;
  description: string;
  timestamp: number;
  userId: string;
  undoData: UndoPayload;
  redoData: RedoPayload;
  /** For batch operations: additional undo/redo payloads executed together */
  batch?: { undoData: UndoPayload; redoData: RedoPayload }[];
}

// ===== Store =====

const MAX_STACK_SIZE = 50;

interface DashboardStacks {
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
}

interface UndoState {
  stacks: Record<string, DashboardStacks>;
}

interface UndoActions {
  pushUndo: (dashboardId: string, entry: UndoEntry) => void;
  popUndo: (dashboardId: string) => UndoEntry | undefined;
  pushRedo: (dashboardId: string, entry: UndoEntry) => void;
  popRedo: (dashboardId: string) => UndoEntry | undefined;
  clearRedo: (dashboardId: string) => void;
  clearAll: (dashboardId: string) => void;
  canUndo: (dashboardId: string) => boolean;
  canRedo: (dashboardId: string) => boolean;
  peekUndo: (dashboardId: string) => UndoEntry | undefined;
  peekRedo: (dashboardId: string) => UndoEntry | undefined;
  getLastAction: (dashboardId: string) => UndoEntry | undefined;
  getHistory: (dashboardId: string, limit?: number) => UndoEntry[];
  remapItemId: (dashboardId: string, oldId: string, newId: string) => void;
}

function getStacks(state: UndoState, dashboardId: string): DashboardStacks {
  return state.stacks[dashboardId] || { undoStack: [], redoStack: [] };
}

/**
 * Walk an UndoPayload and remap any item ID references from oldId to newId
 */
function remapPayload<T extends UndoPayload | RedoPayload>(payload: T, oldId: string, newId: string): T {
  // Handle itemId fields
  if ("itemId" in payload && payload.itemId === oldId) {
    return { ...payload, itemId: newId };
  }
  // Handle nested item objects
  if ("item" in payload && payload.item && "id" in payload.item && (payload.item as DashboardItem).id === oldId) {
    return { ...payload, item: { ...payload.item, id: newId } };
  }
  // Handle edge references
  if ("edge" in payload && payload.edge) {
    const edge = payload.edge;
    if ("sourceItemId" in edge || "targetItemId" in edge) {
      const mapped = { ...edge } as Record<string, unknown>;
      if ("sourceItemId" in edge && edge.sourceItemId === oldId) mapped.sourceItemId = newId;
      if ("targetItemId" in edge && edge.targetItemId === oldId) mapped.targetItemId = newId;
      return { ...payload, edge: mapped } as T;
    }
  }
  // Handle edges arrays (for delete_item undo with attached edges)
  if ("edges" in payload && Array.isArray((payload as UndoPayload & { edges?: DashboardEdge[] }).edges)) {
    const p = payload as UndoPayload & { edges: DashboardEdge[] };
    const remapped = p.edges.map((e) => ({
      ...e,
      sourceItemId: e.sourceItemId === oldId ? newId : e.sourceItemId,
      targetItemId: e.targetItemId === oldId ? newId : e.targetItemId,
    }));
    return { ...payload, edges: remapped } as T;
  }
  return payload;
}

function remapEntry(entry: UndoEntry, oldId: string, newId: string): UndoEntry {
  return {
    ...entry,
    undoData: remapPayload(entry.undoData, oldId, newId),
    redoData: remapPayload(entry.redoData, oldId, newId),
    batch: entry.batch?.map((b) => ({
      undoData: remapPayload(b.undoData, oldId, newId),
      redoData: remapPayload(b.redoData, oldId, newId),
    })),
  };
}

export const useUndoStore = create<UndoState & UndoActions>()((set, get) => ({
  stacks: {},

  pushUndo: (dashboardId, entry) => {
    set((state) => {
      const { undoStack, redoStack } = getStacks(state, dashboardId);
      const nextUndo = [...undoStack, entry];
      // FIFO eviction if over limit
      if (nextUndo.length > MAX_STACK_SIZE) {
        nextUndo.shift();
      }
      return {
        stacks: {
          ...state.stacks,
          [dashboardId]: { undoStack: nextUndo, redoStack },
        },
      };
    });
  },

  popUndo: (dashboardId) => {
    const { undoStack } = getStacks(get(), dashboardId);
    if (undoStack.length === 0) return undefined;
    const entry = undoStack[undoStack.length - 1];
    set((state) => {
      const stacks = getStacks(state, dashboardId);
      return {
        stacks: {
          ...state.stacks,
          [dashboardId]: {
            undoStack: stacks.undoStack.slice(0, -1),
            redoStack: stacks.redoStack,
          },
        },
      };
    });
    return entry;
  },

  pushRedo: (dashboardId, entry) => {
    set((state) => {
      const { undoStack, redoStack } = getStacks(state, dashboardId);
      const nextRedo = [...redoStack, entry];
      if (nextRedo.length > MAX_STACK_SIZE) {
        nextRedo.shift();
      }
      return {
        stacks: {
          ...state.stacks,
          [dashboardId]: { undoStack, redoStack: nextRedo },
        },
      };
    });
  },

  popRedo: (dashboardId) => {
    const { redoStack } = getStacks(get(), dashboardId);
    if (redoStack.length === 0) return undefined;
    const entry = redoStack[redoStack.length - 1];
    set((state) => {
      const stacks = getStacks(state, dashboardId);
      return {
        stacks: {
          ...state.stacks,
          [dashboardId]: {
            undoStack: stacks.undoStack,
            redoStack: stacks.redoStack.slice(0, -1),
          },
        },
      };
    });
    return entry;
  },

  clearRedo: (dashboardId) => {
    set((state) => {
      const stacks = getStacks(state, dashboardId);
      if (stacks.redoStack.length === 0) return state;
      return {
        stacks: {
          ...state.stacks,
          [dashboardId]: { undoStack: stacks.undoStack, redoStack: [] },
        },
      };
    });
  },

  clearAll: (dashboardId) => {
    set((state) => ({
      stacks: {
        ...state.stacks,
        [dashboardId]: { undoStack: [], redoStack: [] },
      },
    }));
  },

  canUndo: (dashboardId) => {
    const { undoStack } = getStacks(get(), dashboardId);
    return undoStack.length > 0;
  },

  canRedo: (dashboardId) => {
    const { redoStack } = getStacks(get(), dashboardId);
    return redoStack.length > 0;
  },

  peekUndo: (dashboardId) => {
    const { undoStack } = getStacks(get(), dashboardId);
    return undoStack.length > 0 ? undoStack[undoStack.length - 1] : undefined;
  },

  peekRedo: (dashboardId) => {
    const { redoStack } = getStacks(get(), dashboardId);
    return redoStack.length > 0 ? redoStack[redoStack.length - 1] : undefined;
  },

  getLastAction: (dashboardId) => {
    const { undoStack } = getStacks(get(), dashboardId);
    return undoStack.length > 0 ? undoStack[undoStack.length - 1] : undefined;
  },

  getHistory: (dashboardId, limit = 20) => {
    const { undoStack } = getStacks(get(), dashboardId);
    // Return most recent first
    return undoStack.slice(-limit).reverse();
  },

  remapItemId: (dashboardId, oldId, newId) => {
    set((state) => {
      const stacks = getStacks(state, dashboardId);
      return {
        stacks: {
          ...state.stacks,
          [dashboardId]: {
            undoStack: stacks.undoStack.map((e) => remapEntry(e, oldId, newId)),
            redoStack: stacks.redoStack.map((e) => remapEntry(e, oldId, newId)),
          },
        },
      };
    });
  },
}));
