// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: asr-handler-v6-deepgram-rest-fallback

const handlerRevision = "asr-handler-v6-deepgram-rest-fallback";
console.log(`[asr] REVISION: ${handlerRevision} loaded at ${new Date().toISOString()}`);

import type { Env } from '../types';
import { getEncryptionKey, encryptSecret, decryptSecret, isEncryptedValue, hasEncryptionKey } from '../crypto/secrets';
import { autoApplySecretsToSessions } from '../secrets/handler';

const GLOBAL_DASHBOARD_ID = '_global';

type ASRProvider = 'assemblyai' | 'openai' | 'deepgram';

// Standard env var name for each ASR provider — shared with terminal secrets.
// Legacy _asr_* names are migrated to these in schema.ts on startup.
const ASR_PROVIDER_SECRET_MAP: Record<ASRProvider, string> = {
  openai: 'OPENAI_API_KEY',
  assemblyai: 'ASSEMBLYAI_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================
// Key Management
// ============================================

/**
 * GET /asr/keys — List which ASR providers have keys configured (no values).
 */
export async function listASRKeys(env: Env, userId: string): Promise<Response> {
  const providers: ASRProvider[] = ['assemblyai', 'openai', 'deepgram'];
  const names = providers.map(p => ASR_PROVIDER_SECRET_MAP[p]);
  const placeholders = names.map(() => '?').join(',');

  const result = await env.DB.prepare(
    `SELECT name FROM user_secrets WHERE user_id = ? AND dashboard_id = ? AND name IN (${placeholders}) AND type = 'secret'`
  ).bind(userId, GLOBAL_DASHBOARD_ID, ...names).all();

  const foundNames = new Set(result.results.map((r) => (r as { name: string }).name));

  const configured: Record<string, boolean> = {};
  for (const p of providers) {
    configured[p] = foundNames.has(ASR_PROVIDER_SECRET_MAP[p]);
  }

  return jsonResponse({ providers: configured });
}

/**
 * POST /asr/keys — Store (upsert) an ASR API key under the standard env var name.
 * e.g. openai → OPENAI_API_KEY at _global scope (visible in terminal secrets too).
 */
export async function saveASRKey(
  env: Env,
  userId: string,
  data: { provider: string; apiKey: string }
): Promise<Response> {
  const provider = data.provider as ASRProvider;
  if (!['assemblyai', 'openai', 'deepgram'].includes(provider)) {
    return jsonResponse({ error: 'Invalid provider' }, 400);
  }
  if (!data.apiKey || typeof data.apiKey !== 'string' || data.apiKey.trim().length === 0) {
    return jsonResponse({ error: 'API key is required' }, 400);
  }
  if (!hasEncryptionKey(env)) {
    return jsonResponse({ error: 'Encryption not configured' }, 500);
  }

  const key = await getEncryptionKey(env);
  const encryptedValue = await encryptSecret(data.apiKey.trim(), key);
  const name = ASR_PROVIDER_SECRET_MAP[provider]; // e.g. "OPENAI_API_KEY"
  const now = new Date().toISOString();

  // Atomic upsert via unique index on (user_id, dashboard_id, name)
  const id = `sec_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await env.DB.prepare(
    `INSERT INTO user_secrets (id, user_id, dashboard_id, name, value, description, type, broker_protected, encrypted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'secret', 1, ?, ?, ?)
     ON CONFLICT(user_id, dashboard_id, name) DO UPDATE SET
       value = excluded.value,
       type = excluded.type,
       broker_protected = excluded.broker_protected,
       encrypted_at = excluded.encrypted_at,
       updated_at = excluded.updated_at`
  ).bind(id, userId, GLOBAL_DASHBOARD_ID, name, encryptedValue, `${provider} API key`, now, now, now).run();

  // Push to active terminal sessions so the key is available immediately
  autoApplySecretsToSessions(env, userId, GLOBAL_DASHBOARD_ID).catch(err => {
    console.error('[asr] Background auto-apply failed:', err);
  });

  return jsonResponse({ success: true });
}

/**
 * DELETE /asr/keys/:provider — Remove an ASR key.
 */
export async function deleteASRKey(
  env: Env,
  userId: string,
  provider: string
): Promise<Response> {
  if (!['assemblyai', 'openai', 'deepgram'].includes(provider)) {
    return jsonResponse({ error: 'Invalid provider' }, 400);
  }

  const p = provider as ASRProvider;
  await env.DB.prepare(
    `DELETE FROM user_secrets WHERE user_id = ? AND dashboard_id = ? AND name = ? AND type = 'secret'`
  ).bind(userId, GLOBAL_DASHBOARD_ID, ASR_PROVIDER_SECRET_MAP[p]).run();

  // Push updated secrets to active terminal sessions
  autoApplySecretsToSessions(env, userId, GLOBAL_DASHBOARD_ID).catch(err => {
    console.error('[asr] Background auto-apply failed:', err);
  });

  return jsonResponse({ success: true });
}

// ============================================
// Internal: Decrypt ASR key for a user
// ============================================

async function getASRKey(env: Env, userId: string, provider: ASRProvider): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT value FROM user_secrets WHERE user_id = ? AND dashboard_id = ? AND name = ? AND type = 'secret'`
  ).bind(userId, GLOBAL_DASHBOARD_ID, ASR_PROVIDER_SECRET_MAP[provider]).first<{ value: string }>();

  if (!row) return null;

  if (isEncryptedValue(row.value)) {
    const key = await getEncryptionKey(env);
    return decryptSecret(row.value, key);
  }
  return row.value;
}

