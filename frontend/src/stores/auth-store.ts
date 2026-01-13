"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User } from "@/types";
import { generateId } from "@/lib/utils";

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
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
      isLoading: false,

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
        });
      },

      logout: () => {
        set({
          user: null,
          isAuthenticated: false,
          isLoading: false,
        });
      },

      setLoading: (loading: boolean) => {
        set({ isLoading: loading });
      },
    }),
    {
      name: "orcabot-auth",
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
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
