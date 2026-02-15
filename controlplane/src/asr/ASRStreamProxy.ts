// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: asr-stream-proxy-v2-auth-fix

const proxyRevision = "asr-stream-proxy-v2-auth-fix";
console.log(`[ASRStreamProxy] REVISION: ${proxyRevision} loaded at ${new Date().toISOString()}`);

/**
 * Durable Object that relays WebSocket connections between browser and Deepgram.
 * The browser sends raw PCM16 audio frames; Deepgram sends back JSON transcripts.
 * The API key never reaches the browser — it's injected by the DO when opening
 * the upstream connection to Deepgram.
 */
export class ASRStreamProxy implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const apiKey = request.headers.get('X-ASR-Api-Key');
    if (!apiKey) {
      return new Response('Missing API key', { status: 401 });
    }

    // Create the client-facing WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the server side (our end)
    server.accept();

    // Open upstream WebSocket to Deepgram.
    // Use Authorization header (server-to-server auth). Sec-WebSocket-Protocol
    // is the browser-side auth mechanism and may not be forwarded correctly by
    // the Workers fetch() runtime.
    const deepgramUrl = 'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true';

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(deepgramUrl, {
        headers: {
          Upgrade: 'websocket',
          Authorization: `Token ${apiKey}`,
        },
      });
    } catch (err) {
      console.error('[ASRStreamProxy] Failed to connect to Deepgram:', err);
      server.close(1011, 'Failed to connect to Deepgram');
      return new Response(null, { status: 101, webSocket: client });
    }

    const upstream = upstreamResp.webSocket;
    if (!upstream) {
      console.error(`[ASRStreamProxy] Deepgram did not return WebSocket. Status: ${upstreamResp.status}`);
      try {
        const body = await upstreamResp.text();
        console.error(`[ASRStreamProxy] Deepgram response body: ${body.slice(0, 500)}`);
      } catch { /* ignore */ }
      server.close(1011, 'Deepgram did not return a WebSocket');
      return new Response(null, { status: 101, webSocket: client });
    }

    upstream.accept();
    console.log('[ASRStreamProxy] Deepgram upstream connected');

    // Pipe: browser → Deepgram (audio frames)
    server.addEventListener('message', (event) => {
      try {
        if (upstream.readyState === WebSocket.READY_STATE_OPEN) {
          upstream.send(event.data);
        }
      } catch {
        // Upstream closed
      }
    });

    // Pipe: Deepgram → browser (transcript JSON)
    upstream.addEventListener('message', (event) => {
      try {
        if (server.readyState === WebSocket.READY_STATE_OPEN) {
          server.send(event.data);
        }
      } catch {
        // Client closed
      }
    });

    // Handle close propagation
    server.addEventListener('close', (event) => {
      console.log(`[ASRStreamProxy] Client closed: code=${event.code} reason=${event.reason}`);
      try { upstream.close(); } catch { /* already closed */ }
    });

    upstream.addEventListener('close', (event) => {
      console.log(`[ASRStreamProxy] Deepgram upstream closed: code=${event.code} reason=${event.reason}`);
      try { server.close(); } catch { /* already closed */ }
    });

    // Handle errors
    server.addEventListener('error', (event) => {
      console.error('[ASRStreamProxy] Client WebSocket error:', event);
      try { upstream.close(); } catch { /* noop */ }
    });

    upstream.addEventListener('error', (event) => {
      console.error('[ASRStreamProxy] Deepgram upstream error:', event);
      try { server.close(1011, 'Upstream error'); } catch { /* noop */ }
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