// ============================================
// Token Vending: AssemblyAI
// ============================================

/**
 * POST /asr/assemblyai/token — Exchange stored API key for a temporary AssemblyAI token.
 */
export async function getAssemblyAIToken(env: Env, userId: string): Promise<Response> {
  const apiKey = await getASRKey(env, userId, 'assemblyai');
  if (!apiKey) {
    return jsonResponse({ error: 'AssemblyAI API key not configured' }, 404);
  }

  const tokenResponse = await fetch('https://api.assemblyai.com/v2/realtime/token', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expires_in: 3600 }),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    return jsonResponse({ error: `AssemblyAI token exchange failed: ${text}` }, 502);
  }

  const { token } = await tokenResponse.json() as { token: string };
  return jsonResponse({ token, expiresIn: 3600 });
}

// ============================================
// HTTP Proxy: OpenAI Whisper
// ============================================

/**
 * POST /asr/openai/transcribe — Proxy audio transcription to OpenAI Whisper.
 * Accepts raw FormData from the client (audio file + model params).
 */
const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB (OpenAI Whisper limit)
const ALLOWED_MODELS = ['whisper-1'];
// Only allow JSON-based formats — we parse the response as JSON to extract text
const ALLOWED_RESPONSE_FORMATS = ['json', 'verbose_json'];

