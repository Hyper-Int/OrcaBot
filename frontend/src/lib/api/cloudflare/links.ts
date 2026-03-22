// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: links-frontend-v1-api-client

import { API } from "@/config/env";
import { apiPost, apiGet, apiDelete } from "../client";

export interface LinkInfo {
  id: string;
  linkedDashboardId: string;
  linkedDashboardName: string;
  createdAt: string;
}

interface CreateLinkResponse {
  linkId: string;
  linkedDashboardId: string;
  linkedDashboardName: string;
}

interface GetLinksResponse {
  links: LinkInfo[];
}

/**
 * Create a linked copy of a dashboard.
 * Returns the new linked dashboard's id and name.
 */
export async function createDashboardLink(
  dashboardId: string
): Promise<CreateLinkResponse> {
  return apiPost<CreateLinkResponse>(
    `${API.cloudflare.dashboards}/${dashboardId}/link`
  );
}

/**
 * List all links for a dashboard (both sides).
 */
export async function getDashboardLinks(
  dashboardId: string
): Promise<LinkInfo[]> {
  const res = await apiGet<GetLinksResponse>(
    `${API.cloudflare.dashboards}/${dashboardId}/links`
  );
  return res.links;
}

/**
 * Remove a dashboard link.
 */
export async function deleteDashboardLink(
  dashboardId: string,
  linkId: string
): Promise<void> {
  await apiDelete<void>(
    `${API.cloudflare.dashboards}/${dashboardId}/link/${linkId}`
  );
}
