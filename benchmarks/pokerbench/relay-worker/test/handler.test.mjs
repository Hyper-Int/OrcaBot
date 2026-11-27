// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: pokerbench-relay-worker-v6-restart
// node --test benchmarks/pokerbench/relay-worker/test/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handle, MAX_BODY, publicPage, REPLAY_S, STALL_S, Table } from "../src/handler.js";

const PAGE = readFileSync(new URL("../../pokerbench/static/spectator.html", import.meta.url), "utf8");
const UP = "relay.example.workers.dev", PUB = "live.example.com", KEY = "k-123";
const SNAP = JSON.stringify({ status: "running", seats: ["a", "b"], hand: 3, relay: { delay_s: 120 } });

// Durable Object storage, in memory: get/put (one key or an object of up to 128), delete (one
// or a list of up to 128), list({prefix}) in key order.
function memStorage(m) {
  return {
    get: async (k) => m.get(k),
    put: async (k, v) => {
      if (typeof k === "object") { assert.ok(Object.keys(k).length <= 128); for (const [a, b] of Object.entries(k)) m.set(a, b); }
      else m.set(k, v);
    },
    delete: async (k) => { const ks = Array.isArray(k) ? k : [k]; assert.ok(ks.length <= 128); ks.forEach((x) => m.delete(x)); },
    list: async ({ prefix = "" } = {}) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
    size: () => m.size,
  };
}

function makeEnv(extra = {}) {
  const tables = new Map();
  const store = () => memStorage(new Map());
  return {
    RELAY_KEY: KEY, UPLOAD_HOST: UP, PUBLIC_HOST: PUB, ...extra,
    TABLES: {
      idFromName: (n) => n,
      get: (id) => {
        if (!tables.has(id)) tables.set(id, new Table({ storage: store() }));
        const t = tables.get(id);
        return { fetch: (u, init) => t.fetch(new Request(u, init)) };
      },
    },
  };
}
const call = (env, host, path, init = {}) => handle(new Request(`https://${host}${path}`, init), env, PAGE);
const put = (env, body = SNAP, auth = `Bearer ${KEY}`, host = UP, path = "/tables/pb") =>
  call(env, host, path, { method: "PUT", body, headers: { Authorization: auth, "Content-Type": "application/json" } });

test("an upload is served read-only on the public host only", async () => {
  const env = makeEnv();
  assert.equal((await call(env, PUB, "/tables/pb/state")).status, 404);  // nothing yet
  assert.equal((await put(env)).status, 204);
  const got = await call(env, PUB, "/tables/pb/state");
  assert.equal(got.status, 200);
  assert.equal(await got.text(), SNAP);
  assert.match(got.headers.get("X-Robots-Tag"), /noindex/);
  assert.equal(got.headers.get("Cache-Control"), "public, max-age=2");
  // The upload host serves no snapshot (seats may reach it) and the public host takes no upload.
  assert.equal((await call(env, UP, "/tables/pb/state")).status, 404);
  assert.equal((await call(env, UP, "/tables/pb")).status, 404);
  assert.equal((await put(env, SNAP, `Bearer ${KEY}`, PUB)).status, 405);
  assert.equal((await call(env, "other.example.com", "/tables/pb/state")).status, 404);
});

test("uploads need the key, a table name and a snapshot", async () => {
  const env = makeEnv();
  assert.equal((await put(env, SNAP, "Bearer wrong")).status, 401);
  assert.equal((await put(env, SNAP, "")).status, 401);
  assert.equal((await put(env, SNAP, `Bearer ${KEY}x`)).status, 401);
  assert.equal((await put(env, "not json")).status, 400);
  assert.equal((await put(env, JSON.stringify({ hello: 1 }))).status, 400);
  assert.equal((await put(env, "x".repeat(MAX_BODY + 1))).status, 413);
  assert.equal((await put(env, SNAP, `Bearer ${KEY}`, UP, "/tables/Bad_Name")).status, 404);
  assert.equal((await put(env, SNAP, `Bearer ${KEY}`, UP, "/tables/pb/state")).status, 404);
  assert.equal((await call(env, PUB, "/tables/pb/state")).status, 404);  // none of them stored
});

