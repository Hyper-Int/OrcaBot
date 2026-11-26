// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: pokerbench-relay-worker-v4-ratings
//
// The public side of a PokerBench table (pokerbench/relay.py uploads a delayed copy).
// Two hosts, so the upload host serves nothing and the public one takes nothing:
//   UPLOAD_HOST  PUT /tables/<name>          the snapshot, with Authorization: Bearer RELAY_KEY
//                                            (added by the Orcabot secrets broker, never seen
//                                            by the engine terminal)
//                PUT /tables/<name>/ratings  the scoreboard (pokerbench/scoreboard.py), same key.
//                                            Nothing else.
//   PUBLIC_HOST  GET /tables/<name>          the read-only table page
//                GET /tables/<name>/state    the latest snapshot (cached ~2s at the edge)
//                GET /tables/<name>/ratings  the latest scoreboard, for the benchmark page's
//                                            chart (cached ~30s)
//                GET /robots.txt           Disallow: / (and noindex on every response)
// Fail-closed: no RELAY_KEY, no hosts or the same host twice -> nothing is served.

export const WORKER_REVISION = "pokerbench-relay-worker-v4-ratings";
export const MAX_BODY = 200_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow, noarchive" };

const reply = (status, body = "", headers = {}) =>
  new Response(status === 204 ? null : body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...NOINDEX, ...headers } });

function sameSecret(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// The table page (pokerbench/static/spectator.html) in public mode, for one table.
export function publicPage(html, name) {
  const config = JSON.stringify({ state: `/tables/${name}/state` });
  return html.replace("<head>", `<head>\n<meta name="robots" content="noindex, nofollow, noarchive">\n` +
    `<script>window.POKERBENCH_PUBLIC = ${config};</script>`);
}

export async function handle(request, env, page, ctx) {
  const url = new URL(request.url);
  const { UPLOAD_HOST: up, PUBLIC_HOST: pub } = env;
  if (!env.RELAY_KEY || !up || !pub || up === pub) return reply(503, "relay not configured");
  if (url.pathname === "/robots.txt") return reply(200, "User-agent: *\nDisallow: /\n");
  const m = url.pathname.match(/^\/tables\/([^/]+)(\/state|\/ratings)?$/);
  if (!m || !NAME.test(m[1])) return reply(404, "not found");
  const name = m[1], wantsState = m[2] === "/state", wantsRatings = m[2] === "/ratings";
  const table = () => env.TABLES.get(env.TABLES.idFromName(name));

  if (url.hostname === up) {
    if (request.method !== "PUT" || wantsState) return reply(404, "not found");
    if (!sameSecret(request.headers.get("Authorization") || "", `Bearer ${env.RELAY_KEY}`)) return reply(401, "unauthorized");
    if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) return reply(413, "too large");
    const text = await request.text();
    if (text.length > MAX_BODY) return reply(413, "too large");
    let snap;
    try { snap = JSON.parse(text); } catch { return reply(400, "not JSON"); }
    if (wantsRatings) {
      // REVISION: pokerbench-relay-worker-v4-ratings
      if (!snap || !Array.isArray(snap.models)) return reply(400, "not a scoreboard");
      await table().fetch("https://table/ratings", { method: "PUT", body: text });
      return reply(204);
    }
    if (!snap || typeof snap.status !== "string" || !Array.isArray(snap.seats)) return reply(400, "not a table snapshot");
    await table().fetch("https://table/latest", { method: "PUT", body: text });
    return reply(204);
  }

  if (url.hostname !== pub) return reply(404, "not found");
  if (request.method !== "GET" && request.method !== "HEAD") return reply(405, "read-only", { Allow: "GET, HEAD" });
  if (!wantsState && !wantsRatings) {
    return reply(200, publicPage(page, name), {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        `connect-src 'self'; img-src 'self' data:; frame-ancestors ${env.FRAME_ANCESTORS || "*"}`,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "public, max-age=60",
    });
  }
  const cache = globalThis.caches?.default;
  const key = new Request(url.toString(), { method: "GET" });
  const hit = cache && await cache.match(key);
  if (hit) return hit;
  const res = await table().fetch(wantsRatings ? "https://table/ratings" : "https://table/latest");
  if (res.status !== 200) {
    return reply(404, wantsRatings ? "no scoreboard for this table yet" : "no game on this table yet",
      { "Cache-Control": "public, max-age=5", "Access-Control-Allow-Origin": "*" });
  }
  const out = reply(200, await res.text(), {
    "Content-Type": "application/json", "Cache-Control": `public, max-age=${wantsRatings ? 30 : 2}`,
    "Access-Control-Allow-Origin": "*",
  });
  if (cache) ctx?.waitUntil?.(cache.put(key, out.clone()));
  return out;
}

// One per table: the latest snapshot ("latest") and scoreboard ("ratings"), kept in
// memory and saved for a restart.
export class Table {
  constructor(state) { this.state = state; this.kept = {}; }

  async fetch(request) {
    const key = new URL(request.url).pathname === "/ratings" ? "ratings" : "latest";
    if (request.method === "PUT") {
      this.kept[key] = await request.text();
      await this.state.storage.put(key, this.kept[key]);
      return new Response(null, { status: 204 });
    }
    this.kept[key] ??= (await this.state.storage.get(key)) ?? null;
    return this.kept[key] === null ? new Response("none", { status: 404 }) : new Response(this.kept[key], { status: 200 });
  }
}
