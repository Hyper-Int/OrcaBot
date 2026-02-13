// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: canvas-v15-fix-resize-jumping
console.log(`[canvas] REVISION: canvas-v15-fix-resize-jumping loaded at ${new Date().toISOString()}`);

import * as React from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  type Edge,
  type EdgeChange,
  type OnNodesChange,
  type OnNodeDrag,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { IntegrationEdge, EdgeLabelClickContext, EdgeDeleteContext, EdgeConnectorModeContext, EdgeReverseContext } from "@/components/canvas/IntegrationEdge";
import { ConnectedHandlesContext } from "@/contexts/ConnectedHandlesContext";

import { NoteBlock } from "@/components/blocks/NoteBlock";
import { TodoBlock } from "@/components/blocks/TodoBlock";
import { LinkBlock } from "@/components/blocks/LinkBlock";
import { TerminalBlock } from "@/components/blocks/TerminalBlock";
import { BrowserBlock } from "@/components/blocks/BrowserBlock";
import { WorkspaceBlock } from "@/components/blocks/WorkspaceBlock";
import { RecipeBlock } from "@/components/blocks/RecipeBlock";
import { PromptBlock } from "@/components/blocks/PromptBlock";
import { ScheduleBlock } from "@/components/blocks/ScheduleBlock";
import { DecisionBlock } from "@/components/blocks/DecisionBlock";
import { GmailBlock } from "@/components/blocks/GmailBlock";
import { CalendarBlock } from "@/components/blocks/CalendarBlock";
import { ContactsBlock } from "@/components/blocks/ContactsBlock";
import { SheetsBlock } from "@/components/blocks/SheetsBlock";
import { FormsBlock } from "@/components/blocks/FormsBlock";
import { SlackBlock } from "@/components/blocks/SlackBlock";
import { DiscordBlock } from "@/components/blocks/DiscordBlock";
import { TelegramBlock } from "@/components/blocks/TelegramBlock";
import { WhatsAppBlock } from "@/components/blocks/WhatsAppBlock";
import { TeamsBlock } from "@/components/blocks/TeamsBlock";
import { MatrixBlock } from "@/components/blocks/MatrixBlock";
import { GoogleChatBlock } from "@/components/blocks/GoogleChatBlock";
import { CursorNode } from "@/components/canvas/CursorNode";
import type { DashboardItem, Session } from "@/types/dashboard";
import type { TerminalHandle } from "@/components/terminal";
import { TerminalOverlayProvider, useTerminalZIndex } from "@/components/terminal";

// Register custom node types
const nodeTypes: NodeTypes = {
  note: NoteBlock,
  todo: TodoBlock,
  link: LinkBlock,
  terminal: TerminalBlock,
  browser: BrowserBlock,
  workspace: WorkspaceBlock,
  recipe: RecipeBlock,
  prompt: PromptBlock,
  schedule: ScheduleBlock,
  decision: DecisionBlock,
  gmail: GmailBlock,
  calendar: CalendarBlock,
  contacts: ContactsBlock,
  sheets: SheetsBlock,
  forms: FormsBlock,
  slack: SlackBlock,
  discord: DiscordBlock,
  telegram: TelegramBlock,
  whatsapp: WhatsAppBlock,
  teams: TeamsBlock,
  matrix: MatrixBlock,
  google_chat: GoogleChatBlock,
  cursor: CursorNode,
};

// Register custom edge types
const edgeTypes: EdgeTypes = {
  integration: IntegrationEdge,
};