test("fail-closed when not configured", async () => {
  for (const extra of [{ RELAY_KEY: "" }, { UPLOAD_HOST: "" }, { PUBLIC_HOST: "" }, { PUBLIC_HOST: UP }]) {
    const env = makeEnv(extra);
    assert.equal((await put(env)).status, 503);
    assert.equal((await call(env, PUB, "/tables/pb")).status, 503);
  }
});

test("the page is the table in public mode, not indexed", async () => {
  const env = makeEnv();
  const res = await call(env, PUB, "/tables/pb");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /window\.POKERBENCH_PUBLIC = \{"state":"\/tables\/pb\/state"\};/);
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.match(res.headers.get("Content-Security-Policy"), /connect-src 'self'.*frame-ancestors \*/);
  assert.equal(await (await call(env, PUB, "/robots.txt")).text(), "User-agent: *\nDisallow: /\n");
  assert.match(publicPage(PAGE, "x"), /const PUBLIC = window\.POKERBENCH_PUBLIC/);  // the page reads it
  const res2 = await call(makeEnv({ FRAME_ANCESTORS: "https://orcabot.com" }), PUB, "/tables/pb");
  assert.match(res2.headers.get("Content-Security-Policy"), /frame-ancestors https:\/\/orcabot\.com$/);
});

test("the table keeps its snapshot across a restart", async () => {
  const storage = memStorage(new Map());
  await new Table({ storage }).fetch(new Request("https://t/latest", { method: "PUT", body: SNAP }));
  const again = await new Table({ storage }).fetch(new Request("https://t/latest"));
  assert.equal(await again.text(), SNAP);
});

// REVISION: pokerbench-relay-worker-v4-ratings
const BOARD = JSON.stringify({ games: 30, hands: 3000, series: [{ games: 10, of: 10 }], models: [{ model: "m", bb_per_100: 1 }] });

