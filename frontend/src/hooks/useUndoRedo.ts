// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: undo-v1-hook
const MODULE_REVISION = "undo-v1-hook";
console.log(`[useUndoRedo] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import * as React from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DashboardItem, DashboardEdge } from "@/types/dashboard";
import {
  useUndoStore,
  type UndoEntry,
  type UndoPayload,
  type RedoPayload,
} from "@/stores/undo-store";
import { generateId } from "@/lib/utils";

export interface UseUndoRedoOptions {
  dashboardId: string;
  userId: string;
  items: DashboardItem[];
  edges: DashboardEdge[];
  createItemMutation: UseMutationResult<
    DashboardItem,
    Error,
    {
      type: DashboardItem["type"];
      content: string;
      position: { x: number; y: number };
      size: { width: number; height: number };
      metadata?: Record<string, unknown>;
      sourceId?: string;
      sourceHandle?: string;
      targetHandle?: string;
    }
  >;
  updateItemMutation: UseMutationResult<
    DashboardItem,
    Error,
    { itemId: string; changes: Partial<DashboardItem> }
  >;
  deleteItemMutation: UseMutationResult<void, Error, string>;
  createEdgeFn: (edge: {
    sourceItemId: string;
    targetItemId: string;
    sourceHandle?: string;
    targetHandle?: string;
  }) => Promise<void>;
  deleteEdgeFn: (edgeId: string) => Promise<void>;
  handleItemChange: (itemId: string, changes: Partial<DashboardItem>) => void;
}

export function useUndoRedo({
  dashboardId,
  userId,
  items,
  edges,
  createItemMutation,
  updateItemMutation,
  deleteItemMutation,
  createEdgeFn,
  deleteEdgeFn,
  handleItemChange,
}: UseUndoRedoOptions) {
  const store = useUndoStore();
  const isUndoInProgressRef = React.useRef(false);

  // Batch recording: accumulate entries during a batch, commit as one compound entry
  const batchRef = React.useRef<Omit<UndoEntry, "id" | "timestamp" | "userId">[] | null>(null);

  // Keep items/edges refs current for async operations
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  const edgesRef = React.useRef(edges);
  edgesRef.current = edges;

  const executeUndoPayload = React.useCallback(
    async (payload: UndoPayload): Promise<void> => {
      switch (payload.type) {
        case "delete_item": {
          const item = itemsRef.current.find((i) => i.id === payload.itemId);
          if (!item) {
            toast.warning("Item no longer exists");
            return;
          }
          await deleteItemMutation.mutateAsync(payload.itemId);
          break;
        }
        case "create_item": {
          const created = await createItemMutation.mutateAsync({
            type: payload.item.type,
            content: payload.item.content,
            position: payload.item.position,
            size: payload.item.size,
            metadata: payload.item.metadata,
          });
          // The re-created item gets a new server ID; remap all stack entries
          if (created.id !== payload.item.id) {
            store.remapItemId(dashboardId, payload.item.id, created.id);
          }
          // Also re-create any edges that were attached
          if (payload.edges && payload.edges.length > 0) {
            for (const edge of payload.edges) {
              try {
                await createEdgeFn({
                  sourceItemId: edge.sourceItemId === payload.item.id ? created.id : edge.sourceItemId,
                  targetItemId: edge.targetItemId === payload.item.id ? created.id : edge.targetItemId,
                  sourceHandle: edge.sourceHandle,
                  targetHandle: edge.targetHandle,
                });
              } catch {
                // Edge restoration is best-effort (other node may have been deleted)
              }
            }
          }
          break;
        }
        case "update_item": {
          const item = itemsRef.current.find((i) => i.id === payload.itemId);
          if (!item) {
            toast.warning("Item no longer exists");
            return;
          }
          handleItemChange(payload.itemId, payload.before);
          break;
        }
        case "delete_edge": {
          try {
            await deleteEdgeFn(payload.edgeId);
          } catch {
            toast.warning("Edge no longer exists");
          }
          break;
        }
        case "create_edge": {
          await createEdgeFn({
            sourceItemId: payload.edge.sourceItemId,
            targetItemId: payload.edge.targetItemId,
            sourceHandle: payload.edge.sourceHandle,
            targetHandle: payload.edge.targetHandle,
          });
          break;
        }
      }
    },
    [dashboardId, store, createItemMutation, deleteItemMutation, createEdgeFn, deleteEdgeFn, handleItemChange]
  );

  const executeRedoPayload = React.useCallback(
    async (payload: RedoPayload): Promise<void> => {
      switch (payload.type) {
        case "create_item": {
          const created = await createItemMutation.mutateAsync({
            type: payload.item.type,
            content: payload.item.content,
            position: payload.item.position,
            size: payload.item.size,
            metadata: payload.item.metadata,
          });
          // Remap references to any previously-known ID
          if ("dashboardId" in payload.item) {
            const prevId = (payload.item as DashboardItem & { _prevId?: string })._prevId;
            if (prevId && created.id !== prevId) {
              store.remapItemId(dashboardId, prevId, created.id);
            }
          }
          break;
        }
        case "delete_item": {
          const item = itemsRef.current.find((i) => i.id === payload.itemId);
          if (!item) {
            toast.warning("Item no longer exists");
            return;
          }
          await deleteItemMutation.mutateAsync(payload.itemId);
          break;
        }
        case "update_item": {
          const item = itemsRef.current.find((i) => i.id === payload.itemId);
          if (!item) {
            toast.warning("Item no longer exists");
            return;
          }
          handleItemChange(payload.itemId, payload.after);
          break;
        }
        case "create_edge": {
          await createEdgeFn({
            sourceItemId: payload.edge.sourceItemId,
            targetItemId: payload.edge.targetItemId,
            sourceHandle: payload.edge.sourceHandle,
            targetHandle: payload.edge.targetHandle,
          });
          break;
        }
        case "delete_edge": {
          try {
            await deleteEdgeFn(payload.edgeId);
          } catch {
            toast.warning("Edge no longer exists");
          }
          break;
        }
      }
    },
    [dashboardId, store, createItemMutation, deleteItemMutation, createEdgeFn, deleteEdgeFn, handleItemChange]
  );

  const undo = React.useCallback(async () => {
    if (isUndoInProgressRef.current) return;
    const entry = store.popUndo(dashboardId);
    if (!entry) return;

    isUndoInProgressRef.current = true;
    try {
      // Execute primary payload
      await executeUndoPayload(entry.undoData);
      // Execute batch payloads (e.g. multi-select delete restores all items)
      if (entry.batch) {
        for (const b of entry.batch) {
          await executeUndoPayload(b.undoData);
        }
      }
      store.pushRedo(dashboardId, entry);
      toast.info(`Undo: ${entry.description}`);
    } catch (err) {
      toast.error(`Undo failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      // Push entry back so user can retry
      store.pushUndo(dashboardId, entry);
    } finally {
      isUndoInProgressRef.current = false;
    }
  }, [dashboardId, store, executeUndoPayload]);

  const redo = React.useCallback(async () => {
    if (isUndoInProgressRef.current) return;
    const entry = store.popRedo(dashboardId);
    if (!entry) return;

    isUndoInProgressRef.current = true;
    try {
      // Execute primary payload
      await executeRedoPayload(entry.redoData);
      // Execute batch payloads
      if (entry.batch) {
        for (const b of entry.batch) {
          await executeRedoPayload(b.redoData);
        }
      }
      store.pushUndo(dashboardId, entry);
      toast.info(`Redo: ${entry.description}`);
    } catch (err) {
      toast.error(`Redo failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      store.pushRedo(dashboardId, entry);
    } finally {
      isUndoInProgressRef.current = false;
    }
  }, [dashboardId, store, executeRedoPayload]);

  const recordAction = React.useCallback(
    (entry: Omit<UndoEntry, "id" | "timestamp" | "userId">) => {
      // Suppress recording during undo/redo to prevent duplicate entries
      // (e.g. redo re-creates an item, which triggers createItemMutation.onSuccess
      // which would otherwise record another undo entry)
      if (isUndoInProgressRef.current) return;

      // If a batch is open, accumulate instead of pushing immediately
      if (batchRef.current !== null) {
        batchRef.current.push(entry);
        return;
      }

      store.pushUndo(dashboardId, {
        ...entry,
        id: generateId(),
        timestamp: Date.now(),
        userId,
      });
      store.clearRedo(dashboardId);
    },
    [dashboardId, userId, store]
  );

  /** Start accumulating undo entries into a batch */
  const beginBatch = React.useCallback(() => {
    batchRef.current = [];
  }, []);

  /** Commit accumulated batch as a single compound undo entry */
  const commitBatch = React.useCallback(
    (description: string) => {
      const entries = batchRef.current;
      batchRef.current = null;
      if (!entries || entries.length === 0) return;

      if (entries.length === 1) {
        // Single entry, no need for batch wrapper
        store.pushUndo(dashboardId, {
          ...entries[0],
          id: generateId(),
          timestamp: Date.now(),
          userId,
        });
      } else {
        // First entry becomes the primary, rest go into batch array
        const [first, ...rest] = entries;
        store.pushUndo(dashboardId, {
          ...first,
          id: generateId(),
          description,
          timestamp: Date.now(),
          userId,
          batch: rest.map((e) => ({ undoData: e.undoData, redoData: e.redoData })),
        });
      }
      store.clearRedo(dashboardId);
    },
    [dashboardId, userId, store]
  );

  /** Cancel an open batch without committing */
  const cancelBatch = React.useCallback(() => {
    batchRef.current = null;
  }, []);

  // Keyboard shortcuts
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in an input field
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod || e.key.toLowerCase() !== "z") return;

      e.preventDefault();
      if (e.shiftKey) {
        void redo();
      } else {
        void undo();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  // Derive reactive state from store
  const canUndo = store.canUndo(dashboardId);
  const canRedo = store.canRedo(dashboardId);
  const lastAction = store.getLastAction(dashboardId);
  const history = store.getHistory(dashboardId);

  return {
    undo,
    redo,
    recordAction,
    canUndo,
    canRedo,
    lastAction,
    history,
    beginBatch,
    commitBatch,
    cancelBatch,
  };
}
