// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { Env } from '../types';

type SandboxFetchOptions = RequestInit & {
  machineId?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;

export function sandboxUrl(env: Env, path: string): URL {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return new URL(path);
  }
  const base = env.SANDBOX_URL.replace(/\/$/, '');
  return new URL(`${base}${path.startsWith('/') ? '' : '/'}${path}`);
}

export function sandboxHeaders(
  env: Env,
  headers?: HeadersInit,
  machineId?: string
): Headers {
  const result = new Headers(headers);
  result.set('X-Internal-Token', env.SANDBOX_INTERNAL_TOKEN);
  if (machineId) {
    result.set('X-Sandbox-Machine-ID', machineId);
  }
  return result;
}

export async function sandboxFetch(
  env: Env,
  path: string,
  options: SandboxFetchOptions = {}
): Promise<Response> {
  const {
    machineId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    headers,
    ...init
  } = options;

  const url = sandboxUrl(env, path);
  const requestHeaders = sandboxHeaders(env, headers, machineId);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url.toString(), {
        ...init,
        headers: requestHeaders,
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError;
}

