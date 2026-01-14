/**
 * Mock Sandbox Server for testing
 *
 * Simulates the Go sandbox backend at localhost:8080
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

interface MockSession {
  id: string;
  ptys: Map<string, { id: string }>;
  agent: { id: string; state: 'running' | 'paused' | 'stopped' } | null;
  files: Map<string, Uint8Array>;
}

export function createMockSandboxServer(baseUrl = 'http://localhost:8080') {
  const sessions = new Map<string, MockSession>();
  let sessionCounter = 0;
  let ptyCounter = 0;

  const handlers = [
    // Health check
    http.get(`${baseUrl}/health`, () => {
      return HttpResponse.json({ status: 'ok' });
    }),

    // Create session
    http.post(`${baseUrl}/sessions`, () => {
      const id = `session-${++sessionCounter}`;
      sessions.set(id, {
        id,
        ptys: new Map(),
        agent: null,
        files: new Map(),
      });
      return HttpResponse.json({ id, machine_id: 'machine-1' }, { status: 201 });
    }),

    // Delete session
    http.delete(`${baseUrl}/sessions/:sessionId`, ({ params }) => {
      const { sessionId } = params;
      if (!sessions.has(sessionId as string)) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      sessions.delete(sessionId as string);
      return new HttpResponse(null, { status: 204 });
    }),

    // List PTYs
    http.get(`${baseUrl}/sessions/:sessionId/ptys`, ({ params }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      return HttpResponse.json({ ptys: Array.from(session.ptys.values()) });
    }),

    // Create PTY
    http.post(`${baseUrl}/sessions/:sessionId/ptys`, ({ params }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      const id = `pty-${++ptyCounter}`;
      session.ptys.set(id, { id });
      return HttpResponse.json({ id }, { status: 201 });
    }),

    // Delete PTY
    http.delete(`${baseUrl}/sessions/:sessionId/ptys/:ptyId`, ({ params }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      session.ptys.delete(params.ptyId as string);
      return new HttpResponse(null, { status: 204 });
    }),

    // Start agent
    http.post(`${baseUrl}/sessions/:sessionId/agent`, ({ params }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      if (session.agent) {
        return HttpResponse.json({ error: 'agent already exists' }, { status: 409 });
      }
      session.agent = { id: `${params.sessionId}-agent`, state: 'running' };
      return HttpResponse.json(session.agent, { status: 201 });
    }),

    // Get agent
    http.get(`${baseUrl}/sessions/:sessionId/agent`, ({ params }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session || !session.agent) {
        return HttpResponse.json({ error: 'agent not found' }, { status: 404 });
      }
      return HttpResponse.json(session.agent);
    }),

    // Pause agent
    http.post(`${baseUrl}/sessions/:sessionId/agent/pause`, ({ params }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session || !session.agent) {
        return HttpResponse.json({ error: 'agent not found' }, { status: 404 });
      }
      session.agent.state = 'paused';
      return HttpResponse.json({ state: 'paused' });
    }),

    // Resume agent
    http.post(`${baseUrl}/sessions/:sessionId/agent/resume`, ({ params }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session || !session.agent) {
        return HttpResponse.json({ error: 'agent not found' }, { status: 404 });
      }
      session.agent.state = 'running';
      return HttpResponse.json({ state: 'running' });
    }),

    // Stop agent
    http.post(`${baseUrl}/sessions/:sessionId/agent/stop`, ({ params }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session || !session.agent) {
        return HttpResponse.json({ error: 'agent not found' }, { status: 404 });
      }
      session.agent = null;
      return new HttpResponse(null, { status: 204 });
    }),

    // List files
    http.get(`${baseUrl}/sessions/:sessionId/files`, ({ params, request }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      const url = new URL(request.url);
      const path = url.searchParams.get('path') || '/';

      // Return mock file list
      const files = Array.from(session.files.keys())
        .filter(f => f.startsWith(path === '/' ? '' : path))
        .map(f => ({
          name: f.split('/').pop(),
          path: f,
          size: session.files.get(f)?.length || 0,
          is_dir: false,
          mod_time: new Date().toISOString(),
          mode: '-rw-r--r--',
        }));

      return HttpResponse.json({ files });
    }),

    // Read file
    http.get(`${baseUrl}/sessions/:sessionId/file`, ({ params, request }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      const url = new URL(request.url);
      const path = url.searchParams.get('path');
      if (!path) {
        return HttpResponse.json({ error: 'path required' }, { status: 400 });
      }
      const content = session.files.get(path);
      if (!content) {
        return HttpResponse.json({ error: 'file not found' }, { status: 404 });
      }
      return new HttpResponse(content, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }),

    // Write file
    http.put(`${baseUrl}/sessions/:sessionId/file`, async ({ params, request }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      const url = new URL(request.url);
      const path = url.searchParams.get('path');
      if (!path) {
        return HttpResponse.json({ error: 'path required' }, { status: 400 });
      }
      const content = await request.arrayBuffer();
      session.files.set(path, new Uint8Array(content));
      return new HttpResponse(null, { status: 201 });
    }),

    // Delete file
    http.delete(`${baseUrl}/sessions/:sessionId/file`, ({ params, request }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      const url = new URL(request.url);
      const path = url.searchParams.get('path');
      if (!path) {
        return HttpResponse.json({ error: 'path required' }, { status: 400 });
      }
      session.files.delete(path);
      return new HttpResponse(null, { status: 204 });
    }),

    // Stat file
    http.get(`${baseUrl}/sessions/:sessionId/file/stat`, ({ params, request }) => {
      const session = sessions.get(params.sessionId as string);
      if (!session) {
        return HttpResponse.json({ error: 'session not found' }, { status: 404 });
      }
      const url = new URL(request.url);
      const path = url.searchParams.get('path');
      if (!path) {
        return HttpResponse.json({ error: 'path required' }, { status: 400 });
      }
      const content = session.files.get(path);
      if (!content) {
        return HttpResponse.json({ error: 'file not found' }, { status: 404 });
      }
      return HttpResponse.json({
        name: path.split('/').pop(),
        path,
        size: content.length,
        is_dir: false,
        mod_time: new Date().toISOString(),
        mode: '-rw-r--r--',
      });
    }),
  ];

  const server = setupServer(...handlers);

  return {
    server,
    sessions,
    reset: () => {
      sessions.clear();
      sessionCounter = 0;
      ptyCounter = 0;
    },
  };
}