export async function transcribeOpenAI(env: Env, userId: string, request: Request): Promise<Response> {
  const apiKey = await getASRKey(env, userId, 'openai');
  if (!apiKey) {
    return jsonResponse({ error: 'OpenAI API key not configured' }, 404);
  }

  // Reject oversized payloads before parsing
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_AUDIO_SIZE) {
    return jsonResponse({ error: `File too large (max ${MAX_AUDIO_SIZE / 1024 / 1024}MB)` }, 413);
  }

  const formData = await request.formData();

  // Rebuild FormData with validated params
  const upstreamForm = new FormData();
  const audioFile = formData.get('file');
  if (!audioFile || typeof audioFile === 'string') {
    return jsonResponse({ error: 'No audio file provided' }, 400);
  }
  if ((audioFile as File).size > MAX_AUDIO_SIZE) {
    return jsonResponse({ error: `File too large (max ${MAX_AUDIO_SIZE / 1024 / 1024}MB)` }, 413);
  }

  // Allowlist model and response format — don't forward arbitrary client values
  const requestedModel = (formData.get('model') as string) || 'whisper-1';
  const requestedFormat = (formData.get('response_format') as string) || 'json';
  if (!ALLOWED_MODELS.includes(requestedModel)) {
    return jsonResponse({ error: `Unsupported model. Allowed: ${ALLOWED_MODELS.join(', ')}` }, 400);
  }
  if (!ALLOWED_RESPONSE_FORMATS.includes(requestedFormat)) {
    return jsonResponse({ error: `Unsupported response format. Allowed: ${ALLOWED_RESPONSE_FORMATS.join(', ')}` }, 400);
  }

  // Preserve MIME type — Workers FormData can lose content-type when re-appending File objects.
  // Re-wrap as Blob with explicit type so OpenAI recognises the format.
  const file = audioFile as File;
  const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/webm' });
  upstreamForm.append('file', blob, file.name || 'audio.webm');
  upstreamForm.append('model', requestedModel);
  upstreamForm.append('response_format', requestedFormat);

  const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: upstreamForm,
  });

  if (!whisperResponse.ok) {
    const text = await whisperResponse.text();
    return jsonResponse({ error: `OpenAI transcription failed: ${text}` }, 502);
  }

  const result = await whisperResponse.json() as { text: string };
  return jsonResponse({ text: result.text });
}

// ============================================
// Token Vending: Deepgram
// ============================================

/**
 * POST /asr/deepgram/token — Exchange stored API key for a temporary Deepgram JWT.
 * The browser then connects directly to wss://api.deepgram.com with this token.
 * Token only needs to be valid during the WebSocket handshake — the connection
 * persists independently after that.
 */
export async function getDeepgramToken(env: Env, userId: string): Promise<Response> {
  const apiKey = await getASRKey(env, userId, 'deepgram');
  if (!apiKey) {
    return jsonResponse({ error: 'Deepgram API key not configured' }, 404);
  }

  const tokenResponse = await fetch('https://api.deepgram.com/v1/auth/grant', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ttl_seconds: 30 }),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    console.error(`[asr] Deepgram token exchange failed: ${text}`);
    return jsonResponse({ error: `Deepgram token exchange failed: ${text}` }, 502);
  }

  const data = await tokenResponse.json() as { access_token: string; expires_in: number };
  return jsonResponse({ token: data.access_token, expiresIn: data.expires_in });
}

// ============================================
// HTTP Proxy: Deepgram REST (fallback for keys without Member scope)
// ============================================

/**
 * POST /asr/deepgram/transcribe — Proxy audio transcription to Deepgram Nova.
 * Used as a fallback when token vending fails (key lacks Member scope).
 * Accepts raw audio body from the client.
 */
export async function transcribeDeepgram(env: Env, userId: string, request: Request): Promise<Response> {
  const apiKey = await getASRKey(env, userId, 'deepgram');
  if (!apiKey) {
    return jsonResponse({ error: 'Deepgram API key not configured' }, 404);
  }

  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_AUDIO_SIZE) {
    return jsonResponse({ error: `File too large (max ${MAX_AUDIO_SIZE / 1024 / 1024}MB)` }, 413);
  }

  const audioData = await request.arrayBuffer();
  if (audioData.byteLength === 0) {
    return jsonResponse({ error: 'No audio data provided' }, 400);
  }
  if (audioData.byteLength > MAX_AUDIO_SIZE) {
    return jsonResponse({ error: `File too large (max ${MAX_AUDIO_SIZE / 1024 / 1024}MB)` }, 413);
  }

  const contentType = request.headers.get('Content-Type') || 'audio/webm';

  const dgResponse = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': contentType,
      },
      body: audioData,
    }
  );

  if (!dgResponse.ok) {
    const text = await dgResponse.text();
    return jsonResponse({ error: `Deepgram transcription failed: ${text}` }, 502);
  }

  const result = await dgResponse.json() as {
    results: { channels: Array<{ alternatives: Array<{ transcript: string }> }> };
  };
  const transcript = result.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  return jsonResponse({ text: transcript });
}
