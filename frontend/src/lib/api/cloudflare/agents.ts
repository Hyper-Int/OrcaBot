// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: agent-block-v1-link-chat-seat

const MODULE_REVISION = "agent-block-v1-link-chat-seat";
console.log(`[agents-api] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

/** An outside agent linked to the user's account (it runs on its own computer). */
export interface LinkedAgent {
  identity: string;
  name: string;
  mode?: string;
}

export interface AgentsResponse {
  agents: LinkedAgent[];
  /** The agent hub's URL, for the setup instructions. */
  hubUrl: string;
  /** False when this Orcabot has no agent hub configured. */
  enabled: boolean;
}

/** One message in a dashboard's chat with an agent. */
export interface AgentMessage {
  seq: number;
  from: "me" | "agent";
  text: string;
  ts: number;
}

export interface AgentChatResponse {
  messages: AgentMessage[];
  /** connecting | pairing | ready | error: the dashboard VM's link to the hub. */
  status: string;
  detail?: string;
}

export async function listAgents(): Promise<AgentsResponse> {
  console.log(`[listAgents] called at ${new Date().toISOString()}`);
  return apiGet<AgentsResponse>(`${API.cloudflare.base}/agents`);
}

/** Link the agent whose setup printed `code` (8 characters, e.g. ABCD-EFGH). */
export async function linkAgent(code: string): Promise<LinkedAgent> {
  console.log(`[linkAgent] called at ${new Date().toISOString()}`);
  const res = await apiPost<{ agent: LinkedAgent }>(`${API.cloudflare.base}/agents/link`, { code });
  return res.agent;
}

/** Disconnect an agent from the account (its connector stops working). */
export async function unlinkAgent(identity: string): Promise<void> {
  console.log(`[unlinkAgent] called at ${new Date().toISOString()}`);
  await apiDelete(`${API.cloudflare.base}/agents?identity=${encodeURIComponent(identity)}`);
}

/** Messages in this dashboard's chat with an agent, after `after` (a seq). Needs the dashboard's VM. */
export async function getAgentChat(dashboardId: string, identity: string, after = 0): Promise<AgentChatResponse> {
  console.log(`[getAgentChat] called at ${new Date().toISOString()}`);
  const q = `agent=${encodeURIComponent(identity)}&after=${after}`;
  return apiGet<AgentChatResponse>(`${API.cloudflare.base}/dashboards/${dashboardId}/agents/chat?${q}`);
}

export async function sendAgentMessage(dashboardId: string, identity: string, text: string): Promise<void> {
  console.log(`[sendAgentMessage] called at ${new Date().toISOString()}`);
  await apiPost(`${API.cloudflare.base}/dashboards/${dashboardId}/agents/chat`, { agent: identity, text });
}
