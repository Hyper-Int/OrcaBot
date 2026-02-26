// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: splash-transition-v1-store
"use client";

import { create } from "zustand";

const MODULE_REVISION = "splash-transition-v1-store";
console.log(
  `[splash-transition-store] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`
);

export type TransitionPhase =
  | "idle"
  | "creating"
  | "animating"
  | "handing-off"
  | "done";

interface SplashTransitionState {
  phase: TransitionPhase;
  /** The prompt text submitted from the splash chat bar */
  prompt: string;
  /** Bottom position (px) of the chat bar in the splash page (starting position) */
  startBottom: number;
  /** Dashboard ID once created */
  targetDashboardId: string | null;
  /** Whether the real ChatPanel has mounted and is ready */
  chatPanelReady: boolean;
}

interface SplashTransitionActions {
  /** Begin the transition: save prompt + starting position, phase -> creating */
  startTransition: (prompt: string, startBottom: number) => void;
  /** Dashboard created, start animating the bar down */
  setAnimating: (dashboardId: string) => void;
  /** Real ChatPanel has mounted and is ready to take over */
  setChatPanelReady: () => void;
  /** Begin fade-out of overlay / fade-in of real ChatPanel */
  setHandingOff: () => void;
  /** Transition complete, clean up */
  setDone: () => void;
  /** Reset to idle (error recovery, route change, etc.) */
  reset: () => void;
}

type SplashTransitionStore = SplashTransitionState & SplashTransitionActions;

const initialState: SplashTransitionState = {
  phase: "idle",
  prompt: "",
  startBottom: 0,
  targetDashboardId: null,
  chatPanelReady: false,
};

export const useSplashTransitionStore = create<SplashTransitionStore>()(
  (set) => ({
    ...initialState,

    startTransition: (prompt, startBottom) =>
      set({
        phase: "creating",
        prompt,
        startBottom,
        targetDashboardId: null,
        chatPanelReady: false,
      }),

    setAnimating: (dashboardId) =>
      set({ phase: "animating", targetDashboardId: dashboardId }),

    setChatPanelReady: () => set({ chatPanelReady: true }),

    setHandingOff: () => set({ phase: "handing-off" }),

    setDone: () => set({ ...initialState, phase: "done" }),

    reset: () => set(initialState),
  })
);
