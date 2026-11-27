// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: pokerbench-relay-worker-v6-restart
//
// The public side of a PokerBench table (pokerbench/relay.py uploads a delayed copy).
// Two hosts, so the upload host serves nothing and the public one takes nothing:
//   UPLOAD_HOST  PUT /tables/<name>          the snapshot, with Authorization: Bearer RELAY_KEY
//                                            (added by the Orcabot secrets broker, never seen
//                                            by the engine terminal)
//                PUT /tables/<name>/ratings  the scoreboard (pokerbench/scoreboard.py), same key.
//                                            Nothing else.
//   PUBLIC_HOST  GET /tables/<name>          the read-only table page
//                GET /tables/<name>/state    the latest snapshot (cached ~2s at the edge), or a
//                                            labelled replay while the game is stuck (Table)
//                GET /tables/<name>/ratings  the latest scoreboard, for the benchmark page's
//                                            chart (cached ~30s)
//                GET /robots.txt           Disallow: / (and noindex on every response)
// Fail-closed: no RELAY_KEY, no hosts or the same host twice -> nothing is served.

export const WORKER_REVISION = "pokerbench-relay-worker-v6-restart";
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

// ---- Replay while the game is stuck. REVISION: pokerbench-relay-worker-v5-replay ----
// If the game stops moving (no new action, street or hand for STALL_S: a seat logged out,
// the engine paused or down, the VM or the relay gone), the public page replays the game's
// last REPLAY_S of play on a loop, labelled as a replay (relay.replay; the page says so), until
// the game moves again. It is decided here rather than on the VM so it carries on when nothing
// is uploaded at all.
//
// A series deals the same cards in every game, and the seats can reach this page, so the replay
// never shows another game of the series being played: only this game's earlier hands (each
// seat has already seen them), or, when this game has none yet (a stall in the lobby before its
// first hand), the end of the last game of the series before this one (a new seed:
// SERIES_COUNT needs SEED=random). A finished table isn't replayed: that isn't a stall.
export const STALL_S = 360;      // a turn can take TURN_TIMEOUT (300s) before the engine folds it
export const REPLAY_S = 1200;    // how far back the replay goes
const KEEP_EVERY_S = 5;          // the relay sends a snapshot every 2s; one every 5s is plenty
const MIN_REEL_S = 120;          // shorter than this isn't worth replaying
const HOLD_END_S = 10;           // the reel's last frame stays up this long before it starts again

export function progressKey(snap) {
  const live = snap.live || {}, sr = snap.series || {};
  return JSON.stringify([snap.status, sr.id ?? null, sr.game ?? null, snap.hand ?? null, snap.hands_played ?? null,
    live.street ?? null, Array.isArray(live.actions) ? live.actions.length : null,
    Array.isArray(snap.joined) ? snap.joined.length : null]);  // seats coming back count
}
const gameKey = (snap) => (snap.series && snap.series.id ? `${snap.series.id}#${snap.series.game}` : null);
const span = (reel) => (reel.length ? reel[reel.length - 1].t - reel[0].t : 0);
const iso = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const played = (h) => h.hp ?? JSON.parse(h.text).hands_played ?? 0;  // v5 rows have no hp
// Durable Object storage takes at most 128 keys a call.
async function deleteKeys(st, keys) { for (let i = 0; i < keys.length; i += 128) await st.delete(keys.slice(i, i + 128)); }
async function putRows(st, prefix, rows) {
  for (let i = 0; i < rows.length; i += 128) {
    await st.put(Object.fromEntries(rows.slice(i, i + 128).map((h) => [`${prefix}${h.t}`, JSON.stringify(h)])));
  }
}

// One per table: the latest snapshot ("latest") and scoreboard ("ratings"), kept in memory and
// saved for a restart; and for the replay, the last REPLAY_S of play ("h:<ms>"), when the game
// last moved ("moved"), and the end of the last series ("r:<ms>").
export class Table {
  constructor(state) {
    this.state = state; this.kept = {};
    this.now = () => Date.now();  // tests set the clock
    this.loaded = null;
  }

  load() {
    this.loaded ??= (async () => {
      const st = this.state.storage;
      const rows = async (prefix) => [...(await st.list({ prefix })).values()].map((v) => JSON.parse(v)).sort((a, b) => a.t - b.t);
      this.hist = await rows("h:");
      this.reel = await rows("r:");
      this.moved = (await st.get("moved")) ?? null;  // {key, at}
    })();
    return this.loaded;
  }

