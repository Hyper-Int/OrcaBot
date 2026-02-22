// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: midnight-theme-v1-toggle
"use client";

import * as React from "react";
import { Moon, Sun, Eclipse } from "lucide-react";
import { Button } from "./button";
import { useThemeStore } from "@/stores/theme-store";

const THEME_LABELS = {
  light: "dark",
  dark: "midnight",
  midnight: "light",
} as const;

const THEME_ICONS = {
  light: Moon,    // shows Moon → click to go dark
  dark: Eclipse,  // shows Eclipse → click to go midnight
  midnight: Sun,  // shows Sun → click to go light
} as const;

export function ThemeToggle() {
  const { theme, toggleTheme } = useThemeStore();
  const [mounted, setMounted] = React.useState(false);

  // Avoid hydration mismatch by only rendering after mount
  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // Return a placeholder with same dimensions to avoid layout shift
    return (
      <Button variant="ghost" size="icon-sm" disabled>
        <Sun className="w-4 h-4" />
      </Button>
    );
  }

  const Icon = THEME_ICONS[theme];

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggleTheme}
      aria-label={`Switch to ${THEME_LABELS[theme]} mode`}
    >
      <Icon className="w-4 h-4" />
    </Button>
  );
}
