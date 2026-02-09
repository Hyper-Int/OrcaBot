// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: block-settings-footer-v1
// Shared footer for block settings dropdowns: Minimize + Delete actions.

"use client";

import { useReactFlow } from "@xyflow/react";
import { Minimize2, Trash2 } from "lucide-react";
import {
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui";

/**
 * Renders Minimize + Delete items at the bottom of a block's settings dropdown.
 * Must be used inside a DropdownMenuContent within a React Flow node.
 */
export function BlockSettingsFooter({
  nodeId,
  onMinimize,
}: {
  nodeId: string;
  onMinimize: () => void;
}) {
  const { deleteElements } = useReactFlow();
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onMinimize} className="gap-2">
        <Minimize2 className="w-3 h-3" />
        <span>Minimize</span>
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => deleteElements({ nodes: [{ id: nodeId }] })}
        className="gap-2 text-red-500 focus:text-red-500"
      >
        <Trash2 className="w-3 h-3" />
        <span>Delete</span>
      </DropdownMenuItem>
    </>
  );
}
