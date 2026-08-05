// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: fullscreen-nav-context-v1
// Provided by the mobile full-screen pager so a block rendered inside it knows
// it's in full-screen and can redirect its "minimize" action to "go home" (back
// to the dashboard) — minimizing a full-screen block is meaningless. Absent
// provider (normal canvas) => null => minimize behaves normally.

import * as React from "react";

const MODULE_REVISION = "fullscreen-nav-context-v1";
if (typeof window !== "undefined") {
  console.log(`[fullscreen-nav-context] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

export interface FullscreenNav {
  goHome: () => void;
}

export const FullscreenNavContext = React.createContext<FullscreenNav | null>(null);

export function useFullscreenNav(): FullscreenNav | null {
  return React.useContext(FullscreenNavContext);
}