// Convert dashboard items to React Flow nodes
function itemsToNodes(
  items: DashboardItem[],
  sessions: Session[],
  onItemChange?: (itemId: string, changes: Partial<DashboardItem>) => void,
  onRegisterTerminal?: (itemId: string, handle: TerminalHandle | null) => void,
  onCreateBrowserBlock?: (
    url: string,
    anchor?: { x: number; y: number },
    sourceId?: string
  ) => void,
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void,
  connectorMode?: boolean,
  onPolicyUpdate?: (terminalItemId: string, provider: string, securityLevel: string) => void,
  onIntegrationAttached?: (terminalItemId: string, provider: string, securityLevel: string) => void,
  onIntegrationDetached?: (terminalItemId: string, provider: string) => void,
  onStorageLinked?: (workspaceItemId: string, provider: "google_drive" | "onedrive" | "box" | "github") => void,
  onStorageDisconnected?: (provider: "google_drive" | "onedrive" | "box" | "github") => void,
  onDuplicate?: (itemId: string) => void,
  onTerminalCwdChange?: (itemId: string, cwd: string) => void
): Node[] {
  const workspaceSession =
    sessions.find((s) => s.status === "active")
    ?? sessions.find((s) => s.status === "creating")
    ?? sessions[0];
  return items.map((item) => {
    // Find active session for terminal items
    const session = item.type === "terminal"
      ? sessions.find((s) => s.itemId === item.id && s.status === "active")
      : undefined;

    // Use _stableKey for React reconciliation to prevent remounting when temp ID transitions to real ID
    const nodeId = item._stableKey || item.id;

    // Extract color from metadata for notes
    const color = item.type === "note" && item.metadata?.color
      ? item.metadata.color as string
      : undefined;

    return {
      id: nodeId,
      type: item.type,
      position: item.position,
      // React Flow v12 requires width/height on node for drag before measurement
      width: item.size.width,
      height: item.size.height,
      data: {
        content: item.content,
        size: item.size,
        dashboardId: item.dashboardId,
        itemId: item.id, // Pass actual item ID for API calls
        session, // Pass session to terminal blocks
        sessionId: item.type === "workspace" ? workspaceSession?.id : undefined,
        color, // Note color from metadata
        metadata: item.metadata, // Pass full metadata for type-specific use
        onRegisterTerminal,
        onCreateBrowserBlock,
        onConnectorClick,
        connectorMode,
        onItemChange: onItemChange
          ? (changes: Partial<DashboardItem>) => onItemChange(item.id, changes)
          : undefined,
        onContentChange: onItemChange
          ? (content: string) => onItemChange(item.id, { content })
          : undefined,
        // For terminal blocks: callback to update edge data when policy changes
        onPolicyUpdate: item.type === "terminal" && onPolicyUpdate
          ? (provider: string, securityLevel: string) => onPolicyUpdate(item.id, provider, securityLevel)
          : undefined,
        // For terminal blocks: callback to create integration block after attaching
        onIntegrationAttached: item.type === "terminal" && onIntegrationAttached
          ? (provider: string, securityLevel: string) => onIntegrationAttached(item.id, provider, securityLevel)
          : undefined,
        // For terminal blocks: callback to remove integration block after detaching
        onIntegrationDetached: item.type === "terminal" && onIntegrationDetached
          ? (provider: string) => onIntegrationDetached(item.id, provider)
          : undefined,
        // For workspace blocks: callback when cloud storage is linked
        onStorageLinked: item.type === "workspace" && onStorageLinked
          ? (provider: "google_drive" | "onedrive" | "box" | "github") => onStorageLinked(item.id, provider)
          : undefined,
        // For workspace blocks: callback when cloud storage is disconnected
        onStorageDisconnected: item.type === "workspace" ? onStorageDisconnected : undefined,
        // Duplicate this block
        onDuplicate: onDuplicate ? () => onDuplicate(item.id) : undefined,
        // Terminal cwd change
        onCwdChange: item.type === "terminal" && onTerminalCwdChange
          ? (cwd: string) => onTerminalCwdChange(item.id, cwd)
          : undefined,
      },
      style: {
        width: item.size.width,
        height: item.size.height,
      },
    };
  });
}

