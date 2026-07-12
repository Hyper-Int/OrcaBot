// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: chat-providers-v1-multi-backend

/**
 * Provider-neutral chat abstraction.
 *
 * The Orcabot chat was hardwired to Gemini's wire format (messages, tools,
 * streaming, tool-call parsing). This layer normalizes those so the same
 * agentic loop can run against Gemini, Anthropic, or OpenAI — whichever key the
 * user has. Each ChatProvider converts canonical <-> its native format
 * internally and yields canonical ChatChunk events.
 */

export type ChatRole = 'user' | 'assistant' | 'tool';

export interface CanonToolCall {
  /** Stable id: real for Anthropic/OpenAI, synthesized for Gemini (name-based). */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Provider-opaque round-trip data (e.g. Gemini thoughtSignature). */
  meta?: Record<string, unknown>;
}

export interface CanonToolResult {
  id: string; // matches CanonToolCall.id
  name: string;
  result: Record<string, unknown>;
  isError?: boolean;
}

export interface CanonMsg {
  role: ChatRole;
  text?: string;
  toolCalls?: CanonToolCall[]; // assistant turns
  toolResults?: CanonToolResult[]; // tool turns
}

/** Canonical tool definition: name + description + JSON Schema for the args. */
export interface ChatToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; meta?: Record<string, unknown> }
  | { type: 'error'; error: string }
  | { type: 'done' };

export interface ChatStreamOpts {
  temperature?: number;
  maxOutputTokens?: number;
}

export type ProviderId = 'gemini' | 'anthropic' | 'openai';

export interface ChatProvider {
  readonly id: ProviderId;
  /** Model id this provider streams against (for logging/telemetry). */
  readonly model: string;
  /**
   * Stream one assistant turn. Converts `messages` to the provider's native
   * format, calls the provider API, and yields canonical chunks. `system` is the
   * system prompt (each provider places it natively).
   */
  streamTurn(
    system: string,
    messages: CanonMsg[],
    tools: ChatToolDef[],
    opts?: ChatStreamOpts,
  ): AsyncGenerator<ChatChunk>;
}
