// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: pokerbench-relay-worker-v1
// node --test benchmarks/pokerbench/relay-worker/test/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handle, MAX_BODY, publicPage, Table } from "../src/handler.js";

const PAGE = readFileSync(new URL("../../pokerbench/static/spectator.html", import.meta.url), "utf8");
const UP = "relay.example.workers.dev", PUB = "live.example.com", KEY = "k-123";
const SNAP = JSON.stringify({ status: "running", seats: ["a", "b"], hand: 3, relay: { delay_s: 120 } });

function makeEnv(extra = {}) {
  const tables = new Map();
  const store = () => { const m = new Map(); return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) }; };
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
  const m = new Map();
  const storage = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
  await new Table({ storage }).fetch(new Request("https://t/latest", { method: "PUT", body: SNAP }));
  const again = await new Table({ storage }).fetch(new Request("https://t/latest"));
  assert.equal(await again.text(), SNAP);
});
