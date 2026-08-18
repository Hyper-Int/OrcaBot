// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: tts-ballots-v2-full-config-set

import type { Env } from '../types';

const MODULE_REVISION = 'tts-ballots-v2-full-config-set';
console.log(`[tts] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

/** The run these ballots score. Bumped when a new TTS run replaces the samples. */
const RUN = '2026-08';

/**
 * Every configuration a ballot can draw from. Kept server-side so a client
 * cannot nominate its own comparison set (or vote for something that is not in
 * the benchmark at all).
 *
 * Only configurations that have a published clip. The dialog drops anything it
 * cannot play, but submitBallot requires the ranking to be a permutation of the
 * items it issued - so seeding a clip-less configuration produces a ballot the
 * reader can complete and the server is then obliged to reject.
 */
const CONFIGS = [
  'piper', 'chatterbox-turbo', 'kittentts-micro', 'kittentts-nano-int8',
  'kittentts-mini', 'qwen3-tts', 'kittentts-nano', 'chatterbox', 'f5-tts',
  'dots-tts', 'kokoro', 'xtts', 'nt-2e-q8-metal', 'nt-2e-fp32-mps',
  'chatterbox-q8', 'vibevoice', 'nt-2e-q4-metal', 'cosyvoice3-rl',
  'chatterbox-q4', 'styletts2', 'melotts', 'omnivoice', 'cosyvoice3',
  'bananamind-tts', 'fastpitch', 'tada-3b', 'zonos', 'csm', 'tada-1b',
  'mms-tts', 'speecht5', 'vibevoice-1.5b', 'parler-tts', 'bark',
] as const;

/**
 * Deliberately weak engines, seeded into a share of ballots as an attention
 * check: ranking one of these best means the ballot is noise or gaming.
 *
 * bark is back. The table now lists every configuration rather than only the
 * real-time ones, so the 55%-word-error engine no longer has to be excluded,
 * and it is the one nobody listening could rank first in good faith.
 * vibevoice-1.5b joins it at 37% word error and the lowest PESQ measured (1.60).
 *
 * Two anchors rather than one matters: with a single known-bad engine a
 * determined submitter can simply learn never to rank it first. Speed is not a
 * disqualifier here - a ballot asks how something sounds, not how fast it is -
 * so slow engines are in the pool like any other.
 */
const ANCHORS = ['bark', 'vibevoice-1.5b'];
const ANCHOR_RATE = 0.34;
const ITEMS_PER_BALLOT = 4;

/** Below this, a configuration shows no human score rather than a noisy one. */
export const MIN_BALLOTS_TO_SHOW = 8;

/** Ballots one voter may contribute. Enough that someone willing to listen adds
 *  real signal, few enough that no single pair of ears can move a rating on its
 *  own - which is the failure mode of an open, unauthenticated vote. */
const MAX_BALLOTS_PER_VOTER = 3;

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

/** What this voter has already done. Both limits below are enforced here rather
 *  than in the client, which cannot be trusted to count its own votes. */
async function voterHistory(env: Env, voter: string) {
  const { results } = await env.DB.prepare(
    `SELECT items_json, status FROM tts_ballots
     WHERE voter_hash = ? AND run = ? AND status IN ('counted','rejected')`
  ).bind(voter, RUN).all<{ items_json: string; status: string }>();

  // Only submitted ballots count. An issued-then-abandoned one must not burn an
  // attempt or retire four clips, or closing the dialog would quietly cost the
  // reader a vote.
  const heard = new Set<string>();
  for (const r of results ?? []) {
    try { for (const c of JSON.parse(r.items_json)) heard.add(c); } catch { /* skip */ }
  }
  return { submitted: (results ?? []).length, heard };
}

/** GET /tts/ballot - issue a blind comparison set. */
export async function issueBallot(env: Env, request: Request): Promise<Response> {
  const voter = await voterHash(request);
  const { submitted, heard } = await voterHistory(env, voter);

  if (submitted >= MAX_BALLOTS_PER_VOTER) {
    return Response.json({ exhausted: 'limit', submitted, max: MAX_BALLOTS_PER_VOTER });
  }

  // Nothing already ranked comes back. A second opinion on the same clip from
  // the same ears is not a second data point, and Bradley-Terry would treat it
  // as one.
  // Widened to string[]: CONFIGS is a literal tuple, and ANCHORS is not.
  const fresh: string[] = CONFIGS.filter((c) => !heard.has(c));
  if (fresh.length < 2) {
    return Response.json({ exhausted: 'clips', submitted, max: MAX_BALLOTS_PER_VOTER });
  }

  // The anchor has to be one they have not heard either, or the attention check
  // is just a memory test.
  const freshAnchors = ANCHORS.filter((a) => fresh.includes(a));
  const anchor =
    freshAnchors.length && Math.random() < ANCHOR_RATE
      ? freshAnchors[Math.floor(Math.random() * freshAnchors.length)]
      : null;

  const pool = fresh.filter((c) => c !== anchor);
  const want = Math.min(ITEMS_PER_BALLOT, fresh.length) - (anchor ? 1 : 0);
  const picked = shuffle(pool).slice(0, want);
  const items = shuffle(anchor ? [...picked, anchor] : picked);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO tts_ballots (id, run, items_json, anchor_config, voter_hash) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, RUN, JSON.stringify(items), anchor, voter).run();

  // The anchor is deliberately NOT returned: the client must not be able to
  // tell which item is the attention check.
  return Response.json({ ballotId: id, items, submitted, max: MAX_BALLOTS_PER_VOTER });
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
    `SELECT items_json, anchor_config, status, voter_hash FROM tts_ballots WHERE id = ?`
  ).bind(ballotId).first<{ items_json: string; anchor_config: string | null; status: string; voter_hash: string }>();

  if (!row) return Response.json({ error: 'E79602: Unknown ballot' }, { status: 404 });

  // Checked again at submit, not only at issue. Issuing is cheap and
  // unauthenticated, so anyone can hold several open ballots and submit them
  // all; the cap has to be applied where the vote is actually recorded.
  const { submitted } = await voterHistory(env, row.voter_hash);
  if (submitted >= MAX_BALLOTS_PER_VOTER) {
    return Response.json(
      { error: `E79605: This voter has already submitted ${MAX_BALLOTS_PER_VOTER} ballots`, code: 'BALLOT_LIMIT' },
      { status: 409 }
    );
  }
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
