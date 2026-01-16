/**
 * Rate Limiting Middleware Tests
 */

import { describe, it, expect } from 'vitest';
import { checkRateLimitIp, checkRateLimitUser, checkRatеLimitByKey } from './middleware';
import type { Env } from '../types';

describe('Rate Limiting Middleware', () => {
  describe('checkRateLimitIp()', () => {
    it('should allow request when rate limiter is not configured', async () => {
      const request = new Request('http://localhost/test');
      const env = {} as Env;

      const result = await checkRateLimitIp(request, env);

      expect(result.allowed).toBe(true);
      expect(result.response).toBeUndefined();
    });

    it('should allow request when under limit', async () => {
      const request = new Request('http://localhost/test');
      const env = {
        RATE_LIMITER: {
          limit: async () => ({ success: true }),
        },
      } as unknown as Env;

      const result = await checkRateLimitIp(request, env);

      expect(result.allowed).toBe(true);
    });

    it('should block request when over limit', async () => {
      const request = new Request('http://localhost/test');
      const env = {
        RATE_LIMITER: {
          limit: async () => ({ success: false }),
        },
      } as unknown as Env;

      const result = await checkRateLimitIp(request, env);

      expect(result.allowed).toBe(false);
      expect(result.response).toBeDefined();
      expect(result.response!.status).toBe(429);
    });

    it('should use IP as rate limit key', async () => {
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

      await checkRateLimitIp(request, env);

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

      const result = await checkRateLimitIp(request, env);

      expect(result.allowed).toBe(true);
    });
  });

  describe('checkRateLimitUser()', () => {
    it('should allow when rate limiter is not configured', async () => {
      const env = {} as Env;

      const result = await checkRateLimitUser('user-1', env);

      expect(result.allowed).toBe(true);
    });

    it('should use user ID as rate limit key', async () => {
      let capturedKey = '';
      const env = {
        RATE_LIMITER_AUTH: {
          limit: async ({ key }: { key: string }) => {
            capturedKey = key;
            return { success: true };
          },
        },
      } as unknown as Env;

      await checkRateLimitUser('user-123', env);

      expect(capturedKey).toBe('user:user-123');
    });

    it('should block when over limit', async () => {
      const env = {
        RATE_LIMITER_AUTH: {
          limit: async () => ({ success: false }),
        },
      } as unknown as Env;

      const result = await checkRateLimitUser('user-1', env);

      expect(result.allowed).toBe(false);
      expect(result.response).toBeDefined();
      expect(result.response!.status).toBe(429);
    });
  });

  describe('checkRatеLimitByKey()', () => {
    it('should allow when rate limiter is not configured', async () => {
      const env = {} as Env;

      const result = await checkRatеLimitByKey('custom-key', env);

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

      await checkRatеLimitByKey('api:expensive-operation', env);

      expect(capturedKey).toBe('api:expensive-operation');
    });
  });
});
