// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

export interface UserSubagent {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface SubagentsResponse {
  subagents: UserSubagent[];
}

interface SubagentResponse {
  subagent: UserSubagent;
}

export async function listSubagents(): Promise<UserSubagent[]> {
  const response = await apiGet<SubagentsResponse>(API.cloudflare.subagents);
  return response.subagents || [];
}

export async function createSubagent(data: {
  name: string;
  description?: string;
  prompt: string;
  tools?: string[];
  source?: string;
}): Promise<UserSubagent> {
  const response = await apiPost<SubagentResponse>(API.cloudflare.subagents, data);
  return response.subagent;
}

export async function deleteSubagent(id: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.subagents}/${id}`);
}