interface CanvasProps {
  items: DashboardItem[];
  sessions?: Session[];
  onItemChange?: (itemId: string, changes: Partial<DashboardItem>) => void;
  onItemCreate?: (item: Omit<DashboardItem, "id" | "createdAt" | "updatedAt">) => void;
  onItemDelete?: (itemId: string) => void;
  /** Called when multiple items are deleted at once (e.g. multi-select delete) */
  onItemsDelete?: (itemIds: string[]) => void;
  onCreateBrowserBlock?: (url: string, anchor?: { x: number; y: number }, sourceId?: string) => void;
  onViewportChange?: (viewport: { x: number; y: number; zoom: number }) => void;
  onCursorMove?: (point: { x: number; y: number }) => void;
  onCanvasClick?: () => void;
  onConnectorClick?: (nodeId: string, handleId: string, kind: "source" | "target") => void;
  connectorMode?: boolean;
  fitViewEnabled?: boolean;
  edges?: Edge[];
  onEdgesChange?: (changes: EdgeChange[]) => void;
  readOnly?: boolean;
  extraNodes?: Node[];
  /** Called when a terminal's integration policy is updated, to sync edge data */
  onPolicyUpdate?: (terminalItemId: string, provider: string, securityLevel: string) => void;
  /** Called when an integration is attached via IntegrationsPanel, to auto-create block */
  onIntegrationAttached?: (terminalItemId: string, provider: string, securityLevel: string) => void;
  /** Called when an integration is detached via IntegrationsPanel, to remove block + edge */
  onIntegrationDetached?: (terminalItemId: string, provider: string) => void;
  /** Called when cloud storage is linked to workspace, to auto-attach to connected terminals */
  onStorageLinked?: (workspaceItemId: string, provider: "google_drive" | "onedrive" | "box" | "github") => void;
  /** Called when cloud storage is disconnected, to invalidate caches */
  onStorageDisconnected?: (provider: "google_drive" | "onedrive" | "box" | "github") => void;
  /** Called when a block wants to duplicate itself */
  onDuplicate?: (itemId: string) => void;
  /** Called when an edge label is clicked, to open policy editor */
  onEdgeLabelClick?: (edgeId: string, provider: string) => void;
  /** Called when an edge delete button is clicked */
  onEdgeDelete?: (edgeId: string) => void;
  /** Called when the reverse-connection button is clicked on an edge */
  onEdgeReverse?: (edgeId: string) => void;
  /** Called when a drag completes, with before/after positions for undo */
  onDragComplete?: (itemId: string, before: { x: number; y: number }, after: { x: number; y: number }) => void;
  /** Called when drag state changes (start/stop) */
  onDragStateChange?: (dragging: boolean) => void;
  /** Called when a resize completes, with before/after position+size for undo */
  onResizeComplete?: (itemId: string, before: { position: { x: number; y: number }; size: { width: number; height: number } }, after: { position: { x: number; y: number }; size: { width: number; height: number } }) => void;
  /** Called when a terminal's working directory changes */
  onTerminalCwdChange?: (itemId: string, cwd: string) => void;
  /** Ref populated with the ReactFlow instance for programmatic viewport control */
  reactFlowRef?: React.MutableRefObject<ReactFlowInstance | null>;
}

