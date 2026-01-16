// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import type { PresenceInfo, PresenceUser } from "@/types/collaboration";

export interface UsePresenceOptions {
  presence: PresenceInfo[];
  currentUserId: string;
}

export interface UsePresenceResult {
  /** All users including current user */
  allUsers: PresenceUser[];
  /** Other users (excluding current user) */
  otherUsers: PresenceUser[];
  /** Current user's presence */
  currentUser: PresenceUser | null;
  /** Count of online users */
  onlineCount: number;
  /** Get user by ID */
  getUserById: (userId: string) => PresenceUser | undefined;
  /** Get users selecting a specific item */
  getUsersSelectingItem: (itemId: string) => PresenceUser[];
}

/**
 * Hook for working with presence data
 * Provides utilities for filtering and displaying user presence
 */
export function usePresence(options: UsePresenceOptions): UsePresenceResult {
  const { presence, currentUserId } = options;

  const result = React.useMemo(() => {
    // Convert PresenceInfo to PresenceUser with isCurrentUser flag
    const allUsers: PresenceUser[] = presence.map((p) => ({
      ...p,
      isCurrentUser: p.userId === currentUserId,
    }));

    const currentUser = allUsers.find((u) => u.isCurrentUser) || null;
    const otherUsers = allUsers.filter((u) => !u.isCurrentUser);

    const getUserById = (userId: string) =>
      allUsers.find((u) => u.userId === userId);

    const getUsersSelectingItem = (itemId: string) =>
      otherUsers.filter((u) => u.selectedItem === itemId);

    return {
      allUsers,
      otherUsers,
      currentUser,
      onlineCount: allUsers.length,
      getUserById,
      getUsersSelectingItem,
    };
  }, [presence, currentUserId]);

  return result;
}
