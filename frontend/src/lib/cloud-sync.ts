// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: cloud-sync-v3-pin-legacy-atomic
"use client";

import {
  getCloudDashboard,
  downloadCloudWorkspace,
  type WorkspaceDownloadResult,
} from "@/lib/tauri-bridge";
import {
  createDashboard,
  createItem,
  createEdge,
  deleteDashboard,
} from "@/lib/api/cloudflare/dashboards";
import type { Dashboard, DashboardItem, DashboardEdge } from "@/types";

if (typeof window !== "undefined") {
  console.log(
    `[cloud-sync] REVISION: cloud-sync-v3-pin-legacy-atomic loaded at ${new Date().toISOString()}`
  );
}

interface CloudDashboardData {
  dashboard: { name: string };
  items: DashboardItem[];
  edges: DashboardEdge[];
}

export interface DownloadResult {
  dashboard: Dashboard;
  /** Workspace file-copy result, or null if it couldn't run. */
  workspace: WorkspaceDownloadResult | null;
  /** Set if the workspace file copy failed (the canvas still downloaded). */
  workspaceError?: string;
}

/**
 * Sanitize a workspace-relative path to plain segments: strip leading slashes and
 * `.`/empty segments, and REJECT any `..` (returns "" so the caller falls back to
 * the bare subfolder). Without this, a terminal whose content has
 * `workingDir: "../other"` would become `<subdir>/../other` and the sandbox would
 * normalize it OUT of the dashboard's isolated subfolder.
 */
function sanitizeRel(p: string): string {
  const parts = p
    .replace(/^\/+/, "")
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".");
  if (parts.some((seg) => seg === "..")) return "";
  return parts.join("/");
}

function pinTerminalToSubdir(content: string, subdir: string): string {
  const trimmed = content.trim();
  // Legacy / malformed terminal content is a plain string (the parser treats it as
  // the terminal's display name). Wrap it into valid JSON so it, too, is pinned to
  // this dashboard's subfolder instead of starting at the shared workspace root.
  if (!trimmed.startsWith("{")) {
    return JSON.stringify({ name: trimmed || "Terminal", workingDir: subdir });
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return JSON.stringify({ name: trimmed, workingDir: subdir });
  }
  const existing =
    typeof obj.workingDir === "string" ? sanitizeRel(obj.workingDir) : "";
  obj.workingDir = existing ? `${subdir}/${existing}` : subdir;
  return JSON.stringify(obj);
}

/**
 * Download a cloud dashboard into the LOCAL control-plane DB and copy its
 * workspace files. Fetches the cloud dashboard's structure (items + edges) via the
 * native layer (PAT) and recreates it locally with `cloudId` set (so it shows as
 * downloaded and Phase-2 sync can map it back), then pulls the cloud workspace
 * files into a per-dashboard subfolder. The local copy runs on the local VM.
 *
 * The workspace copy is best-effort: if it fails (cloud VM won't start, no
 * subscription, timeout), the canvas is still downloaded and `workspaceError` is
 * set so the caller can tell the user.
 */
export async function downloadCloudDashboard(
  cloudId: string,
  fallbackName: string
): Promise<DownloadResult> {
  const data = (await getCloudDashboard(cloudId)) as CloudDashboardData;
  const name = data.dashboard?.name || fallbackName;

  const { dashboard } = await createDashboard(name, undefined, cloudId);
  const subdir = dashboard.id;

  // Recreate the canvas atomically: if any item/edge fails, delete the partial
  // dashboard so it doesn't linger marked "downloaded" (with a cloudId) but broken.
  try {
    // Recreate items, mapping each cloud item id → the new local id (edges use it).
    // Terminal items are pinned to this dashboard's workspace subfolder.
    const idMap = new Map<string, string>();
    for (const item of data.items || []) {
      const content =
        item.type === "terminal" ? pinTerminalToSubdir(item.content, subdir) : item.content;
      const local = await createItem(dashboard.id, {
        type: item.type,
        content,
        position: item.position,
        size: item.size,
        metadata: item.metadata,
      });
      idMap.set(item.id, local.id);
    }

    for (const edge of data.edges || []) {
      const sourceItemId = idMap.get(edge.sourceItemId);
      const targetItemId = idMap.get(edge.targetItemId);
      if (!sourceItemId || !targetItemId) continue; // endpoint didn't survive (e.g. filtered item)
      await createEdge(dashboard.id, {
        sourceItemId,
        targetItemId,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      });
    }
  } catch (e) {
    // Roll back the partial dashboard (best-effort) and surface the failure.
    try {
      await deleteDashboard(dashboard.id);
    } catch {
      /* leave it; the canvas error below is the real signal */
    }
    throw e;
  }

  // Pull the workspace files into <workspace>/<subdir>. Best-effort — the canvas
  // is already created, so a failure here doesn't undo the download.
  let workspace: WorkspaceDownloadResult | null = null;
  let workspaceError: string | undefined;
  try {
    workspace = await downloadCloudWorkspace(cloudId, subdir);
  } catch (e) {
    workspaceError = e instanceof Error ? e.message : String(e);
  }

  return { dashboard, workspace, workspaceError };
}
