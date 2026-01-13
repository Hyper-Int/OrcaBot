/**
 * Rate Limiting Middleware Tests
 */

import { describe, it, expect } from 'vitest';
import { checkRateLimit, checkRateLimitByKey } from './middleware';
import type { Env } from '../types';

describe('Rate Limiting Middleware', () => {
  describe('checkRateLimit()', () => {
    it('should allow request when rate limiter is not configured', async () => {
      const request = new Request('http://localhost/test');
      const env = {} as Env;

      const result = await checkRateLimit(request, env);

      expect(result.allowed).toBe(true);
      expect(result.response).toBeUndefined();
    });

    it('should allow request when under limit', async () => {
      const request = new Request('http://localhost/test', {
        headers: { 'X-User-ID': 'user-1' },
      });
      const env = {
        RATE_LIMITER: {
          limit: async () => ({ success: true }),
        },
      } as unknown as Env;

      const result = await checkRateLimit(request, env);

      expect(result.allowed).toBe(true);
    });

    it('should block request when over limit', async () => {
      const request = new Request('http://localhost/test', {
        headers: { 'X-User-ID': 'user-1' },
      });
      const env = {
        RATE_LIMITER: {
          limit: async () => ({ success: false }),
        },
      } as unknown as Env;

      const result = await checkRateLimit(request, env);

      expect(result.allowed).toBe(false);
      expect(result.response).toBeDefined();
      expect(result.response!.status).toBe(429);
    });

    it('should use user ID as rate limit key when authenticated', async () => {
      let capturedKey = '';
      const request = new Request('http://localhost/test', {
        headers: { 'X-User-ID': 'user-123' },
      });
      const env = {
        RATE_LIMITER: {
          limit: async ({ key }: { key: string }) => {
            capturedKey = key;
            return { success: true };
          },
        },
      } as unknown as Env;

      await checkRateLimit(request, env);

      expect(capturedKey).toBe('user-123');
    });

    it('should use IP as rate limit key when unauthenticated', async () => {
      let capturedKey = '';
      const request = new Request('http://localhost/test', {
        headers: { 'CF-Connecting-IP': '192.168.1.1' },
      });
      const env = {
        RATE_LIMITER: {
          limit: async ({ key }: { key: string }) => {
            capturedKey = key;
            return { success: true };
          },
        },
      } as unknown as Env;

      await checkRateLimit(request, env);

      expect(capturedKey).toBe('ip:192.168.1.1');
    });

    it('should allow request on rate limiter error', async () => {
      const request = new Request('http://localhost/test');
      const env = {
        RATE_LIMITER: {
          limit: async () => {
            throw new Error('Rate limiter unavailable');
          },
        },
      } as unknown as Env;

      const result = await checkRateLimit(request, env);

      expect(result.allowed).toBe(true);
    });
  });

  describe('checkRateLimitByKey()', () => {
    it('should allow when rate limiter is not configured', async () => {
      const env = {} as Env;

      const result = await checkRateLimitByKey('custom-key', env);

      expect(result.allowed).toBe(true);
    });

    it('should use custom key for rate limiting', async () => {
      let capturedKey = '';
      const env = {
        RATE_LIMITER: {
          limit: async ({ key }: { key: string }) => {
            capturedKey = key;
            return { success: true };
          },
        },
      } as unknown as Env;

      await checkRateLimitByKey('api:expensive-operation', env);

      expect(capturedKey).toBe('api:expensive-operation');
    });
  });
});
