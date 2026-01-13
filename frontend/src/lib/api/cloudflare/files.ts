import { API } from "@/config/env";
import { apiGet, apiDelete } from "../client";

export interface SessionFileEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  mod_time: string;
  mode: string;
}

interface ListFilesResponse {
  files: SessionFileEntry[];
}

export async function listSessionFiles(sessionId: string, path: string): Promise<SessionFileEntry[]> {
  const params = new URLSearchParams({ path });
  const url = `${API.cloudflare.base}/sessions/${sessionId}/files?${params.toString()}`;
  const response = await apiGet<ListFilesResponse>(url);
  return response.files || [];
}

export async function deleteSessionFile(sessionId: string, path: string): Promise<void> {
  const params = new URLSearchParams({ path });
  const url = `${API.cloudflare.base}/sessions/${sessionId}/file?${params.toString()}`;
  await apiDelete<void>(url);
}
