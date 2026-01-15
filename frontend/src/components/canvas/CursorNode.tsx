"use client";

import * as React from "react";
import { Handle, Position } from "@xyflow/react";

export function CursorNode() {
  return (
    <>
      <Handle
        type="source"
        id="cursor-source-top"
        position={Position.Top}
        className="opacity-0"
        style={{ left: 0, top: 0, transform: "translate(-50%, -50%)" }}
      />
      <Handle
        type="source"
        id="cursor-source-right"
        position={Position.Right}
        className="opacity-0"
        style={{ left: 0, top: 0, transform: "translate(-50%, -50%)" }}
      />
      <Handle
        type="source"
        id="cursor-source-bottom"
        position={Position.Bottom}
        className="opacity-0"
        style={{ left: 0, top: 0, transform: "translate(-50%, -50%)" }}
      />
      <Handle
        type="source"
        id="cursor-source-left"
        position={Position.Left}
        className="opacity-0"
        style={{ left: 0, top: 0, transform: "translate(-50%, -50%)" }}
      />
      <Handle
        type="target"
        id="cursor-target-top"
        position={Position.Top}
        className="opacity-0"
        style={{ left: 0, top: 0, transform: "translate(-50%, -50%)" }}
      />
      <Handle
        type="target"
        id="cursor-target-right"
        position={Position.Right}
        className="opacity-0"
        style={{ left: 0, top: 0, transform: "translate(-50%, -50%)" }}
      />
      <Handle
        type="target"
        id="cursor-target-bottom"
        position={Position.Bottom}
        className="opacity-0"
        style={{ left: 0, top: 0, transform: "translate(-50%, -50%)" }}
      />
      <Handle
        type="target"
        id="cursor-target-left"
        position={Position.Left}
        className="opacity-0"
        style={{ left: 0, top: 0, transform: "translate(-50%, -50%)" }}
      />
    </>
  );
}

export default CursorNode;
