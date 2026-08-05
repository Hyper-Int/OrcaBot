// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: fullscreen-action-context-v1
// Lets a block's settings menu request "enter full-screen view mode" for itself
// without threading a callback through every block's props. The Canvas provides
// the handler; blocks (or the shared BlockSettingsFooter) read it via
// useEnterFullscreen() and call it with their React Flow node id. Absent
// provider (e.g. inside the mobile pager itself) => null => the action hides.

import * as React from "react";

const MODULE_REVISION = "fullscreen-action-context-v1";
if (typeof window !== "undefined") {
  console.log(`[fullscreen-action-context] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

export type EnterFullscreenFn = (nodeId: string) => void;

export const FullscreenActionContext = React.createContext<EnterFullscreenFn | null>(null);

export function useEnterFullscreen(): EnterFullscreenFn | null {
  return React.useContext(FullscreenActionContext);
}
