// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

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

import type { DashboardItem, PresenceInfo, CollabMessage, Dashboard, Session, DashboardEdge, UICommand } from '../types';

interface WebSocketAttachment {
  userId: string;
  userName: string;
}

// Rate limiter for error logging to prevent log spam
class RatеLimitedLogger {
  private lastLogTime = 0;
  private suppressedCount = 0;
  private readonly minIntervalMs: number;

  constructor(minIntervalMs = 5000) {
    this.minIntervalMs = minIntervalMs;
  }

  warn(code: string, message: string, detail?: string): void {
    const now = Date.now();
    if (now - this.lastLogTime < this.minIntervalMs) {
      this.suppressedCount++;
      return;
    }

    const suppressed = this.suppressedCount > 0 ? ` (${this.suppressedCount} similar suppressed)` : '';
    console.warn(`${code}: ${message}${suppressed}`, detail ? `- ${detail.substring(0, 100)}` : '');
    this.lastLogTime = now;
    this.suppressedCount = 0;
  }
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
  private edges: Map<string, DashboardEdge> = new Map();
  private pendingBrowserOpenUrl: string | null = null;
  private initPromise: Promise<void>;
  // Rate-limited logger for WebSocket parse errors
  private parseErrorLogger = new RatеLimitedLogger(5000);

  constructor(state: DurableObjectState) {
    this.state = state;

    // Restore state from storage if available
    // Store the promise for explicit await in fetch() as defense-in-depth
    this.initPromise = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<{
        dashboard: Dashboard | null;
        items: [string, DashboardItem][];
        terminalSessions: [string, Session][];
        edges: [string, DashboardEdge][];
        pendingBrowserOpenUrl?: string | null;
      }>('state');

      if (stored) {
        this.dashboard = stored.dashboard;
        this.items = new Map(stored.items);
        this.terminalSessions = new Map(stored.terminalSessions);
        this.edges = new Map(stored.edges);
        this.pendingBrowserOpenUrl = stored.pendingBrowserOpenUrl ?? null;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    // Ensure initialization is complete (defense-in-depth)
    await this.initPromise;
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
        edges?: DashboardEdge[];
      };

      this.dashboard = data.dashboard;
      this.items = new Map(data.items.map(i => [i.id, i]));
      this.terminalSessions = new Map(data.sessions.map(s => [s.id, s]));
      this.edges = new Map((data.edges ?? []).map(e => [e.id, e]));

      await this.persistState();

      return Response.json({ success: true });
    }

