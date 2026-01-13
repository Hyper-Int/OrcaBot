/**
 * Dashboard Durable Object Tests
 *
 * Tests for presence tracking with multi-tab support.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock WebSocket for testing
class MockWebSocket {
  sent: string[] = [];
  closed = false;

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

// Extract and test the connection counting logic
describe('Multi-tab Presence Tracking', () => {
  // Simulate the connection counting logic from DurableObject
  let sessions: Map<MockWebSocket, { userId: string; userName: string }>;
  let presence: Map<string, { userId: string; userName: string }>;
  let userConnectionCount: Map<string, number>;
  let broadcastMessages: Array<{ type: string; userId: string }>;

  function handleConnect(ws: MockWebSocket, userId: string, userName: string) {
    sessions.set(ws, { userId, userName });

    const currentCount = userConnectionCount.get(userId) || 0;
    userConnectionCount.set(userId, currentCount + 1);

    const isFirstConnection = currentCount === 0;

    if (isFirstConnection) {
      presence.set(userId, { userId, userName });
      broadcastMessages.push({ type: 'join', userId });
    }
  }

  function handleDisconnect(ws: MockWebSocket) {
    const attachment = sessions.get(ws);
    if (attachment) {
      sessions.delete(ws);

      const currentCount = userConnectionCount.get(attachment.userId) || 1;
      const newCount = currentCount - 1;

      if (newCount <= 0) {
        userConnectionCount.delete(attachment.userId);
        presence.delete(attachment.userId);
        broadcastMessages.push({ type: 'leave', userId: attachment.userId });
      } else {
        userConnectionCount.set(attachment.userId, newCount);
      }
    }
  }

  beforeEach(() => {
    sessions = new Map();
    presence = new Map();
    userConnectionCount = new Map();
    broadcastMessages = [];
  });

  it('should add user to presence on first connection', () => {
    const ws = new MockWebSocket();
    handleConnect(ws, 'user-1', 'Alice');

    expect(presence.has('user-1')).toBe(true);
    expect(userConnectionCount.get('user-1')).toBe(1);
    expect(broadcastMessages).toContainEqual({ type: 'join', userId: 'user-1' });
  });

  it('should not broadcast join on second connection from same user', () => {
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    handleConnect(ws1, 'user-1', 'Alice');
    handleConnect(ws2, 'user-1', 'Alice'); // Second tab

    expect(userConnectionCount.get('user-1')).toBe(2);
    // Should only have one join broadcast
    const joinMessages = broadcastMessages.filter(m => m.type === 'join');
    expect(joinMessages).toHaveLength(1);
  });

  it('should keep presence when closing one of multiple connections', () => {
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    handleConnect(ws1, 'user-1', 'Alice');
    handleConnect(ws2, 'user-1', 'Alice');

    // Close first connection
    handleDisconnect(ws1);

    // User should still be present
    expect(presence.has('user-1')).toBe(true);
    expect(userConnectionCount.get('user-1')).toBe(1);

    // Should not have broadcast leave
    const leaveMessages = broadcastMessages.filter(m => m.type === 'leave');
    expect(leaveMessages).toHaveLength(0);
  });

  it('should remove presence when closing last connection', () => {
    const ws1 = new MockWebSocket();
    const ws2 = new MockWebSocket();

    handleConnect(ws1, 'user-1', 'Alice');
    handleConnect(ws2, 'user-1', 'Alice');

    // Close both connections
    handleDisconnect(ws1);
    handleDisconnect(ws2);

    // User should be gone
    expect(presence.has('user-1')).toBe(false);
    expect(userConnectionCount.has('user-1')).toBe(false);

    // Should have broadcast leave
    const leaveMessages = broadcastMessages.filter(m => m.type === 'leave');
    expect(leaveMessages).toHaveLength(1);
  });

  it('should handle multiple users with multiple tabs', () => {
    const ws1a = new MockWebSocket();
    const ws1b = new MockWebSocket();
    const ws2a = new MockWebSocket();

    handleConnect(ws1a, 'user-1', 'Alice');
    handleConnect(ws1b, 'user-1', 'Alice');
    handleConnect(ws2a, 'user-2', 'Bob');

    expect(presence.size).toBe(2);
    expect(userConnectionCount.get('user-1')).toBe(2);
    expect(userConnectionCount.get('user-2')).toBe(1);

    // Close one of user-1's tabs
    handleDisconnect(ws1a);

    expect(presence.size).toBe(2); // Both users still present
    expect(userConnectionCount.get('user-1')).toBe(1);

    // Close user-2's only tab
    handleDisconnect(ws2a);

    expect(presence.size).toBe(1); // Only user-1 present
    expect(presence.has('user-2')).toBe(false);
  });
});
