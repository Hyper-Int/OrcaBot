import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

export interface UserMcpTool {
  id: string;
  name: string;
  description: string;
  serverUrl: string;
  transport: "stdio" | "sse" | "streamable-http";
  config?: Record<string, unknown>;
  source: string;
  createdAt: string;
  updatedAt: string;
}

interface McpToolsResponse {
  tools: UserMcpTool[];
}

interface McpToolResponse {
  tool: UserMcpTool;
}

export async function listMcpTools(): Promise<UserMcpTool[]> {
  const response = await apiGet<McpToolsResponse>(API.cloudflare.mcpTools);
  return response.tools || [];
}

export async function createMcpTool(data: {
  name: string;
  description?: string;
  serverUrl: string;
  transport: "stdio" | "sse" | "streamable-http";
  config?: Record<string, unknown>;
  source?: string;
}): Promise<UserMcpTool> {
  const response = await apiPost<McpToolResponse>(API.cloudflare.mcpTools, data);
  return response.tool;
}

export async function deleteMcpTool(id: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.mcpTools}/${id}`);
}
