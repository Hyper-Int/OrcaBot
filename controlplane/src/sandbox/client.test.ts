/**
 * Sandbox Client Tests
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SandboxClient } from './client';
import { createMockSandboxServer } from '../../tests/mocks/sandbox';

describe('SandboxClient', () => {
  const mockSandbox = createMockSandboxServer();
  const client = new SandboxClient('http://localhost:8080');

  beforeAll(() => {
    mockSandbox.server.listen({ onUnhandledRequest: 'error' });
  });

  afterEach(() => {
    mockSandbox.reset();
  });

  afterAll(() => {
    mockSandbox.server.close();
  });

  describe('health()', () => {
    it('should return true when sandbox is healthy', async () => {
      const result = await client.health();
      expect(result).toBe(true);
    });
  });

  describe('Session Management', () => {
    it('should create a session', async () => {
      const session = await client.createSession();

      expect(session).toHaveProperty('id');
      expect(session.id).toMatch(/^session-\d+$/);
      expect(session.machineId).toBe('machine-1');
    });

    it('should delete a session', async () => {
      const session = await client.createSession();
      await expect(client.deleteSession(session.id)).resolves.not.toThrow();
    });

    it('should handle delete non-existent session gracefully', async () => {
      // deleteSession ignores 404 errors for idempotency
      await expect(client.deleteSession('non-existent')).resolves.not.toThrow();
    });
  });

  // Note: PTY, Agent, and Filesystem operations are accessed directly via sandbox URLs,
  // not proxied through the control plane. See CLAUDE.md for architecture details.
});
