// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: api-tokens-client-v1
// Personal access tokens (PATs) for the orcabot CLI (push/pull).
// Mint is POST /auth/api-token (plaintext returned once); list/revoke use
// /auth/api-tokens. Auth is attached automatically by the shared apiFetch.

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** Returned only at creation — `token` is the plaintext, shown once. */
export interface MintedApiToken extends ApiToken {
  token: string;
}

interface ListResponse {
  tokens: ApiToken[];
}

export async function listApiTokens(): Promise<ApiToken[]> {
  const response = await apiGet<ListResponse>(API.cloudflare.apiTokens);
  return response.tokens || [];
}

export async function mintApiToken(name: string): Promise<MintedApiToken> {
  const response = await apiPost<{
    token: string;
    id: string;
    name: string;
    createdAt: string;
    expiresAt: string | null;
  }>(API.cloudflare.apiTokenMint, { name });
  return {
    id: response.id,
    name: response.name,
    token: response.token,
    createdAt: response.createdAt,
    expiresAt: response.expiresAt,
    lastUsedAt: null,
  };
}

export async function revokeApiToken(id: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.apiTokens}/${id}`);
}
