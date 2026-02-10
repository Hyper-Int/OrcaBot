// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: drag-drop-overlay-v1

import * as React from "react";
import { FolderInput } from "lucide-react";

interface DragDropOverlayProps {
  visible: boolean;
}

export function DragDropOverlay({ visible }: DragDropOverlayProps) {
  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[var(--background)]/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
      <div className="flex flex-col items-center gap-3 p-8 rounded-xl border-2 border-dashed border-[var(--accent-primary)] bg-[var(--background)]">
        <FolderInput className="w-12 h-12 text-[var(--accent-primary)]" />
        <div className="text-sm font-medium text-[var(--foreground)]">
          Drop folder to import into workspace
        </div>
        <div className="text-xs text-[var(--foreground-muted)]">
          Files will be copied and available immediately in the sandbox
        </div>
      </div>
    </div>
  );
}
