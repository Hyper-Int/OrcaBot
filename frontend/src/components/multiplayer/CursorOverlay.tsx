// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { Cursor } from "./Cursor";
import type { PresenceUser } from "@/types/collaboration";

interface CursorOverlayProps {
  /** List of other users (not current user) */
  users: PresenceUser[];
  /** Current canvas viewport transform */
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
}

/**
 * Overlay component that renders all remote cursors
 * Should be placed over the canvas area
 */
export function CursorOverlay({
  users,
  viewport = { x: 0, y: 0, zoom: 1 },
}: CursorOverlayProps) {
  // Filter users that have cursor positions
  const usersWithCursors = users.filter(
    (user) => user.cursor !== null && !user.isCurrentUser
  );

  if (usersWithCursors.length === 0) {
    return null;
  }

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {usersWithCursors.map((user) => {
        // Transform cursor position based on viewport
        const screenX =
          (user.cursor!.x * viewport.zoom) + viewport.x;
        const screenY =
          (user.cursor!.y * viewport.zoom) + viewport.y;

        return (
          <Cursor
            key={user.userId}
            name={user.userName}
            color={user.color}
            x={screenX}
            y={screenY}
            isTyping={user.isTyping}
          />
        );
      })}
    </div>
  );
}

export default CursorOverlay;
