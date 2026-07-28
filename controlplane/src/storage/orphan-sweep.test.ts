import { describe, it, expect } from 'vitest';
import { sweepOrphanedStorage } from './orphan-sweep';
import type { EnvWithDriveCache } from './drive-cache';

/** In-memory R2 with delimited listing, paging, sizes and bulk delete. */
function makeBucket(entries: Record<string, number>) {
  const store = new Map(Object.entries(entries));

  return {
    store,
    bucket: {
      async list(options?: {
        prefix?: string;
        cursor?: string;
        limit?: number;
        delimiter?: string;
      }) {
        const prefix = options?.prefix ?? '';
        const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();

        if (options?.delimiter) {
          const prefixes = new Set<string>();
          for (const key of all) {
            const rest = key.slice(prefix.length);
            const idx = rest.indexOf(options.delimiter);
            if (idx >= 0) prefixes.add(prefix + rest.slice(0, idx + 1));
          }
          return { objects: [], truncated: false, delimitedPrefixes: [...prefixes] };
        }

        const limit = options?.limit ?? 1000;
        const start = options?.cursor ? Number(options.cursor) : 0;
        const page = all.slice(start, start + limit);
        const next = start + page.length;
        const truncated = next < all.length;
        return {
          objects: page.map((key) => ({ key, size: store.get(key) ?? 0 })),
          truncated,
          ...(truncated ? { cursor: String(next) } : {}),
          delimitedPrefixes: [],
        };
      },
      async delete(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
      },
    },
  };
}

/** D1 stand-in answering only the `SELECT id FROM dashboards WHERE id IN (...)`. */
function makeDb(liveIds: string[]) {
  return {
    prepare(_sql: string) {
      let bound: string[] = [];
      const stmt = {
        bind(...args: string[]) {
          bound = args;
          return stmt;
        },
        async all<T>() {
          return {
            results: bound
              .filter((id) => liveIds.includes(id))
              .map((id) => ({ id }) as unknown as T),
          };
        },
      };
      return stmt;
    },
  };
}

const envFor = (bucket: unknown, liveIds: string[]) =>
  ({ DRIVE_CACHE: bucket, DB: makeDb(liveIds) }) as unknown as EnvWithDriveCache;

describe('sweepOrphanedStorage', () => {
  const bucketContents = {
    // live dashboard
    'workspace/live-1/snapshot.json': 10,
    'drive/live-1/files/a': 100,
    // deleted dashboard
    'workspace/dead-1/snapshot.json': 20,
    'drive/dead-1/manifest.json': 5,
    'drive/dead-1/files/b': 200,
    'mirror/github/dead-1/files/c': 300,
    // deleted dashboard, only mirrored content
    'mirror/dropbox/dead-2/files/d': 400,
  };

  it('reports orphans without deleting on a dry run', async () => {
    const { bucket, store } = makeBucket(bucketContents);
    const before = store.size;

    const result = await sweepOrphanedStorage(envFor(bucket, ['live-1']));

    expect(result.dryRun).toBe(true);
    expect(result.orphans.sort()).toEqual(['dead-1', 'dead-2']);
    expect(result.objects).toBe(5);
    expect(result.bytes).toBe(20 + 5 + 200 + 300 + 400);
    // Nothing removed.
    expect(store.size).toBe(before);
  });

  it('deletes only orphaned dashboards when applied', async () => {
    const { bucket, store } = makeBucket(bucketContents);

    const result = await sweepOrphanedStorage(envFor(bucket, ['live-1']), { apply: true });

    expect(result.dryRun).toBe(false);
    expect([...store.keys()].sort()).toEqual([
      'drive/live-1/files/a',
      'workspace/live-1/snapshot.json',
    ]);
  });

  it('honours limit and flags truncation', async () => {
    const { bucket, store } = makeBucket(bucketContents);

    const result = await sweepOrphanedStorage(envFor(bucket, ['live-1']), {
      apply: true,
      limit: 1,
    });

    expect(result.orphans).toHaveLength(1);
    expect(result.truncated).toBe(true);
    // The unprocessed orphan's objects survive this batch.
    expect([...store.keys()].some((k) => k.includes(result.orphans[0]))).toBe(false);
    expect(store.size).toBeGreaterThan(2);
  });

  it('does nothing when every dashboard is live', async () => {
    const { bucket, store } = makeBucket(bucketContents);
    const before = store.size;

    const result = await sweepOrphanedStorage(
      envFor(bucket, ['live-1', 'dead-1', 'dead-2']),
      { apply: true }
    );

    expect(result.orphans).toEqual([]);
    expect(result.objects).toBe(0);
    expect(store.size).toBe(before);
  });

  it('pages discovery past the 1000-object list cap', async () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 2500; i++) many[`drive/dead-1/files/f-${i}`] = 1;
    const { bucket, store } = makeBucket(many);

    const result = await sweepOrphanedStorage(envFor(bucket, []), { apply: true });

    expect(result.objects).toBe(2500);
    expect(store.size).toBe(0);
  });
});
