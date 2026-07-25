// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-providers-v1-multi-backend

import { decryptSecret, getEncryptionKey, hasEncryptionKey, isEncryptedValue } from '../../crypto/secrets';
import type { Env } from '../../types';
import { GeminiProvider } from './gemini';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import type { ChatProvider } from './types';

interface KeyRow { name: string; value: string }

/** Decrypt whatever provider keys the user has stored (skips anything unreadable). */
async function decryptKeys(env: Env, rows: KeyRow[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!rows.length) return out;
  const canDecrypt = hasEncryptionKey(env);
  let encKey: CryptoKey | undefined;
  for (const row of rows) {
    if (!row.value) continue;
    if (isEncryptedValue(row.value)) {
      if (!canDecrypt) continue;
      try {
        if (!encKey) encKey = await getEncryptionKey(env);
        const dec = await decryptSecret(row.value, encKey);
        if (dec) out[row.name] = dec;
      } catch {
        // skip unreadable key
      }
    } else {
      out[row.name] = row.value;
    }
  }
  return out;
}

/**
 * Pick the chat provider + key.
 *
 * - Cloud (GEMINI_ORCABOT_KEY set): unchanged — prefer the user's own Gemini key
 *   (saves system quota), else the system key. Chat stays on free Gemini; we do
 *   NOT silently spend the user's paid Anthropic/OpenAI key when free Gemini is
 *   available.
 * - Desktop (no system key): use whichever provider key the user brought, in
 *   priority order Gemini → Anthropic → OpenAI (Gemini first: cheap/free tier).
 * - Neither: null → caller returns the CHAT_NO_KEY prompt.
 */
export async function selectChatProvider(env: Env, rows: KeyRow[]): Promise<ChatProvider | null> {
  const keys = await decryptKeys(env, rows);
  const systemGemini = env.GEMINI_ORCABOT_KEY;

  if (systemGemini) {
    return new GeminiProvider(keys.GEMINI_API_KEY || systemGemini);
  }
  if (keys.GEMINI_API_KEY) return new GeminiProvider(keys.GEMINI_API_KEY);
  if (keys.ANTHROPIC_API_KEY) return new AnthropicProvider(keys.ANTHROPIC_API_KEY);
  if (keys.OPENAI_API_KEY) return new OpenAIProvider(keys.OPENAI_API_KEY);
  return null;
}
