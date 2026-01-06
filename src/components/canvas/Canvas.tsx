"use client";

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
  type Node,
  type OnNodesChange,
  type OnNodeDrag,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { NoteBlock } from "@/components/blocks/NoteBlock";
import { TodoBlock } from "@/components/blocks/TodoBlock";
import { LinkBlock } from "@/components/blocks/LinkBlock";
import { TerminalBlock } from "@/components/blocks/TerminalBlock";
import { RecipeBlock } from "@/components/blocks/RecipeBlock";
import type { DashboardItem, Session } from "@/types/dashboard";

// Register custom node types
const nodeTypes: NodeTypes = {
  note: NoteBlock,
  todo: TodoBlock,
  link: LinkBlock,
  terminal: TerminalBlock,
  recipe: RecipeBlock,
};

// Convert dashboard items to React Flow nodes
function itemsToNodes(
  items: DashboardItem[],
  sessions: Session[],
  onItemChange?: (itemId: string, changes: Partial<DashboardItem>) => void
): Node[] {
  return items.map((item) => {
    // Find active session for terminal items
    const session = item.type === "terminal"
      ? sessions.find((s) => s.itemId === item.id && s.status === "active")
      : undefined;

    return {
      id: item.id,
      type: item.type,
      position: item.position,
      // React Flow v12 requires width/height on node for drag before measurement
      width: item.size.width,
      height: item.size.height,
      data: {
        content: item.content,
        size: item.size,
        dashboardId: item.dashboardId,
        session, // Pass session to terminal blocks
        onContentChange: onItemChange
          ? (content: string) => onItemChange(item.id, { content })
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
  readOnly?: boolean;
}

export function Canvas({
  items,
  sessions = [],
  onItemChange,
  onItemCreate,
  onItemDelete,
  readOnly = false,
}: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState(
    itemsToNodes(items, sessions, readOnly ? undefined : onItemChange)
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Update nodes when items or sessions change from server
  React.useEffect(() => {
    setNodes(itemsToNodes(items, sessions, readOnly ? undefined : onItemChange));
  }, [items, sessions, setNodes, onItemChange, readOnly]);

  // Handle node changes - apply locally, sync dimensions on resize end
  const handleNodesChange: OnNodesChange = React.useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes);

      // Check for dimension changes (from NodeResizer)
      changes.forEach((change) => {
        if (change.type === "dimensions" && change.resizing === false && onItemChange) {
          // Resize ended - sync to server
          const node = nodes.find((n) => n.id === change.id);
          if (node && change.dimensions) {
            // When resizing from top/left edges, position also changes
            // Include both size and position to keep the correct corner anchored
            onItemChange(change.id, {
              position: node.position,
              size: {
                width: Math.round(change.dimensions.width),
                height: Math.round(change.dimensions.height),
              },
            });
          }
        }
      });
    },
    [onNodesChange, onItemChange, nodes]
  );

  // Handle node drag END - sync to server only when drag stops
  const handleNodeDragStop: OnNodeDrag = React.useCallback(
    (_event, node) => {
      if (onItemChange && node.position) {
        onItemChange(node.id, { position: node.position });
      }
    },
    [onItemChange]
  );

  // Handle node deletion
  const handleNodesDelete = React.useCallback(
    (deletedNodes: Node[]) => {
      if (onItemDelete) {
        deletedNodes.forEach((node) => onItemDelete(node.id));
      }
    },
    [onItemDelete]
  );

  return (
    <div className="w-full h-full bg-[var(--background)]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={handleNodeDragStop}
        onNodesDelete={handleNodesDelete}
        nodeTypes={nodeTypes}
        fitView
        snapToGrid
        snapGrid={[16, 16]}
        nodesDraggable={!readOnly}
        nodesConnectable={false}
        elementsSelectable={!readOnly}
        panOnScroll
        selectionOnDrag
        panOnDrag={[1, 2]} // Middle and right mouse buttons for panning
        selectNodesOnDrag={false}
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

        {/* Zoom controls - bottom left */}
        <Controls
          position="bottom-left"
          showZoom
          showFitView
          showInteractive={false}
          className="canvas-controls"
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
    </div>
  );
}

export default Canvas;
