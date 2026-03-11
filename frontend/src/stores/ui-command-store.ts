// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { create } from "zustand";
import type { AnyUIGuidanceCommand } from "@/lib/api/cloudflare/chat";

interface UICommandStore {
  handler: ((command: AnyUIGuidanceCommand) => void) | null;
  setHandler: (handler: ((command: AnyUIGuidanceCommand) => void) | null) => void;
  dispatch: (command: AnyUIGuidanceCommand) => void;
}

export const useUICommandStore = create<UICommandStore>((set, get) => ({
  handler: null,
  setHandler: (handler) => set({ handler }),
  dispatch: (command) => {
    const { handler } = get();
    if (handler) {
      handler(command);
    } else {
      console.warn("[UICommandStore] No handler registered for command:", command);
    }
  },
}));
