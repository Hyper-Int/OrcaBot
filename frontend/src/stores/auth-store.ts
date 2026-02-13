// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User, SubscriptionInfo } from "@/types";
import { generateId } from "@/lib/utils";

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  isAuthResolved: boolean;
  subscription: SubscriptionInfo | null;
}

interface AuthActions {
  /**
   * Login with dev mode (bypasses OAuth)
   */
  loginDevMode: (name: string, email: string) => void;

  /**
   * Logout the current user
   */
  logout: () => void;

  /**
   * Set loading state
   */
  setLoading: (loading: boolean) => void;

  /**
   * Set authenticated user (OAuth bootstrap)
   */
  setUser: (user: User | null, isAdmin?: boolean, subscription?: SubscriptionInfo | null) => void;

  /**
   * Mark auth resolution status
   */
  setAuthResolved: (resolved: boolean) => void;
}

type AuthStore = AuthState & AuthActions;

/**
 * Generate a stable user ID from email
 */
function generateUserId(email: string): string {
  // Create a simple hash from email for consistent ID
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    const char = email.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `dev-${Math.abs(hash).toString(36)}`;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      // Initial state
      user: null,
      isAuthenticated: false,
      isAdmin: false,
      isLoading: false,
      isAuthResolved: false,
      subscription: null,

      // Actions
      loginDevMode: (name: string, email: string) => {
        const user: User = {
          id: generateUserId(email),
          name: name.trim(),
          email: email.trim().toLowerCase(),
          createdAt: new Date().toISOString(),
        };

        set({
          user,
          isAuthenticated: true,
          isLoading: false,
          isAuthResolved: true,
        });
      },

      logout: () => {
        set({
          user: null,
          isAuthenticated: false,
          isAdmin: false,
          isLoading: false,
          isAuthResolved: true,
          subscription: null,
        });
      },

      setLoading: (loading: boolean) => {
        set({ isLoading: loading });
      },

      setUser: (user: User | null, isAdmin?: boolean, subscription?: SubscriptionInfo | null) => {
        set((prev) => ({
          user,
          isAuthenticated: Boolean(user),
          isAdmin: isAdmin ?? false,
          isLoading: false,
          isAuthResolved: true,
          // Preserve existing subscription when not explicitly provided.
          // undefined = "not specified" → keep previous; null = "explicitly clear".
          subscription: subscription === undefined ? (user ? prev.subscription : null) : subscription,
        }));
      },

      setAuthResolved: (resolved: boolean) => {
        set({ isAuthResolved: resolved });
      },
    }),
    {
      name: "orcabot-auth",
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        isAdmin: state.isAdmin,
        subscription: state.subscription,
        // Note: isAuthResolved is intentionally NOT persisted - it should be
        // computed fresh each page load to avoid race conditions with hydration
      }),
      onRehydrateStorage: () => (state) => {
        // After hydration completes, if we have a valid user from localStorage,
        // mark auth as resolved immediately (no need to call /users/me)
        if (state?.isAuthenticated && state?.user) {
          state.isAuthResolved = true;
        }
      },
    }
  )
);

/**
 * Hook to get auth headers for API calls
 */
export function useAuthHeaders(): Record<string, string> {
  const user = useAuthStore((state) => state.user);

  if (!user) {
    return {};
  }

  return {
    "X-User-ID": user.id,
    "X-User-Email": user.email,
    "X-User-Name": user.name,
  };
}

/**
 * Get auth headers outside of React (for API client)
 */
export function getAuthHeaders(): Record<string, string> {
  const state = useAuthStore.getState();

  if (!state.user) {
    return {};
  }

  return {
    "X-User-ID": state.user.id,
    "X-User-Email": state.user.email,
    "X-User-Name": state.user.name,
  };
}
