// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Avatar, Tooltip } from "@/components/ui";
import type { PresenceUser } from "@/types/collaboration";

interface PresenceListProps {
  /** List of users with presence info */
  users: PresenceUser[];
  /** Maximum visible avatars before overflow */
  maxVisible?: number;
  /** Size of avatars */
  size?: "sm" | "md";
  /** Optional className */
  className?: string;
}

/**
 * Presence list component showing online users
 * Displays avatar stack with overflow indicator
 */
export function PresenceList({
  users,
  maxVisible = 5,
  size = "sm",
  className,
}: PresenceListProps) {
  const visibleUsers = users.slice(0, maxVisible);
  const overflowCount = users.length - maxVisible;

  return (
    <div className={cn("flex items-center", className)}>
      {/* Avatar stack */}
      <div className="flex items-center -space-x-2">
        {visibleUsers.map((user) => (
          <Tooltip key={user.userId} content={user.userName}>
            <div className="relative">
              <Avatar
                name={user.userName}
                size={size}
                className="ring-2 ring-[var(--background)]"
              />
              {/* Colored ring indicator */}
              {!user.isCurrentUser && (
                <div
                  className="absolute inset-0 rounded-full ring-2 pointer-events-none"
                  style={{
                    // Use CSS custom property for ring color
                    ["--tw-ring-color" as string]: user.color,
                  }}
                />
              )}
              {user.isCurrentUser && (
                <div className="absolute inset-0 rounded-full ring-2 ring-[var(--accent-primary)] pointer-events-none" />
              )}
              {/* Online indicator */}
              <div
                className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[var(--status-success)] ring-2 ring-[var(--background)]"
              />
            </div>
          </Tooltip>
        ))}

        {/* Overflow indicator */}
        {overflowCount > 0 && (
          <Tooltip
            content={`${overflowCount} more user${overflowCount > 1 ? "s" : ""}`}
          >
            <div
              className={cn(
                "flex items-center justify-center rounded-full",
                "bg-[var(--background-elevated)] ring-2 ring-[var(--background)]",
                "text-xs font-medium text-[var(--foreground-muted)]",
                size === "sm" ? "w-7 h-7" : "w-8 h-8"
              )}
            >
              +{overflowCount}
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export default PresenceList;