  async fetch(request) {
    const key = new URL(request.url).pathname === "/ratings" ? "ratings" : "latest";
    const st = this.state.storage;
    if (request.method === "PUT") {
      this.kept[key] = await request.text();
      await st.put(key, this.kept[key]);
      if (key === "latest") await this.record(this.kept[key]);
      return new Response(null, { status: 204 });
    }
    this.kept[key] ??= (await st.get(key)) ?? null;
    if (this.kept[key] === null) return new Response("none", { status: 404 });
    return new Response(key === "latest" ? await this.serve(this.kept[key]) : this.kept[key], { status: 200 });
  }

  async record(text) {
    await this.load();
    let snap;
    try { snap = JSON.parse(text); } catch { return; }
    const st = this.state.storage, now = this.now(), pk = progressKey(snap);
    if (!this.moved || this.moved.key !== pk) {
      this.moved = { key: pk, at: now };
      await st.put("moved", this.moved);
    }
    const g = gameKey(snap), sid = snap.series && snap.series.id;
    const last = this.hist[this.hist.length - 1];
    // A new series: the last one's final minutes become the reel for a stall before this
    // series has any hands of its own.
    if (last && sid && last.sid && last.sid !== sid && (!this.reel.length || this.reel[0].sid !== last.sid)) {
      const reel = this.hist.filter((h) => h.g === last.g && h.t >= last.t - REPLAY_S * 1000);
      await deleteKeys(st, this.reel.map((h) => `r:${h.t}`));
      await putRows(st, "r:", reel);
      this.reel = reel;
    }
    // A game that starts again deals hands it has dealt before: rewound to its start (its
    // lobby again), rolled back (fewer hands played) or carried on after the engine restarted
    // (resuming: the hand in progress is dealt again). What was recorded of it could show
    // those hands' cards before they're dealt, so it goes. REVISION: pokerbench-relay-worker-v6-restart
    if (g) {
      const hp = typeof snap.hands_played === "number" ? snap.hands_played : null;
      const again = snap.status === "waiting_for_players" || Boolean(snap.resuming) ||
        (hp !== null && this.hist.some((h) => h.g === g && played(h) > hp));
      const gone = again ? this.hist.filter((h) => h.g === g) : [];
      if (gone.length) {
        this.hist = this.hist.filter((h) => h.g !== g);
        await deleteKeys(st, gone.map((h) => `h:${h.t}`));
      }
    }
    // Only play goes on the reel (not the lobby), and nothing once the game has stopped moving.
    if (!g || snap.status !== "running") return;
    const prev = this.hist[this.hist.length - 1];
    const moved = !prev || prev.pk !== pk;
    if (!moved && (now - prev.t < KEEP_EVERY_S * 1000 || now - this.moved.at >= STALL_S * 1000)) return;
    const h = { t: now, g, sid, pk, hp: snap.hands_played ?? null, text };
    this.hist.push(h);
    await st.put(`h:${now}`, JSON.stringify(h));
    const cutoff = this.moved.at - (REPLAY_S + 60) * 1000;
    const old = this.hist.filter((x) => x.t < cutoff);
    if (old.length) {
      this.hist = this.hist.filter((x) => x.t >= cutoff);
      await deleteKeys(st, old.map((x) => `h:${x.t}`));
    }
  }

  async serve(text) {
    await this.load();
    const now = this.now();
    if (!this.moved || now - this.moved.at < STALL_S * 1000) return text;
    let snap;
    try { snap = JSON.parse(text); } catch { return text; }
    if (snap.status !== "running" && snap.status !== "waiting_for_players") return text;
    const g = gameKey(snap), sid = snap.series && snap.series.id;
    let reel = g ? this.hist.filter((h) => h.g === g && h.t <= this.moved.at && h.t >= this.moved.at - REPLAY_S * 1000) : [];
    let source = "this game";
    if (span(reel) < MIN_REEL_S * 1000) {
      reel = this.reel.length && this.reel[0].sid !== sid ? this.reel : [];
      source = "the last series";
    }
    if (span(reel) < MIN_REEL_S * 1000) return text;
    const start = this.moved.at + STALL_S * 1000, t0 = reel[0].t;
    const off = (now - start) % (span(reel) + HOLD_END_S * 1000);
    let frame = reel[0];
    for (const h of reel) { if (h.t - t0 <= off) frame = h; else break; }
    const out = JSON.parse(frame.text);
    // What the benchmark page reads for its progress line stays the live game's.
    for (const k of ["progress", "series", "hands_played"]) if (k in snap) out[k] = snap[k];
    out.relay = { ...(snap.relay || {}), replay: {
      source, of: iso(frame.t), stalled_since: iso(this.moved.at),
      live: { status: snap.status, hand: snap.hand ?? null, hands_total: snap.hands_total ?? null, paused: !!snap.paused },
    } };
    return JSON.stringify(out);
  }
}
