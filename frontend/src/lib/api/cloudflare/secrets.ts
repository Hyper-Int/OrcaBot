// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete, apiPatch } from "../client";

// Special dashboard_id value for user-global secrets
const GLOBAL_SECRETS_ID = "_global";

export type SecretType = 'secret' | 'env_var';

export interface UserSecret {
  id: string;
  dashboardId: string;
  name: string;
  description?: string;
  type: SecretType; // 'secret' = brokered, 'env_var' = set directly
  brokerProtected: boolean; // If true, secret is routed through broker (LLM cannot read it directly)
  // Value is never returned from the API for security
  createdAt: string;
  updatedAt: string;
}

interface SecretsResponse {
  secrets: UserSecret[];
}

interface SecretResponse {
  secret: UserSecret;
}

/**
 * List secrets or environment variables.
 * @param dashboardId The dashboard ID or '_global' for user-level
 * @param type Optional filter: 'secret' for brokered secrets, 'env_var' for regular env vars
 */
export async function listSecrets(dashboardId: string, type?: SecretType): Promise<UserSecret[]> {
  let url = `${API.cloudflare.secrets}?dashboard_id=${encodeURIComponent(dashboardId)}`;
  if (type) {
    url += `&type=${type}`;
  }
  const response = await apiGet<SecretsResponse>(url);
  return response.secrets || [];
}

/**
 * List global (user-level) secrets that apply to all dashboards.
 */
export async function listGlobalSecrets(type?: SecretType): Promise<UserSecret[]> {
  let url = `${API.cloudflare.secrets}?dashboard_id=${GLOBAL_SECRETS_ID}`;
  if (type) {
    url += `&type=${type}`;
  }
  const response = await apiGet<SecretsResponse>(url);
  return response.secrets || [];
}

/**
 * Create a secret or environment variable.
 */
export async function createSecret(data: {
  dashboardId?: string;
  name: string;
  value: string;
  description?: string;
  type?: SecretType;
}): Promise<UserSecret> {
  const response = await apiPost<SecretResponse>(API.cloudflare.secrets, {
    ...data,
    dashboardId: data.dashboardId || GLOBAL_SECRETS_ID,
    type: data.type || 'secret',
  });
  return response.secret;
}

/**
 * Create a global (user-level) secret that applies to all dashboards.
 */
export async function createGlobalSecret(data: {
  name: string;
  value: string;
  description?: string;
}): Promise<UserSecret> {
  return createSecret({ ...data, dashboardId: GLOBAL_SECRETS_ID, type: 'secret' });
}

// ============================================
// Environment Variables (non-brokered)
// ============================================

/**
 * List environment variables (non-brokered).
 */
export async function listEnvVars(dashboardId: string): Promise<UserSecret[]> {
  return listSecrets(dashboardId, 'env_var');
}

/**
 * List global environment variables.
 */
export async function listGlobalEnvVars(): Promise<UserSecret[]> {
  return listGlobalSecrets('env_var');
}

/**
 * Create an environment variable (non-brokered).
 */
export async function createEnvVar(data: {
  dashboardId?: string;
  name: string;
  value: string;
  description?: string;
}): Promise<UserSecret> {
  return createSecret({ ...data, type: 'env_var' });
}

/**
 * Create a global environment variable.
 */
export async function createGlobalEnvVar(data: {
  name: string;
  value: string;
  description?: string;
}): Promise<UserSecret> {
  return createSecret({ ...data, dashboardId: GLOBAL_SECRETS_ID, type: 'env_var' });
}

export async function deleteSecret(id: string, dashboardId: string): Promise<void> {
  await apiDelete<void>(
    `${API.cloudflare.secrets}/${id}?dashboard_id=${encodeURIComponent(dashboardId)}`
  );
}

/**
 * Delete a global (user-level) secret.
 */
export async function deleteGlobalSecret(id: string): Promise<void> {
  await deleteSecret(id, GLOBAL_SECRETS_ID);
}

