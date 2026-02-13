// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { ReplayScript } from "@/components/replay/types";
import heroTerminal from "./hero-terminal.json";

const scripts: Record<string, ReplayScript> = {
  "hero-terminal": heroTerminal as ReplayScript,
};

/**
 * Look up a replay script by name.
 * Returns undefined if not found.
 */
export function getReplayScript(name: string): ReplayScript | undefined {
  return scripts[name];
}
