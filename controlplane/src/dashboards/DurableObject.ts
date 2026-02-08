// Copyright 2026 Rob Macrae. All rights reserved.
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
 *
 * Supports Durable Object hibernation - WebSocket connections survive
 * hibernation, but in-memory state (sessions, presence, userConnectionCount)
 * must be rehydrated from getWebSockets() on wake.
 */

import type { DashboardItem, PresenceInfo, CollabMessage, Dashboard, Session, DashboardEdge, UICommand } from '../types';

interface WebSocketAttachment {
  userId: string;
  userName: string;
}

// Type for WebSocket with hibernation API methods
interface HibernatingWebSocket extends WebSocket {
  serializeAttachment?: (data: WebSocketAttachment) => void;
  deserializeAttachment?: () => WebSocketAttachment | null;
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

  /**
   * Safely serialize attachment to a WebSocket (hibernation support).
   * No-op if hibernation APIs aren't available.
   */
  private safeSerializeAttachment(ws: WebSocket, attachment: WebSocketAttachment): void {
    const hws = ws as HibernatingWebSocket;
    if (typeof hws.serializeAttachment === 'function') {
      try {
        hws.serializeAttachment(attachment);
      } catch {
        // Serialization not supported in this environment
      }
    }
  }

  /**
   * Safely deserialize attachment from a WebSocket (hibernation support).
   * Returns null if hibernation APIs aren't available or deserialization fails.
   */
  private safeDeserializeAttachment(ws: WebSocket): WebSocketAttachment | null {
    const hws = ws as HibernatingWebSocket;
    if (typeof hws.deserializeAttachment === 'function') {
      try {
        return hws.deserializeAttachment();
      } catch {
        // Deserialization not supported or failed
      }
    }
    return null;
  }

  /**
   * Rehydrate sessions, presence, and userConnectionCount from getWebSockets().
   * Called after hibernation when in-memory state is empty but WebSocket connections exist.
   */
  private rehydrateFromWebSockets(): void {
    const allWebSockets = this.state.getWebSockets();

    // Skip if sessions are already populated
    if (this.sessions.size > 0) {
      return;
    }

    // Skip if no WebSockets to rehydrate from
    if (allWebSockets.length === 0) {
      return;
    }

    console.log(`[DashboardDO] Rehydrating state from ${allWebSockets.length} WebSocket(s)`);

    // Clear and rebuild all connection state
    this.sessions.clear();
    this.presence.clear();
    this.userConnectionCount.clear();

    for (const ws of allWebSockets) {
      const attachment = this.safeDeserializeAttachment(ws);
      if (attachment) {
        // Rebuild sessions map
        this.sessions.set(ws, attachment);

        // Rebuild connection count
        const currentCount = this.userConnectionCount.get(attachment.userId) || 0;
        this.userConnectionCount.set(attachment.userId, currentCount + 1);

        // Rebuild presence (only if not already present for this user)
        if (!this.presence.has(attachment.userId)) {
          this.presence.set(attachment.userId, {
            userId: attachment.userId,
            userName: attachment.userName,
            cursor: null,
            selectedItemId: null,
            connectedAt: new Date().toISOString(),
          });
        }
      }
    }

    console.log(`[DashboardDO] Rehydrated: ${this.sessions.size} sessions, ${this.presence.size} users`);
  }

  /**
   * Get the count of connected WebSockets, accounting for hibernation.
   * Uses getWebSockets() which returns accurate count even after hibernation.
   */
  private getConnectedClientCount(): number {
    return this.state.getWebSockets().length;
  }

  async fetch(request: Request): Promise<Response> {
    // Ensure initialization is complete (defense-in-depth)
    await this.initPromise;

    // Rehydrate WebSocket state if needed (after hibernation)
    this.rehydrateFromWebSockets();

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
        // Use getConnectedClientCount() for accurate count after hibernation
        if (this.getConnectedClientCount() === 0) {
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

    // POST /pending-approval - Notify clients of a new pending approval
    if (path === '/pending-approval' && request.method === 'POST') {
      const data = await request.json() as { secretName: string; domain: string };
      this.broadcast({
        type: 'pending_approval',
        secret_name: data.secretName,
        domain: data.domain,
      });
      return Response.json({ success: true });
    }

    return new Response('Not found', { status: 404 });
  }

  private handleWebSocket(ws: WebSocket, userId: string, userName: string): void {
    const attachment: WebSocketAttachment = { userId, userName };

    // Serialize attachment so it survives hibernation
    this.safeSerializeAttachment(ws, attachment);

    // Accept the WebSocket
    this.state.acceptWebSocket(ws);

    // Store attachment in memory for quick access
    this.sessions.set(ws, attachment);

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

    // Rehydrate state if needed (after hibernation)
    this.rehydrateFromWebSockets();

    // Get attachment from sessions Map
    const attachment = this.sessions.get(ws);
    if (!attachment) return;

    // Ensure user has presence entry (might be missing after rehydration with cursor/select message)
    if (!this.presence.has(attachment.userId)) {
      this.presence.set(attachment.userId, {
        userId: attachment.userId,
        userName: attachment.userName,
        cursor: null,
        selectedItemId: null,
        connectedAt: new Date().toISOString(),
      });
    }

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
    // Rehydrate state if needed (after hibernation) - ensures accurate connection counts
    this.rehydrateFromWebSockets();

    const attachment = this.sessions.get(ws);
    if (!attachment) return;

    this.sessions.delete(ws);

    // Decrement connection count using actual count from userConnectionCount
    const currentCount = this.userConnectionCount.get(attachment.userId) || 0;
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

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws);
  }

  private broadcast(message: CollabMessage, exclude?: WebSocket): void {
    const msgStr = JSON.stringify(message);
    let sentCount = 0;
    // Use getWebSockets() to get all connected WebSockets, including those
    // that survived hibernation but aren't in our sessions Map yet
    const allWebSockets = this.state.getWebSockets();
    for (const ws of allWebSockets) {
      if (ws !== exclude) {
        try {
          ws.send(msgStr);
          sentCount++;
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
      edges: Array.from(this.edges.entries()),
      pendingBrowserOpenUrl: this.pendingBrowserOpenUrl,
    });
  }
}
