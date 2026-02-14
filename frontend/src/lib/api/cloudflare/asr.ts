// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: asr-api-client-v3-deepgram-token

import { API } from "@/config/env";
import { apiGet, apiPost, apiDelete } from "../client";
import { getAuthHeaders } from "@/stores/auth-store";

export type ASRProvider = "assemblyai" | "openai" | "deepgram";

interface ASRKeyStatusResponse {
  providers: Record<ASRProvider, boolean>;
}

interface TokenResponse {
  token: string;
  expiresIn: number;
}

interface TranscribeResponse {
  text: string;
}

/**
 * Get which ASR providers have keys configured (no values returned).
 */
export async function getASRKeyStatus(): Promise<Record<ASRProvider, boolean>> {
  const response = await apiGet<ASRKeyStatusResponse>(API.cloudflare.asrKeys);
  return response.providers;
}

/**
 * Store an ASR API key (encrypted server-side).
 */
export async function saveASRKey(provider: ASRProvider, apiKey: string): Promise<void> {
  await apiPost(API.cloudflare.asrKeys, { provider, apiKey });
}

/**
 * Delete an ASR API key.
 */
export async function deleteASRKey(provider: ASRProvider): Promise<void> {
  await apiDelete(`${API.cloudflare.asrKeys}/${provider}`);
}

/**
 * Get a temporary AssemblyAI token (valid ~1 hour).
 * The real API key never leaves the server.
 */
export async function getAssemblyAIToken(): Promise<TokenResponse> {
  return apiPost<TokenResponse>(API.cloudflare.asrAssemblyAIToken);
}

/**
 * Get a temporary Deepgram JWT (valid ~30 seconds).
 * Only needs to be valid during the WebSocket handshake — the connection
 * persists independently after that. The real API key never leaves the server.
 */
export async function getDeepgramToken(): Promise<TokenResponse> {
  return apiPost<TokenResponse>(API.cloudflare.asrDeepgramToken);
}

/**
 * Proxy audio transcription through the control plane to OpenAI Whisper.
 * The real API key never leaves the server.
 */
export async function transcribeOpenAI(audioBlob: Blob): Promise<string> {
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.webm");
  formData.append("model", "whisper-1");
  formData.append("response_format", "json");

  const authHeaders = getAuthHeaders();

  const response = await fetch(API.cloudflare.asrOpenAITranscribe, {
    method: "POST",
    headers: {
      ...authHeaders,
      // Do NOT set Content-Type — browser sets it with multipart boundary
    },
    credentials: "include",
    body: formData,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Transcription failed" }));
    throw new Error((data as { error?: string }).error || "Transcription failed");
  }

  const result = (await response.json()) as TranscribeResponse;
  return result.text;
}

/**
 * Proxy audio transcription through the control plane to Deepgram Nova.
 * Used as fallback when token vending fails (key lacks Member scope).
 * The real API key never leaves the server.
 */
export async function transcribeDeepgram(audioBlob: Blob): Promise<string> {
  const authHeaders = getAuthHeaders();

  const response = await fetch(API.cloudflare.asrDeepgramTranscribe, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": audioBlob.type || "audio/webm",
    },
    credentials: "include",
    body: audioBlob,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: "Transcription failed" }));
    throw new Error((data as { error?: string }).error || "Transcription failed");
  }

  const result = (await response.json()) as TranscribeResponse;
  return result.text;
}
