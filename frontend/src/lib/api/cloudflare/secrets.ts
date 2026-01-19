// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

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

export async function createSecret(data: {
  dashboardId: string;
  name: string;
  value: string;
  description?: string;
}): Promise<UserSecret> {
  const response = await apiPost<SecretResponse>(API.cloudflare.secrets, data);
  return response.secret;
}

export async function deleteSecret(id: string, dashboardId: string): Promise<void> {
  await apiDelete<void>(
    `${API.cloudflare.secrets}/${id}?dashboard_id=${encodeURIComponent(dashboardId)}`
  );
}
