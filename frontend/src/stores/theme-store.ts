// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { create } from "zustand";
import { persist } from "zustand/middleware";

// REVISION: midnight-theme-v2-default-midnight
const MODULE_REVISION = "midnight-theme-v2-default-midnight";
console.log(`[theme-store] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

type Theme = "light" | "dark" | "midnight";

const THEME_CYCLE: Theme[] = ["light", "dark", "midnight"];

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "midnight",
      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },
      toggleTheme: () => {
        const current = get().theme;
        const idx = THEME_CYCLE.indexOf(current);
        const newTheme = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
        set({ theme: newTheme });
        applyTheme(newTheme);
      },
    }),
    {
      name: "theme-storage",
      onRehydrateStorage: () => (state) => {
        // Apply theme on rehydration (page load)
        if (state) {
          applyTheme(state.theme);
        }
      },
    }
  )
);

function applyTheme(theme: Theme) {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.classList.remove("dark", "midnight");
    if (theme === "dark" || theme === "midnight") {
      root.classList.add(theme);
    }
  }
}
