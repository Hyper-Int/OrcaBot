// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-api-v3-pending-approvals-fetch
const MODULE_REVISION = "egress-api-v3-pending-approvals-fetch";
console.log(`[egress-api] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

export type EgressDecision = 'allow_once' | 'allow_always' | 'deny';

export interface EgressAllowlistEntry {
  id: string;
  domain: string;
  created_by: string;
  created_at: string;
}

export interface EgressAuditEntry {
  id: string;
  domain: string;
  port: number;
  decision: string;
  decided_by: string;
  created_at: string;
}

export interface PendingEgressApproval {
  domain: string;
  port: number;
  request_id: string;
}

/**
 * Approve or deny a held egress connection.
 */
export async function approveEgress(
  dashboardId: string,
  domain: string,
  decision: EgressDecision,
  requestId?: string,
  port?: number,
): Promise<void> {
  console.log(`[egress-api] approveEgress called at ${new Date().toISOString()}`);
  await apiPost(`${API.cloudflare.base}/dashboards/${dashboardId}/egress/approve`, {
    domain,
    decision,
    port,
    request_id: requestId,
  });
}

/**
 * List currently pending egress approvals for a dashboard.
 */
export async function listPendingEgressApprovals(
  dashboardId: string,
): Promise<PendingEgressApproval[]> {
  const response = await apiGet<{ pending: PendingEgressApproval[] }>(
    `${API.cloudflare.base}/dashboards/${dashboardId}/egress/pending`
  );
  return response.pending || [];
}

/**
 * List user-approved egress domains for a dashboard.
 */
export async function listEgressAllowlist(
  dashboardId: string,
): Promise<EgressAllowlistEntry[]> {
  const response = await apiGet<{ entries: EgressAllowlistEntry[] }>(
    `${API.cloudflare.base}/dashboards/${dashboardId}/egress/allowlist`
  );
  return response.entries || [];
}

/**
 * Revoke a user-approved egress domain.
 */
export async function revokeEgressDomain(
  dashboardId: string,
  entryId: string,
): Promise<void> {
  await apiDelete(`${API.cloudflare.base}/dashboards/${dashboardId}/egress/allowlist/${entryId}`);
}

/**
 * List recent egress audit log entries.
 */
export async function listEgressAudit(
  dashboardId: string,
  limit = 50,
): Promise<EgressAuditEntry[]> {
  const response = await apiGet<{ entries: EgressAuditEntry[] }>(
    `${API.cloudflare.base}/dashboards/${dashboardId}/egress/audit?limit=${limit}`
  );
  return response.entries || [];
}
