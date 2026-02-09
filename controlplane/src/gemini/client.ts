// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: gemini-v6-remove-debug-log

/**
 * Gemini 3 API Client
 *
 * Provides streaming chat completions with tool calling support.
 * Used by the Orcabot chat interface for platform orchestration.
 */

console.log(`[gemini] REVISION: gemini-v6-remove-debug-log loaded at ${new Date().toISOString()}`);

// Gemini API types
export interface GeminiConfig {
  model: 'gemini-3-flash' | 'gemini-3-flash-preview' | 'gemini-3-pro';
  thinkingLevel?: 'low' | 'high';
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GeminiTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface GeminiMessage {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface GeminiStreamChunk {
  type: 'text' | 'function_call' | 'done' | 'error';
  text?: string;
  functionCall?: GeminiFunctionCall;
  thoughtSignature?: string;
  error?: string;
}

// Map model names to API model IDs
const MODEL_IDS: Record<GeminiConfig['model'], string> = {
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
  'gemini-3-pro': 'gemini-3-pro-preview',
};

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Convert MCP-style tools to Gemini function declarations
 */
function convertToolsToGemini(tools: GeminiTool[]): object {
  return {
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  };
}

/**
 * Build generation config for Gemini API
 */
function buildGenerationConfig(config: GeminiConfig): object {
  const generationConfig: Record<string, unknown> = {};

  if (config.temperature !== undefined) {
    generationConfig.temperature = config.temperature;
  }

  if (config.maxOutputTokens !== undefined) {
    generationConfig.maxOutputTokens = config.maxOutputTokens;
  }

  // Enable thinking for thought signatures (required for function calling in Gemini 3)
  if (config.thinkingLevel) {
    generationConfig.thinkingConfig = {
      thinkingBudget: config.thinkingLevel === 'high' ? 8192 : 1024,
      includeThoughts: true,
    };
  }

  return generationConfig;
}

/**
 * Streaming chat completion with Gemini 3
 *
 * @param apiKey - Gemini API key
 * @param messages - Conversation history
 * @param tools - Available tools (MCP format)
 * @param config - Model configuration
 * @returns AsyncGenerator yielding stream chunks
 */
export async function* streamChat(
  apiKey: string,
  messages: GeminiMessage[],
  tools: GeminiTool[],
  config: GeminiConfig
): AsyncGenerator<GeminiStreamChunk> {
  const modelId = MODEL_IDS[config.model];
  const url = `${GEMINI_API_BASE}/models/${modelId}:streamGenerateContent?alt=sse`;

  const body: Record<string, unknown> = {
    contents: messages,
    generationConfig: buildGenerationConfig(config),
  };

  if (tools.length > 0) {
    body.tools = [convertToolsToGemini(tools)];
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    yield { type: 'error', error: `Gemini API error: ${response.status} - ${error}` };
    return;
  }

  if (!response.body) {
    yield { type: 'error', error: 'No response body' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedFunctionCall: GeminiFunctionCall | null = null;
  let accumulatedThoughtSignature: string | undefined = undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const candidate = parsed.candidates?.[0];
            if (!candidate) continue;

            const parts = candidate.content?.parts || [];
            for (const part of parts) {
              if (part.text) {
                yield { type: 'text', text: part.text };
              } else if (part.functionCall) {
                accumulatedFunctionCall = {
                  name: part.functionCall.name,
                  args: part.functionCall.args || {},
                };
                // Capture thoughtSignature - check multiple locations
                const sig = part.thoughtSignature || part.functionCall.thoughtSignature || candidate.thoughtSignature;
                if (sig) {
                  accumulatedThoughtSignature = sig;
                  accumulatedFunctionCall.thoughtSignature = sig;
                }
              } else if (part.thoughtSignature) {
                // thoughtSignature might come as its own part
                accumulatedThoughtSignature = part.thoughtSignature;
              }
            }

            // Also check for thoughtSignature at candidate level
            if (candidate.thoughtSignature && !accumulatedThoughtSignature) {
              accumulatedThoughtSignature = candidate.thoughtSignature;
            }

            // Check for finish reason
            if (candidate.finishReason === 'STOP' || candidate.finishReason === 'MAX_TOKENS') {
              if (accumulatedFunctionCall) {
                yield {
                  type: 'function_call',
                  functionCall: accumulatedFunctionCall,
                  thoughtSignature: accumulatedThoughtSignature,
                };
                accumulatedFunctionCall = null;
                accumulatedThoughtSignature = undefined;
              }
            }
          } catch {
            // Ignore JSON parse errors for partial chunks
          }
        }
      }
    }

    // Yield any remaining function call
    if (accumulatedFunctionCall) {
      yield {
        type: 'function_call',
        functionCall: accumulatedFunctionCall,
        thoughtSignature: accumulatedThoughtSignature,
      };
    }

    yield { type: 'done' };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Non-streaming chat completion (for simpler use cases)
 */
export async function chat(
  apiKey: string,
  messages: GeminiMessage[],
  tools: GeminiTool[],
  config: GeminiConfig
): Promise<{ text?: string; functionCall?: GeminiFunctionCall; error?: string }> {
  const modelId = MODEL_IDS[config.model];
  const url = `${GEMINI_API_BASE}/models/${modelId}:generateContent`;

  const body: Record<string, unknown> = {
    contents: messages,
    generationConfig: buildGenerationConfig(config),
  };

  if (tools.length > 0) {
    body.tools = [convertToolsToGemini(tools)];
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    return { error: `Gemini API error: ${response.status} - ${error}` };
  }

  const data = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> } }>;
      };
    }>;
  };

  const parts = data.candidates?.[0]?.content?.parts || [];
  let text = '';
  let functionCall: GeminiFunctionCall | undefined;

  for (const part of parts) {
    if (part.text) {
      text += part.text;
    } else if (part.functionCall) {
      functionCall = {
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      };
    }
  }

  return { text: text || undefined, functionCall };
}

/**
 * Build a function response message to send back tool results
 */
export function buildFunctionResponse(
  name: string,
  response: Record<string, unknown>
): GeminiMessage {
  return {
    role: 'user',
    parts: [{ functionResponse: { name, response } }],
  };
}

/**
 * Build a text message
 */
export function buildTextMessage(role: 'user' | 'model', text: string): GeminiMessage {
  return {
    role,
    parts: [{ text }],
  };
}

/**
 * Build a function call message (model response)
 * thoughtSignature is required by Gemini 3 when using tools
 */
export function buildFunctionCallMessage(
  name: string,
  args: Record<string, unknown>,
  thoughtSignature?: string
): GeminiMessage {
  const part: GeminiPart = { functionCall: { name, args } };
  if (thoughtSignature) {
    (part as { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }).thoughtSignature = thoughtSignature;
  }
  return {
    role: 'model',
    parts: [part],
  };
}
