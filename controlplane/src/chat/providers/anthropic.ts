// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-providers-v1-multi-backend

/**
 * Anthropic provider — Messages API with streaming + tool use.
 * Docs: system is a top-level param; tools are {name, description, input_schema};
 * assistant tool calls are `tool_use` content blocks; results go back as
 * `tool_result` blocks in a following user message.
 */

import type {
  ChatProvider,
  ChatToolDef,
  ChatChunk,
  ChatStreamOpts,
  CanonMsg,
} from './types';

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

function toAnthropicMessages(messages: CanonMsg[]): Array<{ role: 'user' | 'assistant'; content: Block[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  for (const msg of messages) {
    if (msg.role === 'user' && msg.text) {
      out.push({ role: 'user', content: [{ type: 'text', text: msg.text }] });
    } else if (msg.role === 'assistant') {
      const content: Block[] = [];
      if (msg.text) content.push({ type: 'text', text: msg.text });
      for (const tc of msg.toolCalls || []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      if (content.length) out.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      const content: Block[] = (msg.toolResults || []).map(tr => ({
        type: 'tool_result' as const,
        tool_use_id: tr.id,
        content: JSON.stringify(tr.result),
        is_error: tr.isError || undefined,
      }));
      if (content.length) out.push({ role: 'user', content });
    }
  }
  return out;
}

export class AnthropicProvider implements ChatProvider {
  readonly id = 'anthropic' as const;
  readonly model = ANTHROPIC_MODEL;
  constructor(private apiKey: string) {}

  async *streamTurn(
    system: string,
    messages: CanonMsg[],
    tools: ChatToolDef[],
    opts?: ChatStreamOpts,
  ): AsyncGenerator<ChatChunk> {
    const body = {
      model: ANTHROPIC_MODEL,
      max_tokens: opts?.maxOutputTokens ?? 4096,
      temperature: opts?.temperature ?? 1.0,
      system,
      messages: toAnthropicMessages(messages),
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      stream: true,
    };

    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      yield { type: 'error', error: `Anthropic API error: ${response.status} - ${err}` };
      return;
    }
    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Track in-progress tool_use blocks by content index: accumulate partial JSON.
    const pending: Record<number, { id: string; name: string; json: string }> = {};

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          const type = ev.type as string;
          if (type === 'content_block_start') {
            const idx = ev.index as number;
            const block = ev.content_block as { type: string; id?: string; name?: string };
            if (block?.type === 'tool_use') {
              pending[idx] = { id: block.id || `ant_${idx}`, name: block.name || '', json: '' };
            }
          } else if (type === 'content_block_delta') {
            const idx = ev.index as number;
            const delta = ev.delta as { type: string; text?: string; partial_json?: string };
            if (delta?.type === 'text_delta' && delta.text) {
              yield { type: 'text', text: delta.text };
            } else if (delta?.type === 'input_json_delta' && pending[idx]) {
              pending[idx].json += delta.partial_json || '';
            }
          } else if (type === 'content_block_stop') {
            const idx = ev.index as number;
            const tc = pending[idx];
            if (tc) {
              let args: Record<string, unknown> = {};
              try {
                args = tc.json ? JSON.parse(tc.json) : {};
              } catch {
                args = {};
              }
              yield { type: 'tool_call', id: tc.id, name: tc.name, args };
              delete pending[idx];
            }
          }
          // message_stop / message_delta need no action here.
        }
      }
      yield { type: 'done' };
    } finally {
      reader.releaseLock();
    }
  }
}
