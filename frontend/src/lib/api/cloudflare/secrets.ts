// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

// Special dashboard_id value for user-global secrets
const GLOBAL_SECRETS_ID = "_global";

export interface UserSecret {
  id: string;
  dashboardId: string;
  name: string;
  description?: string;
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

export async function listSecrets(dashboardId: string): Promise<UserSecret[]> {
  const response = await apiGet<SecretsResponse>(
    `${API.cloudflare.secrets}?dashboard_id=${encodeURIComponent(dashboardId)}`
  );
  return response.secrets || [];
}

/**
 * List global (user-level) secrets that apply to all dashboards.
 */
export async function listGlobalSecrets(): Promise<UserSecret[]> {
  const response = await apiGet<SecretsResponse>(
    `${API.cloudflare.secrets}?dashboard_id=${GLOBAL_SECRETS_ID}`
  );
  return response.secrets || [];
}

export async function createSecret(data: {
  dashboardId?: string;
  name: string;
  value: string;
  description?: string;
}): Promise<UserSecret> {
  const response = await apiPost<SecretResponse>(API.cloudflare.secrets, {
    ...data,
    dashboardId: data.dashboardId || GLOBAL_SECRETS_ID,
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
  return createSecret({ ...data, dashboardId: GLOBAL_SECRETS_ID });
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