/**
 * Update a secret's broker protection setting.
 * When brokerProtected is true (default), the secret is routed through a broker
 * and LLMs cannot read it directly. When false, the secret is exposed as an
 * environment variable that LLMs can access.
 */
export async function updateSecretProtection(
  id: string,
  dashboardId: string,
  brokerProtected: boolean
): Promise<UserSecret> {
  const response = await apiPatch<SecretResponse>(
    `${API.cloudflare.secrets}/${id}/protection?dashboard_id=${encodeURIComponent(dashboardId)}`,
    { brokerProtected }
  );
  return response.secret;
}

/**
 * Update a global secret's broker protection setting.
 */
export async function updateGlobalSecretProtection(
  id: string,
  brokerProtected: boolean
): Promise<UserSecret> {
  return updateSecretProtection(id, GLOBAL_SECRETS_ID, brokerProtected);
}

// ============================================
// Domain Allowlist (for custom secrets)
// ============================================

export interface DomainAllowlistEntry {
  id: string;
  secretId: string;
  domain: string;
  headerName: string;
  headerFormat: string;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface PendingApproval {
  id: string;
  secretId: string;
  secretName: string;
  domain: string;
  requestedAt: string;
}

interface AllowlistResponse {
  allowlist: DomainAllowlistEntry[];
}

interface PendingApprovalsResponse {
  pendingApprovals: PendingApproval[];
}

interface AllowlistEntryResponse {
  entry: DomainAllowlistEntry;
}

/**
 * List approved domains for a secret.
 */
export async function listSecretAllowlist(
  secretId: string,
  dashboardId: string
): Promise<DomainAllowlistEntry[]> {
  const response = await apiGet<AllowlistResponse>(
    `${API.cloudflare.secrets}/${secretId}/allowlist?dashboard_id=${encodeURIComponent(dashboardId)}`
  );
  return response.allowlist || [];
}

/**
 * List approved domains for a global secret.
 */
export async function listGlobalSecretAllowlist(
  secretId: string
): Promise<DomainAllowlistEntry[]> {
  return listSecretAllowlist(secretId, GLOBAL_SECRETS_ID);
}

/**
 * Approve a domain for a secret.
 */
export async function approveSecretDomain(
  secretId: string,
  dashboardId: string,
  data: { domain: string; headerName?: string; headerFormat?: string }
): Promise<DomainAllowlistEntry> {
  const response = await apiPost<AllowlistEntryResponse>(
    `${API.cloudflare.secrets}/${secretId}/allowlist?dashboard_id=${encodeURIComponent(dashboardId)}`,
    data
  );
  return response.entry;
}

/**
 * Approve a domain for a global secret.
 */
export async function approveGlobalSecretDomain(
  secretId: string,
  data: { domain: string; headerName?: string; headerFormat?: string }
): Promise<DomainAllowlistEntry> {
  return approveSecretDomain(secretId, GLOBAL_SECRETS_ID, data);
}

/**
 * Revoke domain approval for a secret.
 */
export async function revokeSecretDomain(
  secretId: string,
  entryId: string,
  dashboardId: string
): Promise<void> {
  await apiDelete<void>(
    `${API.cloudflare.secrets}/${secretId}/allowlist/${entryId}?dashboard_id=${encodeURIComponent(dashboardId)}`
  );
}

/**
 * Revoke domain approval for a global secret.
 */
export async function revokeGlobalSecretDomain(
  secretId: string,
  entryId: string
): Promise<void> {
  return revokeSecretDomain(secretId, entryId, GLOBAL_SECRETS_ID);
}

/**
 * List pending domain approval requests.
 */
export async function listPendingApprovals(
  dashboardId?: string
): Promise<PendingApproval[]> {
  const url = dashboardId
    ? `${API.cloudflare.pendingApprovals}?dashboard_id=${encodeURIComponent(dashboardId)}`
    : API.cloudflare.pendingApprovals;
  const response = await apiGet<PendingApprovalsResponse>(url);
  return response.pendingApprovals || [];
}

/**
 * Dismiss a pending approval.
 */
export async function dismissPendingApproval(approvalId: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.pendingApprovals}/${approvalId}`);
}
