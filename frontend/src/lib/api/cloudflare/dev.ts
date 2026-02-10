// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: cloudflare-dev-api-v1-clear-workspace
const MODULE_REVISION = "cloudflare-dev-api-v1-clear-workspace";
console.log(`[dev-api] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { apiPost } from "@/lib/api/client";
import { API } from "@/config/env";

export interface DevClearWorkspaceResponse {
  ok: boolean;
  deletedFiles?: number;
  deletedDirs?: number;
  remainingFiles?: number;
  remainingDirs?: number;
  hasMore?: boolean;
}

export async function clearWorkspaceDev(dashboardId: string): Promise<DevClearWorkspaceResponse> {
  console.log(`[clearWorkspaceDev] called at ${new Date().toISOString()} dashboardId=${dashboardId}`);
  return apiPost<DevClearWorkspaceResponse>(API.cloudflare.devClearWorkspace, { dashboardId });
}
