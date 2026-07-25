// Copyright 2026 Rob Macrae. All rights reserved.
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
  if (!sessionId) return [];
  const params = new URLSearchParams({ path });
  const url = `${API.cloudflare.base}/sessions/${sessionId}/files?${params.toString()}`;
  const response = await apiGet<ListFilesResponse>(url);
  return response.files || [];
}

export async function deleteSessionFile(sessionId: string, path: string): Promise<void> {
  if (!sessionId) return;
  const params = new URLSearchParams({ path });
  const url = `${API.cloudflare.base}/sessions/${sessionId}/file?${params.toString()}`;
  await apiDelete<void>(url);
}

/**
 * Read a workspace file's text content. `path` is relative to the workspace root
 * (e.g. ".scb-config.yaml"). Returns null on any error / missing file (best-effort).
 */
export async function readSessionFileText(sessionId: string, path: string): Promise<string | null> {
  if (!sessionId) return null;
  const url = `${API.cloudflare.base}/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`;
  try {
    const res = await fetch(url, { headers: { ...getAuthHeaders() }, credentials: "include" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Write raw text to a workspace file (owner-only; PUT /sessions/:id/file). `path`
 * is workspace-relative. Returns true on success.
 */
export async function writeSessionFile(sessionId: string, path: string, content: string): Promise<boolean> {
  if (!sessionId) return false;
  const url = `${API.cloudflare.base}/sessions/${sessionId}/file?path=${encodeURIComponent(path)}`;
  try {
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...getAuthHeaders(), "Content-Type": "text/plain" },
      credentials: "include",
      body: content,
    });
    return res.ok;
  } catch {
    return false;
  }
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
