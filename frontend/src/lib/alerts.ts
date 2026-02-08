// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { toast } from "sonner";
import { ApiError } from "./api/client";

type AlertLevel = "info" | "warning" | "error";

type AlertDefinition = {
  level: AlertLevel;
  message: string;
};

const API_ERROR_ALERTS: Record<string, AlertDefinition> = {
  E79809: {
    level: "error",
    message: "Attachment source not allowed. Use a GitHub URL (https://github.com or https://raw.githubusercontent.com).",
  },
  E79810: {
    level: "warning",
    message: "Attachment fetch timed out. Please try again.",
  },
  E79811: {
    level: "error",
    message: "Attachment file too large. Max 5MB per file.",
  },
  E79812: {
    level: "error",
    message: "Attachment too large. Max 25MB total.",
  },
};

function extractErrorCode(message: string): string | null {
  const match = message.match(/\bE\d{5}\b/);
  return match ? match[0] : null;
}

function showAlert(level: AlertLevel, message: string): void {
  if (level === "info") {
    toast.info(message);
    return;
  }
  if (level === "warning") {
    toast.warning(message);
    return;
  }
  toast.error(message);
}

export function notifyApiError(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return false;
  }
  const code = extractErrorCode(error.message);
  if (!code) {
    return false;
  }
  const definition = API_ERROR_ALERTS[code];
  if (!definition) {
    return false;
  }
  showAlert(definition.level, definition.message);
  return true;
}

