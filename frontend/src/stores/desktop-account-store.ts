// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: desktop-account-store-v1
"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * First-run account choice for the DESKTOP app. The desktop stack always runs on
 * the LOCAL control plane + local VM; this only records whether the user chose to
 * stay anonymous ("free") or connect their orcabot.com identity ("signed-in").
 * Signing in is additive — it sets the local account's identity to the real
 * email/name and (later) enables cloud sync; it does NOT move execution to cloud.
 *
 * We intentionally do NOT persist any cloud secret (PAT) here — that will live in
 * the Tauri backend / OS keychain when cloud sync lands. This store holds only the
 * choice and the display identity.
 */
export type DesktopAccountChoice = "free" | "signed-in";

interface DesktopAccountState {
  /** null until the user has made a first-run choice. */
  choice: DesktopAccountChoice | null;
  /** Real account identity when signed-in (used as the local dev-auth identity). */
  email: string | null;
  name: string | null;
  /** True once the persisted value has hydrated from storage (client-only). */
  hydrated: boolean;

  chooseFree: () => void;
  chooseSignedIn: (email: string, name: string) => void;
  /** Return to the first-run choice (e.g. "sign out" / "use a different account"). */
  reset: () => void;
}

export const useDesktopAccountStore = create<DesktopAccountState>()(
  persist(
    (set) => ({
      choice: null,
      email: null,
      name: null,
      hydrated: false,

      chooseFree: () => set({ choice: "free", email: null, name: null }),
      chooseSignedIn: (email: string, name: string) =>
        set({ choice: "signed-in", email, name }),
      reset: () => set({ choice: null, email: null, name: null }),
    }),
    {
      name: "orcabot-desktop-account",
      // Persist only the choice + identity, never a transient flag.
      partialize: (s) => ({ choice: s.choice, email: s.email, name: s.name }),
      onRehydrateStorage: () => () => {
        // Runs after the persisted value is applied — flip the flag so the gate
        // renders once we actually know the choice (avoids a first-run flash).
        useDesktopAccountStore.setState({ hydrated: true });
      },
    }
  )
);
