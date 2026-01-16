// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

export interface UserAgentSkill {
  id: string;
  name: string;
  description: string;
  command: string;
  args?: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentSkillsResponse {
  skills: UserAgentSkill[];
}

interface AgentSkillResponse {
  skill: UserAgentSkill;
}

export async function listAgentSkills(): Promise<UserAgentSkill[]> {
  const response = await apiGet<AgentSkillsResponse>(API.cloudflare.agentSkills);
  return response.skills || [];
}

export async function createAgentSkill(data: {
  name: string;
  description?: string;
  command: string;
  args?: string[];
  source?: string;
}): Promise<UserAgentSkill> {
  const response = await apiPost<AgentSkillResponse>(API.cloudflare.agentSkills, data);
  return response.skill;
}

export async function deleteAgentSkill(id: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.agentSkills}/${id}`);
}
