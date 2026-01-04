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

  describe('PTY Management', () => {
    it('should create a PTY in a session', async () => {
      const session = await client.createSession();
      const pty = await client.createPTY(session.id);

      expect(pty).toHaveProperty('id');
      expect(pty.id).toMatch(/^pty-\d+$/);
    });

    it('should list PTYs in a session', async () => {
      const session = await client.createSession();
      await client.createPTY(session.id);
      await client.createPTY(session.id);

      const ptys = await client.listPTYs(session.id);

      expect(ptys).toHaveLength(2);
    });

    it('should delete a PTY', async () => {
      const session = await client.createSession();
      const pty = await client.createPTY(session.id);

      await expect(client.deletePTY(session.id, pty.id)).resolves.not.toThrow();

      const ptys = await client.listPTYs(session.id);
      expect(ptys).toHaveLength(0);
    });

    it('should generate correct WebSocket URL', () => {
      const url = client.getPTYWebSocketUrl('session-1', 'pty-1', 'user-1');

      expect(url).toBe('ws://localhost:8080/sessions/session-1/ptys/pty-1/ws?user_id=user-1');
    });
  });

  describe('Agent Management', () => {
    it('should start an agent', async () => {
      const session = await client.createSession();
      const agent = await client.startAgent(session.id);

      expect(agent).toHaveProperty('id');
      expect(agent.state).toBe('running');
    });

    it('should get agent status', async () => {
      const session = await client.createSession();
      await client.startAgent(session.id);

      const agent = await client.getAgent(session.id);

      expect(agent).not.toBeNull();
      expect(agent!.state).toBe('running');
    });

    it('should return null for non-existent agent', async () => {
      const session = await client.createSession();
      const agent = await client.getAgent(session.id);

      expect(agent).toBeNull();
    });

    it('should pause an agent', async () => {
      const session = await client.createSession();
      await client.startAgent(session.id);

      const result = await client.pauseAgent(session.id);

      expect(result.state).toBe('paused');
    });

    it('should resume an agent', async () => {
      const session = await client.createSession();
      await client.startAgent(session.id);
      await client.pauseAgent(session.id);

      const result = await client.resumeAgent(session.id);

      expect(result.state).toBe('running');
    });

    it('should stop an agent', async () => {
      const session = await client.createSession();
      await client.startAgent(session.id);

      await expect(client.stopAgent(session.id)).resolves.not.toThrow();

      const agent = await client.getAgent(session.id);
      expect(agent).toBeNull();
    });

    it('should generate correct agent WebSocket URL', () => {
      const url = client.getAgentWebSocketUrl('session-1', 'user-1');

      expect(url).toBe('ws://localhost:8080/sessions/session-1/agent/ws?user_id=user-1');
    });
  });

  describe('Filesystem Operations', () => {
    it('should list files (empty workspace)', async () => {
      const session = await client.createSession();
      const files = await client.listFiles(session.id, '/');

      expect(files).toEqual([]);
    });

    it('should write and read a file', async () => {
      const session = await client.createSession();
      const content = 'Hello, World!';

      await client.writeFile(session.id, '/test.txt', content);

      const result = await client.readFile(session.id, '/test.txt');
      const text = new TextDecoder().decode(result);

      expect(text).toBe(content);
    });

    it('should list files after writing', async () => {
      const session = await client.createSession();
      await client.writeFile(session.id, '/test.txt', 'content');

      const files = await client.listFiles(session.id, '/');

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('test.txt');
    });

    it('should delete a file', async () => {
      const session = await client.createSession();
      await client.writeFile(session.id, '/test.txt', 'content');

      await expect(client.deleteFile(session.id, '/test.txt')).resolves.not.toThrow();

      const files = await client.listFiles(session.id, '/');
      expect(files).toHaveLength(0);
    });

    it('should stat a file', async () => {
      const session = await client.createSession();
      await client.writeFile(session.id, '/test.txt', 'Hello');

      const stat = await client.statFile(session.id, '/test.txt');

      expect(stat.name).toBe('test.txt');
      expect(stat.size).toBe(5);
      expect(stat.is_dir).toBe(false);
    });
  });
});
