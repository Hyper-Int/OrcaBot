// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-providers-v1-multi-backend

/**
 * OpenAI provider — Chat Completions API with streaming + tool calls.
 * system is a message; tools are {type:'function', function:{...}}; assistant
 * tool calls stream as `tool_calls` deltas accumulated by index; results go back
 * as `{role:'tool', tool_call_id}` messages.
 */

import type {
  ChatProvider,
  ChatToolDef,
  ChatChunk,
  ChatStreamOpts,
  CanonMsg,
} from './types';

const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function toOpenAIMessages(system: string, messages: CanonMsg[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: 'system', content: system }];
  for (const msg of messages) {
    if (msg.role === 'user' && msg.text) {
      out.push({ role: 'user', content: msg.text });
    } else if (msg.role === 'assistant') {
      const toolCalls = (msg.toolCalls || []).map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
      out.push({
        role: 'assistant',
        content: msg.text || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      });
    } else if (msg.role === 'tool') {
      for (const tr of msg.toolResults || []) {
        out.push({ role: 'tool', tool_call_id: tr.id, content: JSON.stringify(tr.result) });
      }
    }
  }
  return out;
}

export class OpenAIProvider implements ChatProvider {
  readonly id = 'openai' as const;
  readonly model = OPENAI_MODEL;
  constructor(private apiKey: string) {}

  async *streamTurn(
    system: string,
    messages: CanonMsg[],
    tools: ChatToolDef[],
    opts?: ChatStreamOpts,
  ): AsyncGenerator<ChatChunk> {
    const body = {
      model: OPENAI_MODEL,
      messages: toOpenAIMessages(system, messages),
      tools: tools.map(t => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
      stream: true,
      temperature: opts?.temperature ?? 1.0,
      max_tokens: opts?.maxOutputTokens ?? 4096,
    };

    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      yield { type: 'error', error: `OpenAI API error: ${response.status} - ${err}` };
      return;
    }
    if (!response.body) {
      yield { type: 'error', error: 'No response body' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // Accumulate streamed tool calls by index: id + name arrive first, arguments stream in fragments.
    const pending: Record<number, { id: string; name: string; args: string }> = {};

    const flushToolCalls = function* (): Generator<ChatChunk> {
      for (const idx of Object.keys(pending).map(Number).sort((a, b) => a - b)) {
        const tc = pending[idx];
        let args: Record<string, unknown> = {};
        try {
          args = tc.args ? JSON.parse(tc.args) : {};
        } catch {
          args = {};
        }
        yield { type: 'tool_call', id: tc.id || `oai_${idx}`, name: tc.name, args };
      }
    };

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
          if (!data) continue;
          if (data === '[DONE]') {
            yield* flushToolCalls();
            yield { type: 'done' };
            return;
          }
          let ev: { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }> };
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          const choice = ev.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta;
          if (delta?.content) {
            yield { type: 'text', text: delta.content };
          }
          for (const tcDelta of delta?.tool_calls || []) {
            const idx = tcDelta.index;
            if (!pending[idx]) pending[idx] = { id: '', name: '', args: '' };
            if (tcDelta.id) pending[idx].id = tcDelta.id;
            if (tcDelta.function?.name) pending[idx].name += tcDelta.function.name;
            if (tcDelta.function?.arguments) pending[idx].args += tcDelta.function.arguments;
          }
          if (choice.finish_reason) {
            yield* flushToolCalls();
          }
        }
      }
      yield { type: 'done' };
    } finally {
      reader.releaseLock();
    }
  }
}
