// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet, apiDelete } from "../client";
import { getAuthHeaders } from "@/stores/auth-store";

export interface SessionFileEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  mod_time: string;
  mode: string;
}

interface ListFilesResponse {
  files: SessionFileEntry[];
}

export async function listSessionFiles(sessionId: string, path: string): Promise<SessionFileEntry[]> {
  const params = new URLSearchParams({ path });
  const url = `${API.cloudflare.base}/sessions/${sessionId}/files?${params.toString()}`;
  const response = await apiGet<ListFilesResponse>(url);
  return response.files || [];
}

export async function deleteSessionFile(sessionId: string, path: string): Promise<void> {
  const params = new URLSearchParams({ path });
  const url = `${API.cloudflare.base}/sessions/${sessionId}/file?${params.toString()}`;
  await apiDelete<void>(url);
}

export interface WorkspaceSnapshot {
  version: number;
  dashboardId: string;
  capturedAt: string;
  fileCount: number;
  files: SessionFileEntry[];
}

/**
 * Fetch cached workspace file listing from R2.
 * Returns null if no snapshot is available (404).
 * Uses raw fetch instead of apiGet to avoid error-throwing on expected 404s
 * and to bypass request deduplication (which can cause uncaught promise rejections).
 */
export async function getWorkspaceSnapshot(dashboardId: string): Promise<WorkspaceSnapshot | null> {
  const url = `${API.cloudflare.base}/dashboards/${dashboardId}/workspace-snapshot`;
  try {
    const res = await fetch(url, {
      headers: { ...getAuthHeaders() },
      credentials: "include",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
