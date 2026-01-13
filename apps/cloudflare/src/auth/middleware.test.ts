/**
 * Auth Middleware Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { authenticate, requireAuth, AuthContext } from './middleware';
import { createTestContext, seedUser } from '../../tests/helpers';
import type { TestContext } from '../../tests/helpers';

describe('Auth Middleware', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  describe('authenticate()', () => {
    it('should return unauthenticated when no user ID header', async () => {
      const request = new Request('http://localhost/test');
      const result = await authenticate(request, ctx.env);

      expect(result.isAuthenticated).toBe(false);
      expect(result.user).toBeNull();
    });

    it('should return unauthenticated when user not in DB and no email', async () => {
      const request = new Request('http://localhost/test', {
        headers: { 'X-User-ID': 'unknown-user' },
      });
      const result = await authenticate(request, ctx.env);

      expect(result.isAuthenticated).toBe(false);
      expect(result.user).toBeNull();
    });

    it('should auto-create user when email provided but user not in DB', async () => {
      const request = new Request('http://localhost/test', {
        headers: {
          'X-User-ID': 'new-user',
          'X-User-Email': 'new@example.com',
          'X-User-Name': 'New User',
        },
      });

      const result = await authenticate(request, ctx.env);

      expect(result.isAuthenticated).toBe(true);
      expect(result.user).not.toBeNull();
      expect(result.user!.id).toBe('new-user');
      expect(result.user!.email).toBe('new@example.com');
      expect(result.user!.name).toBe('New User');
    });

    it('should return existing user from DB', async () => {
      await seedUser(ctx.db, {
        id: 'existing-user',
        email: 'existing@example.com',
        name: 'Existing User',
      });

      const request = new Request('http://localhost/test', {
        headers: { 'X-User-ID': 'existing-user' },
      });

      const result = await authenticate(request, ctx.env);

      expect(result.isAuthenticated).toBe(true);
      expect(result.user!.id).toBe('existing-user');
      expect(result.user!.email).toBe('existing@example.com');
    });

    it('should use Anonymous as default name', async () => {
      const request = new Request('http://localhost/test', {
        headers: {
          'X-User-ID': 'anon-user',
          'X-User-Email': 'anon@example.com',
        },
      });

      const result = await authenticate(request, ctx.env);

      expect(result.user!.name).toBe('Anonymous');
    });
  });

  describe('requireAuth()', () => {
    it('should return null for authenticated context', () => {
      const authCtx: AuthContext = {
        isAuthenticated: true,
        user: { id: 'user-1', email: 'test@example.com', name: 'Test', createdAt: '' },
      };

      const result = requireAuth(authCtx);

      expect(result).toBeNull();
    });

    it('should return 401 response for unauthenticated context', () => {
      const authCtx: AuthContext = {
        isAuthenticated: false,
        user: null,
      };

      const result = requireAuth(authCtx);

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it('should return 401 response when authenticated but no user', () => {
      const authCtx: AuthContext = {
        isAuthenticated: true,
        user: null,
      };

      const result = requireAuth(authCtx);

      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });
  });
});