    if (path === '/state' && request.method === 'GET') {
      return Response.json({
        dashboard: this.dashboard,
        items: Array.from(this.items.values()),
        presence: Array.from(this.presence.values()),
        sessions: Array.from(this.terminalSessions.values()),
        edges: Array.from(this.edges.values()),
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
      // Use snake_case for frontend
      this.broadcast({ type: 'item_delete', item_id: itemId });
      return Response.json({ success: true });
    }

    if (path === '/session' && request.method === 'PUT') {
      const session = await request.json() as Session;
      this.terminalSessions.set(session.id, session);
      await this.persistState();
      this.broadcast({ type: 'session_update', session });
      return Response.json({ success: true });
    }

    if (path === '/edge' && request.method === 'POST') {
      const edge = await request.json() as DashboardEdge;
      this.edges.set(edge.id, edge);
      await this.persistState();
      this.broadcast({ type: 'edge_create', edge });
      return Response.json({ success: true });
    }

    if (path === '/edge' && request.method === 'DELETE') {
      const { edgeId } = await request.json() as { edgeId: string };
      this.edges.delete(edgeId);
      await this.persistState();
      this.broadcast({ type: 'edge_delete', edge_id: edgeId });
      return Response.json({ success: true });
    }

    if (path === '/browser' && request.method === 'POST') {
      const data = await request.json() as { url?: string };
      const url = typeof data.url === 'string' ? data.url : '';
      if (url) {
        if (this.sessions.size === 0) {
          this.pendingBrowserOpenUrl = url;
          await this.persistState();
        } else {
          this.pendingBrowserOpenUrl = null;
        }
        this.broadcast({ type: 'browser_open', url });
      }
      return Response.json({ success: true });
    }

    // POST /ui-command - Execute a UI command from an agent
    if (path === '/ui-command' && request.method === 'POST') {
      const command = await request.json() as UICommand;

      console.log(`[DashboardDO] Received ui-command: ${command.type}, command_id: ${command.command_id}, connected clients: ${this.sessions.size}`);

      // Broadcast the UI command to all connected clients
      this.broadcast({ type: 'ui_command', command });

      return Response.json({ success: true, command_id: command.command_id });
    }

    // POST /ui-command-result - Send a command result back (from frontend)
    if (path === '/ui-command-result' && request.method === 'POST') {
      const data = await request.json() as {
        command_id: string;
        success: boolean;
        error?: string;
        created_item_id?: string;
      };

      // Broadcast the result to all connected clients (including the originating terminal)
      this.broadcast({
        type: 'ui_command_result',
        command_id: data.command_id,
        success: data.success,
        error: data.error,
        created_item_id: data.created_item_id,
      });

      return Response.json({ success: true });
    }

    // GET /items - List all items (for MCP tools to query current state)
    if (path === '/items' && request.method === 'GET') {
      return Response.json({
        items: Array.from(this.items.values()),
        edges: Array.from(this.edges.values()),
      });
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

      // Notify others of new user (use snake_case for frontend)
      this.broadcast({ type: 'join', user_id: userId, user_name: userName }, ws);
    }

    // Send current state to new client (convert to snake_case for frontend)
    const stateMsg = JSON.stringify({
      type: 'presence',
      users: Array.from(this.presence.values()).map(p => ({
        user_id: p.userId,
        user_name: p.userName,
        cursor: p.cursor,
        selected_item: p.selectedItemId,
      })),
    });
    ws.send(stateMsg);

    if (this.pendingBrowserOpenUrl) {
      const pendingUrl = this.pendingBrowserOpenUrl;
      this.pendingBrowserOpenUrl = null;
      this.persistState().catch(() => {});
      ws.send(JSON.stringify({ type: 'browser_open', url: pendingUrl }));
    }
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
            // Use snake_case for frontend
            this.broadcast({ type: 'cursor', user_id: attachment.userId, x: msg.x, y: msg.y }, ws);
          }
          break;
        }

        case 'select': {
          const presence = this.presence.get(attachment.userId);
          if (presence) {
            presence.selectedItemId = msg.itemId;
            // Use snake_case for frontend
            this.broadcast({ type: 'select', user_id: attachment.userId, item_id: msg.itemId }, ws);
          }
          break;
        }
      }
    } catch (error) {
      // Log parse failures with rate limiting to prevent log spam from misbehaving clients
      const preview = typeof message === 'string' ? message.substring(0, 100) : '[non-string]';
      this.parseErrorLogger.warn(
        'E79801',
        'Failed to parse WebSocket collaboration message',
        preview
      );
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
        // Use snake_case for frontend
        this.broadcast({ type: 'leave', user_id: attachment.userId });
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
    let sentCount = 0;
    for (const [ws] of this.sessions) {
      if (ws !== exclude) {
        try {
          ws.send(msgStr);
          sentCount++;
        } catch {
          // Client disconnected
        }
      }
    }
    if (message.type === 'ui_command') {
      console.log(`[DashboardDO] Broadcast ui_command to ${sentCount} clients`);
    }
  }

  private async persistState(): Promise<void> {
    await this.state.storage.put('state', {
      dashboard: this.dashboard,
      items: Array.from(this.items.entries()),
      terminalSessions: Array.from(this.terminalSessions.entries()),
      edges: Array.from(this.edges.entries()),
      pendingBrowserOpenUrl: this.pendingBrowserOpenUrl,
    });
  }
}
