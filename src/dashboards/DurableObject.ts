/**
 * Dashboard Durable Object
 *
 * Manages real-time collaboration for a single dashboard:
 * - User presence (who's online, cursor positions)
 * - Live item updates
 * - Session state notifications
 *
 * NOT a database - can be rebuilt from D1 at any time.
 */

import type { DashboardItem, PresenceInfo, CollabMessage, Dashboard, Session } from '../types';

interface WebSocketAttachment {
  userId: string;
  userName: string;
}

export class DashboardDO implements DurableObject {
  private state: DurableObjectState;
  private sessions: Map<WebSocket, WebSocketAttachment> = new Map();
  private presence: Map<string, PresenceInfo> = new Map();
  // Track connection count per user for multi-tab support
  private userConnectionCount: Map<string, number> = new Map();
  private dashboard: Dashboard | null = null;
  private items: Map<string, DashboardItem> = new Map();
  private terminalSessions: Map<string, Session> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;

    // Restore state from storage if available
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<{
        dashboard: Dashboard | null;
        items: [string, DashboardItem][];
        terminalSessions: [string, Session][];
      }>('state');

      if (stored) {
        this.dashboard = stored.dashboard;
        this.items = new Map(stored.items);
        this.terminalSessions = new Map(stored.terminalSessions);
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade for real-time collaboration
    if (path === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const userId = url.searchParams.get('user_id');
      const userName = url.searchParams.get('user_name') || 'Anonymous';

      if (!userId) {
        return new Response('user_id required', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.handleWebSocket(server, userId, userName);

      return new Response(null, { status: 101, webSocket: client });
    }

    // REST API for dashboard management
    if (path === '/init' && request.method === 'POST') {
      const data = await request.json() as {
        dashboard: Dashboard;
        items: DashboardItem[];
        sessions: Session[];
      };

      this.dashboard = data.dashboard;
      this.items = new Map(data.items.map(i => [i.id, i]));
      this.terminalSessions = new Map(data.sessions.map(s => [s.id, s]));

      await this.persistState();

      return Response.json({ success: true });
    }

    if (path === '/state' && request.method === 'GET') {
      return Response.json({
        dashboard: this.dashboard,
        items: Array.from(this.items.values()),
        presence: Array.from(this.presence.values()),
        sessions: Array.from(this.terminalSessions.values()),
      });
    }

    if (path === '/item' && request.method === 'PUT') {
      const item = await request.json() as DashboardItem;
      this.items.set(item.id, item);
      await this.persistState();
      this.broadcast({ type: 'item_update', item });
      return Response.json({ success: true });
    }

    if (path === '/item' && request.method === 'POST') {
      const item = await request.json() as DashboardItem;
      this.items.set(item.id, item);
      await this.persistState();
      this.broadcast({ type: 'item_create', item });
      return Response.json({ success: true });
    }

    if (path === '/item' && request.method === 'DELETE') {
      const { itemId } = await request.json() as { itemId: string };
      this.items.delete(itemId);
      await this.persistState();
      this.broadcast({ type: 'item_delete', itemId });
      return Response.json({ success: true });
    }

    if (path === '/session' && request.method === 'PUT') {
      const session = await request.json() as Session;
      this.terminalSessions.set(session.id, session);
      await this.persistState();
      this.broadcast({ type: 'session_update', session });
      return Response.json({ success: true });
    }

    return new Response('Not found', { status: 404 });
  }

  private handleWebSocket(ws: WebSocket, userId: string, userName: string): void {
    // Accept the WebSocket
    this.state.acceptWebSocket(ws);

    // Store attachment
    this.sessions.set(ws, { userId, userName });

    // Track connection count for multi-tab support
    const currentCount = this.userConnectionCount.get(userId) || 0;
    this.userConnectionCount.set(userId, currentCount + 1);

    // Only add to presence and notify if this is the first connection for this user
    const isFirstConnection = currentCount === 0;

    if (isFirstConnection) {
      const presenceInfo: PresenceInfo = {
        userId,
        userName,
        cursor: null,
        selectedItemId: null,
        connectedAt: new Date().toISOString(),
      };
      this.presence.set(userId, presenceInfo);

      // Notify others of new user
      this.broadcast({ type: 'join', userId, userName }, ws);
    }

    // Send current state to new client
    const stateMsg = JSON.stringify({
      type: 'presence',
      users: Array.from(this.presence.values()),
    });
    ws.send(stateMsg);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;

    const attachment = this.sessions.get(ws);
    if (!attachment) return;

    try {
      const msg = JSON.parse(message) as CollabMessage;

      switch (msg.type) {
        case 'cursor': {
          const presence = this.presence.get(attachment.userId);
          if (presence) {
            presence.cursor = { x: msg.x, y: msg.y };
            this.broadcast({ type: 'cursor', userId: attachment.userId, x: msg.x, y: msg.y }, ws);
          }
          break;
        }

        case 'select': {
          const presence = this.presence.get(attachment.userId);
          if (presence) {
            presence.selectedItemId = msg.itemId;
            this.broadcast({ type: 'select', userId: attachment.userId, itemId: msg.itemId }, ws);
          }
          break;
        }
      }
    } catch {
      // Ignore invalid messages
    }
  }

  webSocketClose(ws: WebSocket): void {
    const attachment = this.sessions.get(ws);
    if (attachment) {
      this.sessions.delete(ws);

      // Decrement connection count
      const currentCount = this.userConnectionCount.get(attachment.userId) || 1;
      const newCount = currentCount - 1;

      if (newCount <= 0) {
        // Last connection closed - remove presence and notify
        this.userConnectionCount.delete(attachment.userId);
        this.presence.delete(attachment.userId);
        this.broadcast({ type: 'leave', userId: attachment.userId });
      } else {
        // User still has other connections open
        this.userConnectionCount.set(attachment.userId, newCount);
      }
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  private broadcast(message: CollabMessage, exclude?: WebSocket): void {
    const msgStr = JSON.stringify(message);
    for (const [ws] of this.sessions) {
      if (ws !== exclude) {
        try {
          ws.send(msgStr);
        } catch {
          // Client disconnected
        }
      }
    }
  }

  private async persistState(): Promise<void> {
    await this.state.storage.put('state', {
      dashboard: this.dashboard,
      items: Array.from(this.items.entries()),
      terminalSessions: Array.from(this.terminalSessions.entries()),
    });
  }
}
