// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { getAuthHeaders } from "@/stores/auth-store";

/**
 * Request deduplication cache
 * Prevents repeated identical GET requests within a short time window
 */
interface PendingRequest<T> {
  promise: Promise<T>;
  timestamp: number;
}

const pendingRequests = new Map<string, PendingRequest<unknown>>();
const REQUEST_DEDUP_WINDOW_MS = 5000; // 5 seconds - deduplicate identical requests

// Patterns that should be deduplicated (endpoints that can cause storms)
const DEDUP_PATTERNS = [
  '/integrations/',
  '/dashboards/',  // Dashboard fetches can also storm on errors
];

function shouldDeduplicate(url: string, method: string): boolean {
  if (method !== 'GET') return false;
  return DEDUP_PATTERNS.some(pattern => url.includes(pattern));
}

function getCacheKey(url: string, method: string): string {
  return `${method}:${url}`;
}

/**
 * API Error class with status code
 */
export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

/**
 * Fetch wrapper with auth headers, error handling, and request deduplication
 */
export async function apiFetch<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const method = options.method || 'GET';
  const cacheKey = getCacheKey(url, method);

  // Check for deduplicated request
  if (shouldDeduplicate(url, method)) {
    const pending = pendingRequests.get(cacheKey);
    const now = Date.now();

    if (pending && now - pending.timestamp < REQUEST_DEDUP_WINDOW_MS) {
      // Return the cached promise - this prevents duplicate in-flight requests
      return pending.promise as Promise<T>;
    }
  }

  const authHeaders = getAuthHeaders();

  const fetchPromise = (async (): Promise<T> => {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
        ...options.headers,
      },
      credentials: "include",
    });

    if (!response.ok) {
      let errorData: unknown;
      try {
        errorData = await response.json();
      } catch {
        errorData = await response.text();
      }

      const message =
        typeof errorData === "object" &&
        errorData !== null &&
        "error" in errorData
          ? String((errorData as { error: unknown }).error)
          : `Request failed with status ${response.status}`;

      throw new ApiError(response.status, message, errorData);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json();
  })();

  // Cache the promise for deduplication
  if (shouldDeduplicate(url, method)) {
    pendingRequests.set(cacheKey, {
      promise: fetchPromise,
      timestamp: Date.now(),
    });

    // Clean up after the request completes (success or failure)
    fetchPromise.finally(() => {
      // Don't remove immediately - keep for dedup window
      setTimeout(() => {
        const cached = pendingRequests.get(cacheKey);
        if (cached && cached.promise === fetchPromise) {
          pendingRequests.delete(cacheKey);
        }
      }, REQUEST_DEDUP_WINDOW_MS);
    });
  }

  return fetchPromise;
}

/**
 * GET request
 */
export function apiGet<T>(url: string): Promise<T> {
  return apiFetch<T>(url, { method: "GET" });
}

/**
 * POST request
 */
export function apiPost<T>(url: string, data?: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "POST",
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * PUT request
 */
export function apiPut<T>(url: string, data?: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "PUT",
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * PATCH request
 */
export function apiPatch<T>(url: string, data?: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: "PATCH",
    body: data ? JSON.stringify(data) : undefined,
  });
}

/**
 * DELETE request
 */
export function apiDelete<T>(url: string): Promise<T> {
  return apiFetch<T>(url, { method: "DELETE" });
}
