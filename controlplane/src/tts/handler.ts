// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: tts-ballots-v1

import type { Env } from '../types';

const MODULE_REVISION = 'tts-ballots-v1';
console.log(`[tts] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/** The run these ballots score. Bumped when a new TTS run replaces the samples. */
const RUN = '2026-08';

/**
 * Every configuration a ballot can draw from. Kept server-side so a client
 * cannot nominate its own comparison set (or vote for something that is not in
 * the benchmark at all).
 */
const CONFIGS = [
  'piper', 'chatterbox-turbo', 'kittentts', 'qwen3-tts', 'kokoro',
  'nt-2e-q4-metal', 'vibevoice', 'chatterbox-q4', 'styletts2', 'melotts',
  'cosyvoice3', 'fastpitch', 'speecht5',
] as const;

/**
 * Deliberately weak engine, seeded into a share of ballots as an attention
 * check. Only speecht5 qualifies now: it is the worst on both axes in the
 * real-time set (24% word error, and the only PESQ under 3 at 1.67).
 *
 * This check is weaker than it was. bark, at 55% word error, was unmistakably
 * bad to any listener, but it runs at 4.26x real time and the real-time filter
 * removes it. With a single anchor, a determined submitter could learn never to
 * rank speecht5 first, so treat rejection rate as a floor on junk, not a
 * guarantee.
 */
const ANCHORS = ['speecht5'];
const ANCHOR_RATE = 0.34;
const ITEMS_PER_BALLOT = 4;

/** Below this, a configuration shows no human score rather than a noisy one. */
export const MIN_BALLOTS_TO_SHOW = 8;

function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Coarse voter fingerprint for rate limiting and dedup. Hashed, never stored raw. */
async function voterHash(request: Request): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? '';
  const ua = request.headers.get('user-agent') ?? '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${ua}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** GET /tts/ballot - issue a blind comparison set. */
export async function issueBallot(env: Env, request: Request): Promise<Response> {
  const useAnchor = Math.random() < ANCHOR_RATE;
  const anchor = useAnchor ? ANCHORS[Math.floor(Math.random() * ANCHORS.length)] : null;
  const pool = CONFIGS.filter((c) => c !== anchor);
  const picked = shuffle([...pool]).slice(0, anchor ? ITEMS_PER_BALLOT - 1 : ITEMS_PER_BALLOT);
  const items = shuffle(anchor ? [...picked, anchor] : picked);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO tts_ballots (id, run, items_json, anchor_config, voter_hash) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, RUN, JSON.stringify(items), anchor, await voterHash(request)).run();

  // The anchor is deliberately NOT returned: the client must not be able to
  // tell which item is the attention check.
  return Response.json({ ballotId: id, items });
}

/** POST /tts/ballot - record a ranking, best first. */
export async function submitBallot(
  env: Env,
  request: Request,
  body: { ballotId?: string; ranking?: string[] }
): Promise<Response> {
  const { ballotId, ranking } = body;
  if (!ballotId || !Array.isArray(ranking)) {
    return Response.json({ error: 'E79601: ballotId and ranking are required' }, { status: 400 });
  }

  const row = await env.DB.prepare(
    `SELECT items_json, anchor_config, status FROM tts_ballots WHERE id = ?`
  ).bind(ballotId).first<{ items_json: string; anchor_config: string | null; status: string }>();

  if (!row) return Response.json({ error: 'E79602: Unknown ballot' }, { status: 404 });
  if (row.status !== 'issued') {
    return Response.json({ error: 'E79603: Ballot already submitted' }, { status: 409 });
  }

  // The ranking must be a permutation of exactly the items issued, so a client
  // cannot inject configurations it was not shown.
  const items: string[] = JSON.parse(row.items_json);
  const same =
    ranking.length === items.length &&
    [...ranking].sort().join('|') === [...items].sort().join('|');
  if (!same) {
    return Response.json({ error: 'E79604: Ranking must order exactly the issued items' }, { status: 400 });
  }

  // Attention check: the seeded weak engine placed first means the ballot is
  // noise or gaming. Stored, not deleted, so the rejection rate is auditable.
  const failed = row.anchor_config !== null && ranking[0] === row.anchor_config;
  await env.DB.prepare(
    `UPDATE tts_ballots SET ranking_json = ?, status = ?, submitted_at = datetime('now') WHERE id = ?`
  ).bind(JSON.stringify(ranking), failed ? 'rejected' : 'counted', ballotId).run();

  return Response.json({ ok: true, counted: !failed });
}

interface Score {
  config: string;
  rating: number | null;
  ballots: number;
  wins: number;
  comparisons: number;
}

/**
 * GET /tts/scores - Bradley-Terry ratings over the counted ballots.
 *
 * A 4-way ranking is six pairwise outcomes. Bradley-Terry is used rather than a
 * mean rank because engines do not all face the same opponents: mean rank
 * rewards whoever happened to draw weak company, while BT solves for the
 * strength that best explains who beat whom.
 */
export async function getScores(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT ranking_json FROM tts_ballots WHERE status = 'counted' AND run = ?`
  ).bind(RUN).all<{ ranking_json: string }>();

  const wins = new Map<string, Map<string, number>>();
  const ballots = new Map<string, number>();
  const winCount = new Map<string, number>();
  const comparisons = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

  for (const r of results ?? []) {
    let order: string[];
    try { order = JSON.parse(r.ranking_json); } catch { continue; }
    for (const c of order) bump(ballots, c);
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const better = order[i], worse = order[j];
        if (!wins.has(better)) wins.set(better, new Map());
        bump(wins.get(better)!, worse);
        bump(winCount, better);
        bump(comparisons, better);
        bump(comparisons, worse);
      }
    }
  }

  // Bradley-Terry by MM iteration. Converges quickly at this size; the loop is
  // bounded so a pathological matrix cannot hang the request.
  const players = [...ballots.keys()];
  const strength = new Map(players.map((p) => [p, 1]));
  const beat = (a: string, b: string) => wins.get(a)?.get(b) ?? 0;
  for (let iter = 0; iter < 200; iter++) {
    let maxDelta = 0;
    for (const p of players) {
      let num = 0, den = 0;
      for (const q of players) {
        if (p === q) continue;
        const pq = beat(p, q), qp = beat(q, p), n = pq + qp;
        if (!n) continue;
        num += pq;
        den += n / (strength.get(p)! + strength.get(q)!);
      }
      if (den > 0 && num > 0) {
        const next = num / den;
        maxDelta = Math.max(maxDelta, Math.abs(next - strength.get(p)!));
        strength.set(p, next);
      }
    }
    if (maxDelta < 1e-9) break;
  }

  // Present as 0-100 with 50 at the field's geometric mean, via a logistic of
  // the log-strength. A linear map is unbounded: on a well-separated field it
  // produced ratings above 130 and below zero, which reads as broken in a table.
  // The logistic cannot leave the range however far apart the engines are, and
  // is still monotonic in strength, so the ordering is unchanged.
  const shown = players.filter((p) => (ballots.get(p) ?? 0) >= MIN_BALLOTS_TO_SHOW);
  const logs = shown.map((p) => Math.log(strength.get(p)!));
  const mean = logs.length ? logs.reduce((a, b) => a + b, 0) / logs.length : 0;
  const rate = (s: number) => Math.round((100 / (1 + Math.exp(-(Math.log(s) - mean)))) * 10) / 10;

  const scores: Score[] = CONFIGS.map((c) => {
    const n = ballots.get(c) ?? 0;
    return {
      config: c,
      rating: n >= MIN_BALLOTS_TO_SHOW ? rate(strength.get(c) ?? 1) : null,
      ballots: n,
      wins: winCount.get(c) ?? 0,
      comparisons: comparisons.get(c) ?? 0,
    };
  });

  const counted = (results ?? []).length;
  return Response.json(
    { run: RUN, countedBallots: counted, minBallots: MIN_BALLOTS_TO_SHOW, scores },
    { headers: { 'Cache-Control': 'public, max-age=60' } }
  );
}
