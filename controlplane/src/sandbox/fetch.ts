// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: sandbox-fetch-v4-identifier-renames
const MODULE_REVISION = 'sandbox-fetch-v4-identifier-renames';
console.log(`[sandbox-fetch] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import type { Env } from '../types';
import { signSandbоxRequest } from './request-signing';

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

/**
 * Client credentials that must never reach the shared dashboard VM. The proxy
 * routes (PTY/control WS, browser, metrics) pass the browser's own headers, and
 * a VM is shared by every member's terminals, so forwarding these would hand a
 * user's session cookie, PAT, Cloudflare Access JWT or dev-auth identity to
 * whatever runs in the VM. The sandbox authenticates the control plane by
 * X-Sandbox-Auth / X-Internal-Token only (sandbox/internal/auth); it reads none
 * of these on proxied routes (its Bearer check is the legacy static token,
 * which the control plane never sends as Authorization).
 */
const CLIENT_CREDENTIAL_HEADERS = [
  'Cookie',
  'Authorization',
  'Proxy-Authorization',
  'X-Dashboard-Token',
  'Cf-Access-Jwt-Assertion',
  // Dev auth (auth/middleware.ts authenticateDevMode / devAuthSurfaceTrusted)
  'X-User-ID',
  'X-User-Email',
  'X-User-Name',
  'X-Orcabot-Surface',
];

/**
 * Auth + routing headers for a control plane → sandbox request: the per-machine
 * signature (X-Sandbox-Auth) when SANDBOX_AUTH_SIGNING_KEY is set, and the legacy
 * static X-Internal-Token while SANDBOX_INTERNAL_TOKEN is still configured.
 * The signature is bound to method + URL, so pass the exact request target.
 */
export async function sandboxHeaders(
  env: Env,
  headers: HeadersInit | undefined,
  machineId: string | undefined,
  method: string,
  url: string | URL
): Promise<Headers> {
  const result = new Headers(headers);
  for (const name of CLIENT_CREDENTIAL_HEADERS) result.delete(name);
  result.delete('X-Sandbox-Auth');
  result.delete('fly-force-instance-id');
  if (env.SANDBOX_INTERNAL_TOKEN) {
    result.set('X-Internal-Token', env.SANDBOX_INTERNAL_TOKEN);
  } else {
    result.delete('X-Internal-Token');
  }
  if (machineId) {
    result.set('X-Sandbox-Machine-ID', machineId);
  } else {
    result.delete('X-Sandbox-Machine-ID');
  }
  await signSandbоxRequest(env.SANDBOX_AUTH_SIGNING_KEY, result, method, url);
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

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Re-sign per attempt so a retry after a slow failure isn't sent with an expired signature.
    const requestHeaders = await sandboxHeaders(env, headers, machineId, init.method || 'GET', url);
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

