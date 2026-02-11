// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: folder-import-button-v2-processed-field

import * as React from "react";
import { FolderInput, Loader2 } from "lucide-react";
import { Button, Tooltip } from "@/components/ui";
import { DESKTOP_MODE } from "@/config/env";
import type { ImportProgress } from "@/lib/tauri-bridge";

interface FolderImportButtonProps {
  onPickFolder: () => void;
  isImporting: boolean;
  progress: ImportProgress | null;
}

export function FolderImportButton({
  onPickFolder,
  isImporting,
  progress,
}: FolderImportButtonProps) {
  if (!DESKTOP_MODE) return null;

  const label =
    isImporting && progress
      ? `Importing: ${progress.processed}/${progress.total} files`
      : "Import local folder";

  return (
    <Tooltip content={label} side="bottom">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onPickFolder}
        disabled={isImporting}
        className="h-5 w-5"
      >
        {isImporting ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <FolderInput className="w-3 h-3" />
        )}
      </Button>
    </Tooltip>
  );
}
