import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";

export interface UserSecret {
  id: string;
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

export async function listSecrets(): Promise<UserSecret[]> {
  const response = await apiGet<SecretsResponse>(API.cloudflare.secrets);
  return response.secrets || [];
}

export async function createSecret(data: {
  name: string;
  value: string;
  description?: string;
}): Promise<UserSecret> {
  const response = await apiPost<SecretResponse>(API.cloudflare.secrets, data);
  return response.secret;
}

export async function deleteSecret(id: string): Promise<void> {
  await apiDelete<void>(`${API.cloudflare.secrets}/${id}`);
}
