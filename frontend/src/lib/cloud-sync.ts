// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: cloud-sync-v1-download
"use client";

import { getCloudDashboard } from "@/lib/tauri-bridge";
import { createDashboard, createItem, createEdge } from "@/lib/api/cloudflare/dashboards";
import type { Dashboard, DashboardItem, DashboardEdge } from "@/types";

if (typeof window !== "undefined") {
  console.log(
    `[cloud-sync] REVISION: cloud-sync-v1-download loaded at ${new Date().toISOString()}`
  );
}

interface CloudDashboardData {
  dashboard: { name: string };
  items: DashboardItem[];
  edges: DashboardEdge[];
}

/**
 * Download a cloud dashboard into the LOCAL control-plane DB. Fetches the cloud
 * dashboard's structure (items + edges) via the native layer (PAT), then
 * recreates it locally with `cloudId` set so it shows as downloaded and Phase-2
 * sync can map it back. The local copy then runs on the local VM.
 *
 * Not yet copied: workspace files (terminals start fresh) and sessions — those
 * are follow-ups. Structure/notes/todos/layout come across.
 */
export async function downloadCloudDashboard(
  cloudId: string,
  fallbackName: string
): Promise<Dashboard> {
  const data = (await getCloudDashboard(cloudId)) as CloudDashboardData;
  const name = data.dashboard?.name || fallbackName;

  const { dashboard } = await createDashboard(name, undefined, cloudId);

  // Recreate items, mapping each cloud item id → the new local id (edges use it).
  const idMap = new Map<string, string>();
  for (const item of data.items || []) {
    const local = await createItem(dashboard.id, {
      type: item.type,
      content: item.content,
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

  return dashboard;
}
