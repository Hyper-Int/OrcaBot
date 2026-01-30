// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { notifyApiError } from "@/lib/alerts";
import { apiPost } from "../client";

export type SessionAttachmentSpec = {
  name: string;
  sourceUrl?: string;
  content?: string;
};

export type McpToolAttachmentSpec = {
  name: string;
  serverUrl: string;
  transport: string;
  config?: Record<string, unknown>;
};

export type SessionAttachmentRequest = {
  terminalType: string;
  attach?: {
    agents?: SessionAttachmentSpec[];
    skills?: SessionAttachmentSpec[];
  };
  detach?: {
    agents?: string[];
    skills?: string[];
  };
  mcpTools?: McpToolAttachmentSpec[];
};

export async function attachSessionResources(
  sessionId: string,
  data: SessionAttachmentRequest
): Promise<void> {
  const url = `${API.cloudflare.base}/sessions/${sessionId}/attachments`;
  try {
    await apiPost<void>(url, data);
  } catch (error) {
    notifyApiError(error);
    throw error;
  }
}
