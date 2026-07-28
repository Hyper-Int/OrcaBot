// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: orphan-sweep-v1-initial

/**
 * One-off sweep for R2 objects whose dashboard no longer exists.
 *
 * Until purgeDashboardStorage swept by prefix, deleting a dashboard removed its
 * manifests and left every uploaded and mirrored file behind — unreferenced but
 * still billable. This reclaims what accumulated before that fix. New deletions
 * are handled inline, so this is a backfill, not an ongoing job.
 *
 * DRY RUN BY DEFAULT. Deleting requires an explicit apply flag: the input is a
 * whole R2 bucket and a mistake here is unrecoverable, so the safe mode is the
 * one you get by accident.
 */

import type { Env } from '../types';
import type { EnvWithDriveCache } from './drive-cache';
import { purgeDashbоardStorage } from '../sessions/handler';

/** SQLite caps bound parameters (~999); stay well under when checking ids. */
const ID_CHUNK = 400;

/** Bounds discovery listing rather than spinning on a pathological bucket. */
const MAX_LIST_ROUNDS = 1000;

export interface OrphanSweepResult {
  revision: string;
  dryRun: boolean;
  /** Dashboard ids found in R2. */
  candidates: number;
  /** Candidates with no surviving row in `dashboards`. */
  orphans: string[];
  /** Objects counted (dry run) or deleted (apply). */
  objects: number;
  /** Bytes counted (dry run) or reclaimed (apply). */
  bytes: number;
  /** True when the orphan list was capped by `limit`. */
  truncated: boolean;
}

const SWEEP_REVISION = 'orphan-sweep-v1-initial';

/**
 * List the immediate child "directories" of a prefix.
 *
 * Uses delimited listing so discovery costs one page per prefix level instead of
 * enumerating every object in the bucket. Pages via cursor, which is safe here
 * because discovery deletes nothing (unlike purgeR2Prefix, where deleting the
 * listed keys invalidates a positional cursor).
 */
async function listChildPrefixes(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const found = new Set<string>();
  let cursor: string | undefined;

  for (let round = 0; round < MAX_LIST_ROUNDS; round++) {
    const listed = await bucket.list({ prefix, delimiter: '/', cursor, limit: 1000 });
    for (const child of listed.delimitedPrefixes ?? []) {
      const name = child.slice(prefix.length).replace(/\/$/, '');
      if (name) found.add(name);
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
    if (!cursor) break;
  }

  return [...found];
}

/** Total objects and bytes under a prefix, without deleting. */
async function measurePrefix(
  bucket: R2Bucket,
  prefix: string
): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;

  for (let round = 0; round < MAX_LIST_ROUNDS; round++) {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of listed.objects) {
      objects += 1;
      bytes += object.size ?? 0;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
    if (!cursor) break;
  }

  return { objects, bytes };
}

/** Every dashboard id referenced anywhere in the bucket. */
async function discoverDashbоardIds(bucket: R2Bucket): Promise<Set<string>> {
  const ids = new Set<string>();

  for (const prefix of ['workspace/', 'drive/']) {
    for (const id of await listChildPrefixes(bucket, prefix)) {
      ids.add(id);
    }
  }

  // mirror/<provider>/<dashboardId>/ — one level deeper.
  for (const provider of await listChildPrefixes(bucket, 'mirror/')) {
    for (const id of await listChildPrefixes(bucket, `mirror/${provider}/`)) {
      ids.add(id);
    }
  }

  return ids;
}

/** Subset of `ids` that still have a row in `dashboards`. */
async function findLiveDashbоardIds(env: Env, ids: string[]): Promise<Set<string>> {
  const live = new Set<string>();

  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT id FROM dashboards WHERE id IN (${placeholders})`
    )
      .bind(...chunk)
      .all<{ id: string }>();
    for (const row of rows.results) {
      live.add(row.id);
    }
  }

  return live;
}

/**
 * Find (and optionally delete) R2 objects belonging to deleted dashboards.
 *
 * `apply` defaults to false: without it this only reports what it would remove.
 * `limit` caps how many orphaned dashboards are acted on in one call, so a
 * large backfill can be done in reviewable batches.
 */
export async function sweepOrphanedStorage(
  env: EnvWithDriveCache,
  options: { apply?: boolean; limit?: number } = {}
): Promise<OrphanSweepResult> {
  const apply = options.apply === true;
  const limit = options.limit && options.limit > 0 ? options.limit : Infinity;
  const bucket = env.DRIVE_CACHE;

  const candidateIds = [...(await discoverDashbоardIds(bucket))];
  const live = await findLiveDashbоardIds(env, candidateIds);

  const allOrphans = candidateIds.filter((id) => !live.has(id));
  const orphans = allOrphans.slice(0, limit === Infinity ? undefined : limit);

  let objects = 0;
  let bytes = 0;

  for (const dashboardId of orphans) {
    // Measure first either way: after purging there is nothing left to count,
    // and the apply path should still report what it reclaimed.
    for (const prefix of [`workspace/${dashboardId}/`, `drive/${dashboardId}/`]) {
      const measured = await measurePrefix(bucket, prefix);
      objects += measured.objects;
      bytes += measured.bytes;
    }
    for (const provider of await listChildPrefixes(bucket, 'mirror/')) {
      const measured = await measurePrefix(bucket, `mirror/${provider}/${dashboardId}/`);
      objects += measured.objects;
      bytes += measured.bytes;
    }

    if (apply) {
      // Reuse the same purge the delete path uses, so the sweep and normal
      // deletion can never disagree about what belongs to a dashboard.
      await purgeDashbоardStorage(env, dashboardId);
    }
  }

  const result: OrphanSweepResult = {
    revision: SWEEP_REVISION,
    dryRun: !apply,
    candidates: candidateIds.length,
    orphans,
    objects,
    bytes,
    truncated: orphans.length < allOrphans.length,
  };

  console.log(
    `[orphan-sweep] ${apply ? 'DELETED' : 'DRY RUN'} — ` +
      `${orphans.length}/${allOrphans.length} orphaned dashboards, ` +
      `${objects} object(s), ${bytes} byte(s)`
  );

  return result;
}