export function Canvas({
  items,
  sessions = [],
  onItemChange,
  onItemCreate,
  onItemDelete,
  onItemsDelete,
  onCreateBrowserBlock,
  onViewportChange,
  onCursorMove,
  onCanvasClick,
  onConnectorClick,
  connectorMode = false,
  fitViewEnabled = true,
  edges: controlledEdges,
  onEdgesChange: onEdgesChangeProp,
  readOnly = false,
  extraNodes = [],
  onPolicyUpdate,
  onIntegrationAttached,
  onIntegrationDetached,
  onStorageLinked,
  onStorageDisconnected,
  onDuplicate,
  onEdgeLabelClick,
  onEdgeDelete,
  onEdgeReverse,
  onDragComplete,
  onDragStateChange,
  onResizeComplete,
  onTerminalCwdChange,
  reactFlowRef,
}: CanvasProps) {
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const [overlayRoot, setOverlayRoot] = React.useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = React.useState({ x: 0, y: 0, zoom: 1 });
  const instanceRef = React.useRef<ReactFlowInstance | null>(null);
  const { zIndexVersion, bringToFront, getZIndex } = useTerminalZIndex();
  const terminalRefs = React.useRef<Map<string, TerminalHandle>>(new Map());
  const applyZIndex = React.useCallback(
    (nextNodes: Node[]) =>
      nextNodes.map((node) => {
        const base = getZIndex(node.id);
        const zIndex = node.type === "browser"
          ? base + 12000
          : node.type === "terminal"
            ? base + 10000
            : base;
        return {
          ...node,
          style: {
            ...node.style,
            zIndex,
          },
        };
      }),
    [getZIndex]
  );
  const initialNodes = React.useMemo(() => {
    const baseNodes = applyZIndex(
      itemsToNodes(
        items,
        sessions,
        readOnly ? undefined : onItemChange,
        (itemId, handle) => {
          if (handle) {
            terminalRefs.current.set(itemId, handle);
          } else {
            terminalRefs.current.delete(itemId);
          }
        },
        onCreateBrowserBlock,
        onConnectorClick,
        connectorMode,
        onPolicyUpdate,
        onIntegrationAttached,
        onIntegrationDetached,
        onStorageLinked,
        onStorageDisconnected,
        readOnly ? undefined : onDuplicate,
        onTerminalCwdChange
      )
    );
    return [...baseNodes, ...extraNodes];
  }, []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, , onEdgesChange] = useEdgesState<Edge>([]);
  const edgesToRender = controlledEdges ?? edges;
  const edgesChangeHandler = controlledEdges ? onEdgesChangeProp : onEdgesChange;

  // Track previous item IDs to detect new items
  const prevItemIdsRef = React.useRef<Set<string>>(new Set(items.map(i => i._stableKey || i.id)));

  // Track whether a drag or resize is in progress to prevent node rebuilds mid-interaction
  const isDraggingRef = React.useRef(false);
  const isResizingRef = React.useRef(false);
  const pendingNodeRebuildRef = React.useRef(false);

  // Track drag start position for undo
  const dragStartPositionRef = React.useRef<{ x: number; y: number } | null>(null);
  // Track resize start state for undo
  const resizeStartRef = React.useRef<{ itemId: string; position: { x: number; y: number }; size: { width: number; height: number } } | null>(null);

  // Rebuild nodes from items - extracted so it can be called from effect and drag-stop
  const rebuildNodes = React.useCallback(() => {
    // Detect new items and bring them to front
    const currentIds = new Set(items.map(i => i._stableKey || i.id));
    const prevIds = prevItemIdsRef.current;
    items.forEach(item => {
      const nodeId = item._stableKey || item.id;
      if (!prevIds.has(nodeId)) {
        bringToFront(nodeId);
      }
    });
    prevItemIdsRef.current = currentIds;

    const baseNodes = applyZIndex(
      itemsToNodes(
        items,
        sessions,
        readOnly ? undefined : onItemChange,
        (itemId, handle) => {
          if (handle) {
            terminalRefs.current.set(itemId, handle);
          } else {
            terminalRefs.current.delete(itemId);
          }
        },
        onCreateBrowserBlock,
        onConnectorClick,
        connectorMode,
        onPolicyUpdate,
        onIntegrationAttached,
        onIntegrationDetached,
        onStorageLinked,
        onStorageDisconnected,
        readOnly ? undefined : onDuplicate,
        onTerminalCwdChange
      )
    );
    // Preserve selection state from current nodes when rebuilding
    setNodes((currentNodes) => {
      const selectedIds = new Set(currentNodes.filter(n => n.selected).map(n => n.id));
      const newNodes = [...baseNodes, ...extraNodes];
      if (selectedIds.size === 0) return newNodes;
      return newNodes.map(n => selectedIds.has(n.id) ? { ...n, selected: true } : n);
    });
  }, [items, sessions, setNodes, onItemChange, readOnly, onCreateBrowserBlock, onConnectorClick, connectorMode, applyZIndex, extraNodes, bringToFront, onPolicyUpdate, onIntegrationAttached, onIntegrationDetached, onStorageLinked, onStorageDisconnected, onDuplicate, onTerminalCwdChange]);

  // Update nodes when items or sessions change from server
  // Deferred during active drag to prevent mid-drag position jumps
  React.useEffect(() => {
    if (isDraggingRef.current || isResizingRef.current) {
      pendingNodeRebuildRef.current = true;
      return;
    }
    rebuildNodes();
  }, [rebuildNodes]);

  React.useEffect(() => {
    setNodes((current) => applyZIndex(current));
  }, [applyZIndex, setNodes, zIndexVersion]);

  // Handle node changes - apply locally, sync dimensions on resize end
  const handleNodesChange: OnNodesChange = React.useCallback(
    (changes: NodeChange[]) => {
      changes.forEach((change) => {
        if (change.type === "select" && change.selected) {
          bringToFront(change.id);
        }
      });

      onNodesChange(changes);

      // Check for dimension changes (from NodeResizer)
      changes.forEach((change) => {
        if (change.type === "dimensions") {
          // Capture resize start state for undo on first resize event
          if (change.resizing === true && !resizeStartRef.current) {
            isResizingRef.current = true;
            const node = nodes.find((n) => n.id === change.id);
            if (node) {
              const itemId = (node.data as { itemId?: string })?.itemId || node.id;
              resizeStartRef.current = {
                itemId,
                position: { ...node.position },
                size: {
                  width: Math.round(node.measured?.width ?? node.width ?? 200),
                  height: Math.round(node.measured?.height ?? node.height ?? 120),
                },
              };
            }
          }

          if (change.resizing === false) {
            isResizingRef.current = false;

            if (onItemChange) {
              // Resize ended - sync to server
              const node = nodes.find((n) => n.id === change.id);
              if (node && change.dimensions) {
                // Use itemId (real ID) for API calls, not node.id (which may be stable key)
                const itemId = (node.data as { itemId?: string })?.itemId || node.id;
                const afterSize = {
                  width: Math.round(change.dimensions.width),
                  height: Math.round(change.dimensions.height),
                };
                // When resizing from top/left edges, position also changes
                // Include both size and position to keep the correct corner anchored
                onItemChange(itemId, {
                  position: node.position,
                  size: afterSize,
                });

                // Notify parent of completed resize for undo recording
                if (onResizeComplete && resizeStartRef.current && resizeStartRef.current.itemId === itemId) {
                  onResizeComplete(
                    itemId,
                    { position: resizeStartRef.current.position, size: resizeStartRef.current.size },
                    { position: { ...node.position }, size: afterSize }
                  );
                }
              }
            }
            resizeStartRef.current = null;

            // Flush any node rebuilds that were deferred during the resize
            if (pendingNodeRebuildRef.current) {
              pendingNodeRebuildRef.current = false;
              requestAnimationFrame(() => {
                if (!isDraggingRef.current && !isResizingRef.current) {
                  rebuildNodes();
                }
              });
            }

            if (nodes.find((n) => n.id === change.id)?.type === "terminal") {
              terminalRefs.current.get(change.id)?.fit();
            }
          }
        }
      });
    },
    [onNodesChange, onItemChange, onResizeComplete, nodes, bringToFront, rebuildNodes]
  );

  const handleNodeDragStart: OnNodeDrag = React.useCallback(
    (_event, node) => {
      isDraggingRef.current = true;
      onDragStateChange?.(true);
      bringToFront(node.id);
      // Capture position before drag for undo
      dragStartPositionRef.current = node.position ? { ...node.position } : null;
    },
    [bringToFront, onDragStateChange]
  );

  // Handle node drag END - sync to server only when drag stops
  const handleNodeDragStop: OnNodeDrag = React.useCallback(
    (_event, node) => {
      isDraggingRef.current = false;
      onDragStateChange?.(false);

      if (onItemChange && node.position) {
        // Use itemId (real ID) for API calls, not node.id (which may be stable key)
        const itemId = (node.data as { itemId?: string })?.itemId || node.id;
        onItemChange(itemId, { position: node.position });

        // Notify parent of completed drag for undo recording
        if (onDragComplete && dragStartPositionRef.current) {
          const before = dragStartPositionRef.current;
          const after = { x: node.position.x, y: node.position.y };
          if (before.x !== after.x || before.y !== after.y) {
            onDragComplete(itemId, before, after);
          }
        }
      }
      dragStartPositionRef.current = null;

      // Flush any node rebuilds that were deferred during the drag
      if (pendingNodeRebuildRef.current) {
        pendingNodeRebuildRef.current = false;
        // Defer rebuild to next frame to allow item cache updates to land
        requestAnimationFrame(() => {
          if (!isDraggingRef.current) {
            rebuildNodes();
          }
        });
      }

      if (node.type === "terminal") {
        terminalRefs.current.get(node.id)?.fit();
      }
    },
    [onItemChange, onDragComplete, rebuildNodes, onDragStateChange]
  );

  // Handle node deletion
  const handleNodesDelete = React.useCallback(
    (deletedNodes: Node[]) => {
      // Use itemId (real ID) for API calls, not node.id (which may be stable key)
      const itemIds = deletedNodes.map((node) =>
        (node.data as { itemId?: string })?.itemId || node.id
      );

      // Multi-select delete: call batch callback if available
      if (itemIds.length > 1 && onItemsDelete) {
        onItemsDelete(itemIds);
      } else if (onItemDelete) {
        itemIds.forEach((id) => onItemDelete(id));
      }
    },
    [onItemDelete, onItemsDelete]
  );

  React.useLayoutEffect(() => {
    if (overlayRef.current) {
      setOverlayRoot(overlayRef.current);
    }
  }, []);

  const handleInit = React.useCallback((instance: ReactFlowInstance) => {
    instanceRef.current = instance;
    if (reactFlowRef) reactFlowRef.current = instance;
    const nextViewport = instance.getViewport();
    setViewport(nextViewport);
    onViewportChange?.(nextViewport);
  }, [onViewportChange, reactFlowRef]);

  const handlePaneMouseMove = React.useCallback(
    (event: React.MouseEvent) => {
      if (!onCursorMove || !instanceRef.current) return;
      const point = instanceRef.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      onCursorMove(point);
    },
    [onCursorMove]
  );

  const overlayContextValue = React.useMemo(
    () => ({ root: overlayRoot, viewport, zIndexVersion, bringToFront, getZIndex }),
    [overlayRoot, viewport, zIndexVersion, bringToFront, getZIndex]
  );

  // Compute which handles are connected per node (for secondary connector rendering)
  const connectedHandlesMap = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of edgesToRender) {
      if (edge.sourceHandle) {
        if (!map.has(edge.source)) map.set(edge.source, new Set());
        map.get(edge.source)!.add(edge.sourceHandle);
      }
      if (edge.targetHandle) {
        if (!map.has(edge.target)) map.set(edge.target, new Set());
        map.get(edge.target)!.add(edge.targetHandle);
      }
    }
    return map;
  }, [edgesToRender]);

  return (
    <TerminalOverlayProvider value={overlayContextValue}>
      <ConnectedHandlesContext.Provider value={connectedHandlesMap}>
      <EdgeConnectorModeContext.Provider value={connectorMode}>
      <EdgeDeleteContext.Provider value={onEdgeDelete ?? null}>
      <EdgeLabelClickContext.Provider value={onEdgeLabelClick ?? null}>
      <EdgeReverseContext.Provider value={onEdgeReverse ?? null}>
      <div
        className="w-full h-full bg-[var(--background)] relative"
        onMouseMoveCapture={handlePaneMouseMove}
      >
        <ReactFlow
          nodes={nodes}
          edges={edgesToRender}
          onNodesChange={handleNodesChange}
          onEdgesChange={edgesChangeHandler}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onNodesDelete={handleNodesDelete}
          onInit={handleInit}
          onPaneMouseMove={handlePaneMouseMove}
          onPaneClick={() => onCanvasClick?.()}
          onNodeClick={(event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest(".react-flow__handle")) return;
            if (target?.closest("[data-connector=\"true\"]")) return;
            onCanvasClick?.();
          }}
          onMove={(_event, nextViewport) => {
            setViewport(nextViewport);
            onViewportChange?.(nextViewport);
          }}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView={fitViewEnabled}
          fitViewOptions={{ maxZoom: 0.75 }}
          snapToGrid
          snapGrid={[16, 16]}
          nodesDraggable={!readOnly}
          nodesConnectable={false}
          elementsSelectable={!readOnly}
          panOnScroll
          selectionOnDrag
          panOnDrag={[1, 2]} // Middle and right mouse buttons for panning
          selectNodesOnDrag={false}
          autoPanOnNodeDrag={false}
          deleteKeyCode={["Backspace", "Delete"]}
          className="canvas-flow"
          proOptions={{ hideAttribution: true }}
          nodeDragThreshold={1}
        >
        {/* Dot grid background */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={16}
          size={1}
          color="var(--border)"
          className="bg-[var(--background)]"
        />

        {/* Zoom controls - bottom right, left of minimap */}
        <Controls
          position="bottom-right"
          showZoom
          showFitView
          showInteractive={false}
          className="canvas-controls"
          style={{ right: 210 }}
        />

        {/* Minimap - bottom right */}
        <MiniMap
          position="bottom-right"
          nodeColor={(node) => {
            switch (node.type) {
              case "terminal":
                return "var(--status-control-active)";
              case "note":
                return "var(--status-info)";
              case "todo":
                return "var(--accent-primary)";
              case "workspace":
                return "var(--foreground-muted)";
              case "recipe":
                return "var(--status-control-agent)";
              default:
                return "var(--foreground-muted)";
            }
          }}
          maskColor="rgba(0, 0, 0, 0.8)"
          className="canvas-minimap"
        />
        </ReactFlow>

        <div
          ref={overlayRef}
          className="absolute inset-0 z-10 pointer-events-none"
        />
      </div>
      </EdgeReverseContext.Provider>
      </EdgeLabelClickContext.Provider>
      </EdgeDeleteContext.Provider>
      </EdgeConnectorModeContext.Provider>
      </ConnectedHandlesContext.Provider>
    </TerminalOverlayProvider>
  );
}

export default Canvas;