test("the scoreboard: uploaded with the key, served read-only on the public host", async () => {
  const env = makeEnv();
  assert.equal((await call(env, PUB, "/tables/pb/ratings")).status, 404);  // none yet
  assert.equal((await put(env, BOARD, "Bearer nope", UP, "/tables/pb/ratings")).status, 401);
  assert.equal((await put(env, SNAP, `Bearer ${KEY}`, UP, "/tables/pb/ratings")).status, 400);  // not a scoreboard
  assert.equal((await put(env, BOARD, `Bearer ${KEY}`, PUB, "/tables/pb/ratings")).status, 405);  // public takes nothing
  assert.equal((await put(env, BOARD, `Bearer ${KEY}`, UP, "/tables/pb/ratings")).status, 204);
  const got = await call(env, PUB, "/tables/pb/ratings");
  assert.equal(got.status, 200);
  assert.equal(await got.text(), BOARD);
  assert.equal(got.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(got.headers.get("Cache-Control"), /max-age=30/);
  assert.equal((await call(env, UP, "/tables/pb/ratings")).status, 404);  // the upload host serves nothing
  // The table's snapshot is separate: the scoreboard didn't become it, and vice versa.
  assert.equal((await call(env, PUB, "/tables/pb/state")).status, 404);
  assert.equal((await put(env)).status, 204);
  assert.equal(await (await call(env, PUB, "/tables/pb/ratings")).text(), BOARD);
  assert.equal(await (await call(env, PUB, "/tables/pb/state")).text(), SNAP);
});

test("the table keeps its scoreboard across a restart", async () => {
  const storage = memStorage(new Map());
  await new Table({ storage }).fetch(new Request("https://t/ratings", { method: "PUT", body: BOARD }));
  const again = new Table({ storage });
  assert.equal(await (await again.fetch(new Request("https://t/ratings"))).text(), BOARD);
  assert.equal((await again.fetch(new Request("https://t/latest"))).status, 404);
});

// ---- Replay while the game is stuck. REVISION: pokerbench-relay-worker-v5-replay ----
const MIN = 60_000;
const frame = (o = {}) => ({ status: "running", seats: ["a", "b"], hands_total: 100, hands_played: o.hand ? o.hand - 1 : 0,
  series: { id: o.sid ?? "s1", game: o.game ?? 0, games: 10 }, progress: { hands: o.done ?? 0, games: 0 },
  live: { street: "preflop", actions: Array(o.acts ?? 0).fill({}) }, relay: { as_of: "x", delay_s: 120 }, ...o.extra,
  hand: o.hand ?? 1 });

// A table on a fake clock: play() uploads a frame every 2s, one action every 10s, a new hand every minute.
function clockTable(storage = memStorage(new Map())) {
  const t = new Table({ storage });
  let now = Date.parse("2026-11-27T10:00:00Z");
  t.now = () => now;
  const up = (snap) => t.fetch(new Request("https://t/latest", { method: "PUT", body: JSON.stringify(snap) }));
  const get = async () => JSON.parse(await (await t.fetch(new Request("https://t/latest"))).text());
  return {
    t, up, get, storage, wait: (ms) => { now += ms; }, at: () => now,
    async play(minutes, o = {}) {
      const first = o.from ?? 1;
      for (let s = 0; s < minutes * 60; s += 2) {
        await up(frame({ ...o, hand: first + Math.floor(s / 60), acts: Math.floor((s % 60) / 10) }));
        now += 2000;
      }
      return first + minutes;  // the next hand
    },
  };
}

test("a stuck game replays its last 20 minutes, labelled, until it moves again", async () => {
  const c = clockTable();
  const next = await c.play(30, { done: 5 });  // hands 1-30
  // Stuck: the same frame keeps coming (the relay still runs), or nothing comes at all.
  const stuck = frame({ hand: next - 1, acts: 6, done: 5, extra: { paused: true } });  // one more action, then nothing
  for (let i = 0; i < 10; i++) { await c.up(stuck); c.wait(2000); }
  c.wait(STALL_S * 1000 - 25_000);
  assert.equal((await c.get()).relay.replay, undefined, "not yet: a slow turn isn't a stall");
  c.wait(10_000);
  const r = await c.get();
  assert.equal(r.relay.replay.source, "this game");
  assert.equal(r.relay.replay.live.paused, true);
  assert.equal(r.relay.delay_s, 120);
  assert.equal(r.hand, next - REPLAY_S / 60, "it starts 20 minutes back");
  assert.equal(r.hands_played, next - 2, "the benchmark page's progress stays the live game's");
  // It plays forward in real time, then loops.
  c.wait(5 * MIN);
  assert.equal((await c.get()).hand, next - REPLAY_S / 60 + 5);
  c.wait(REPLAY_S * 1000);
  const looped = (await c.get()).hand;
  assert.ok(looped >= next - REPLAY_S / 60 && looped < next - REPLAY_S / 60 + 6, `looped to ${looped}`);
  // The game moves: live again at once.
  await c.up(frame({ hand: next, acts: 0, done: 5 }));
  const live = await c.get();
  assert.equal(live.relay.replay, undefined);
  assert.equal(live.hand, next);
});

test("the replay never shows another game of the series; a lobby stall replays the last series", async () => {
  const c = clockTable();
  await c.play(25, { sid: "s1", game: 9 });  // the last game of series s1
  await c.play(25, { sid: "s2", game: 0 });  // a whole game of series s2...
  // ...then s2's game 1 is stuck in its lobby (a seat logged out): s2's game 0 has the same
  // deals, so only s1 may be replayed.
  const lobby = { ...frame({ sid: "s2", game: 1 }), status: "waiting_for_players", joined: ["a"] };
  await c.up(lobby);
  c.wait(STALL_S * 1000 + 1000);
  const r = await c.get();
  assert.equal(r.relay.replay.source, "the last series");
  assert.equal(r.series.id, "s2", "the progress line is the live one");
  assert.equal(JSON.parse(c.t.reel[0].text).series.id, "s1");
  assert.ok(c.t.reel.every((h) => h.sid === "s1"));

  // The first series has no series before it: a stall in its lobby shows the lobby, as now.
  const d = clockTable();
  await d.play(10, { sid: "s1", game: 0 });
  await d.up({ ...frame({ sid: "s1", game: 1 }), status: "waiting_for_players", joined: [] });
  d.wait(STALL_S * 1000 + 1000);
  const plain = await d.get();
  assert.equal(plain.relay.replay, undefined);
  assert.equal(plain.status, "waiting_for_players");
});

test("seats coming back in the lobby count as movement; a finished table isn't replayed", async () => {
  const c = clockTable();
  await c.play(25, { sid: "s1", game: 9 });
  await c.play(5, { sid: "s2", game: 0 });
  const lobby = (n) => ({ ...frame({ sid: "s2", game: 1 }), status: "waiting_for_players", joined: ["a", "b", "c"].slice(0, n) });
  for (let n = 0; n <= 3; n++) { await c.up(lobby(n)); c.wait((STALL_S - 30) * 1000); }
  assert.equal((await c.get()).relay.replay, undefined);  // the stall clock restarts with each seat

  const f = clockTable();
  await f.play(25);
  await f.up({ ...frame({ hand: 100 }), status: "finished" });
  f.wait(60 * MIN);
  assert.equal((await f.get()).status, "finished");
  assert.equal((await f.get()).relay.replay, undefined);
});

test("the replay survives a restart, and what is kept stays about 20 minutes", async () => {
  const c = clockTable();
  await c.play(60);
  const kept = c.t.hist.length;
  assert.ok(kept <= (REPLAY_S + 120) / 5 + 200, `kept ${kept} frames`);
  assert.ok(c.t.hist[0].t >= c.at() - (REPLAY_S + 120) * 1000);
  c.wait(STALL_S * 1000 + 1000);
  const again = new Table({ storage: c.storage });
  again.now = c.t.now;
  const r = JSON.parse(await (await again.fetch(new Request("https://t/latest"))).text());
  assert.equal(r.relay.replay.source, "this game");
});

// REVISION: pokerbench-relay-worker-v6-restart
test("a game that starts again is never replayed from before: its hands come round again", async () => {
  const c = clockTable();
  await c.play(25, { sid: "s4", game: 9 });                 // the end of the last series
  await c.play(10, { sid: "s5", game: 0 });                 // series 5, game 1: hands 1-10...
  // ...then rewound to its start: the same seed deals hands 1-10 again. Its lobby comes back.
  const lobby = { ...frame({ sid: "s5", game: 0 }), status: "waiting_for_players", joined: [] };
  await c.up(lobby);
  assert.equal(c.t.hist.filter((h) => h.g === "s5#0").length, 0, "what was recorded of the game is gone");
  assert.equal((await c.storage.list({ prefix: "h:" })).size, c.t.hist.length, "from storage too");
  c.wait(STALL_S * 1000 + 1000);
  const r = await c.get();
  assert.equal(r.relay.replay.source, "the last series", "a stuck lobby replays series 4, not game 1's first try");
  assert.equal(JSON.parse(c.t.reel[0].text).series.id, "s4");

  // Played again, then rolled back (fewer hands played): the frames past it go too.
  await c.play(12, { sid: "s5", game: 0 });
  await c.up(frame({ sid: "s5", game: 0, hand: 9 }));       // hands_played 8 < 11 recorded
  assert.ok(c.t.hist.every((h) => h.g !== "s5#0" || JSON.parse(h.text).hand === 9));
  // And an engine restart mid-game (resuming: the hand in progress is dealt again).
  await c.play(5, { sid: "s5", game: 0, from: 9 });
  await c.up(frame({ sid: "s5", game: 0, hand: 13, extra: { resuming: { next_hand: 13 } } }));
  assert.equal(c.t.hist.filter((h) => h.g === "s5#0").length, 1, "only the resuming frame itself");
});
