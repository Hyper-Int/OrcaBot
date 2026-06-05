// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
//
// Per-user custom model endpoints (Ollama / vLLM / self-hosted / cloud BYO).
// See PLAN-custom-endpoints.md.

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

export interface UserModelProvider {
  id: string;
  label: string;
  baseUrl: string;
  format: "openai" | "anthropic";
  modelId: string;
  secretName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  compatibleHarnesses: string[];
  isLocal: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProvidersResponse {
  providers: UserModelProvider[];
}

interface ProviderResponse {
  provider: UserModelProvider;
}

export async function listModelProviders(): Promise<UserModelProvider[]> {
  const response = await apiGet<ProvidersResponse>(API.cloudflare.modelProviders);
  return response.providers || [];
}

export async function createModelProvider(data: {
  label: string;
  baseUrl: string;
  format?: "openai" | "anthropic";
  modelId: string;
  secretName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  compatibleHarnesses?: string[];
  isLocal?: boolean;
}): Promise<UserModelProvider> {
  const response = await apiPost<ProviderResponse>(API.cloudflare.modelProviders, data);
  return response.provider;
}

export async function deleteModelProvider(id: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.modelProviders}/${id}`);
}
