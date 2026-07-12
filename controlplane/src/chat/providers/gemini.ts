// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-providers-v1-multi-backend

/**
 * Gemini provider — thin adapter over the existing (tested) gemini/client.ts.
 * Preserves current behavior exactly: system prompt as a priming user/model
 * pair, thoughtSignature round-tripped through CanonToolCall.meta.
 */

import {
  streamChat,
  buildTextMessage,
  buildFunctionCallMessage,
  buildFunctionResponse,
  type GeminiMessage,
  type GeminiTool,
} from '../../gemini/client';
import type {
  ChatProvider,
  ChatToolDef,
  ChatChunk,
  ChatStreamOpts,
  CanonMsg,
} from './types';

const GEMINI_MODEL = 'gemini-3-flash' as const;

function toGeminiTools(tools: ChatToolDef[]): GeminiTool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
}

function toGeminiMessages(system: string, messages: CanonMsg[]): GeminiMessage[] {
  // Gemini has no system role — prime with a user/model pair (current behavior).
  const out: GeminiMessage[] = [
    buildTextMessage('user', system),
    buildTextMessage('model', 'Ready.'),
  ];
  // Gemini 3 requires a thoughtSignature on every function call replayed in
  // history. Drop calls without one AND their paired results (matched by id) so
  // we never emit an orphaned functionResponse, which the API rejects.
  const emitted = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'user' && msg.text) {
      out.push(buildTextMessage('user', msg.text));
    } else if (msg.role === 'assistant') {
      if (msg.text) out.push(buildTextMessage('model', msg.text));
      for (const tc of msg.toolCalls || []) {
        const sig = typeof tc.meta?.thoughtSignature === 'string' ? tc.meta.thoughtSignature : undefined;
        if (!sig) continue;
        out.push(buildFunctionCallMessage(tc.name, tc.args, sig));
        emitted.add(tc.id);
      }
    } else if (msg.role === 'tool') {
      for (const tr of msg.toolResults || []) {
        if (!emitted.has(tr.id)) continue;
        out.push(buildFunctionResponse(tr.name, tr.result));
      }
    }
  }
  return out;
}

export class GeminiProvider implements ChatProvider {
  readonly id = 'gemini' as const;
  readonly model = GEMINI_MODEL;
  constructor(private apiKey: string) {}

  async *streamTurn(
    system: string,
    messages: CanonMsg[],
    tools: ChatToolDef[],
    opts?: ChatStreamOpts,
  ): AsyncGenerator<ChatChunk> {
    const geminiMessages = toGeminiMessages(system, messages);
    let synth = 0;
    for await (const chunk of streamChat(this.apiKey, geminiMessages, toGeminiTools(tools), {
      model: GEMINI_MODEL,
      thinkingLevel: 'low',
      temperature: opts?.temperature ?? 1.0,
      maxOutputTokens: opts?.maxOutputTokens ?? 4096,
    })) {
      if (chunk.type === 'text' && chunk.text) {
        yield { type: 'text', text: chunk.text };
      } else if (chunk.type === 'function_call' && chunk.functionCall) {
        const sig = chunk.thoughtSignature || chunk.functionCall.thoughtSignature;
        yield {
          type: 'tool_call',
          id: `gem_${Date.now()}_${synth++}`, // Gemini is name-based; synthesize an id
          name: chunk.functionCall.name,
          args: chunk.functionCall.args,
          meta: sig ? { thoughtSignature: sig } : undefined,
        };
      } else if (chunk.type === 'error') {
        yield { type: 'error', error: chunk.error || 'Gemini error' };
      } else if (chunk.type === 'done') {
        yield { type: 'done' };
      }
    }
  }
}
