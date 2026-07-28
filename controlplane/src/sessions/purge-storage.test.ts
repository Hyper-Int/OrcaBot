import { describe, it, expect } from 'vitest';
import { purgeDashbоardStorage } from './handler';
import type { EnvWithDriveCache } from '../storage/drive-cache';

/**
 * Minimal in-memory R2 stand-in.
 *
 * Implements just what purgeDashboardStorage touches: prefix listing with a
 * 1000-key page cap and a cursor, delimited listing, and bulk delete. The page
 * cap is the point — the real bucket truncates at 1000, so a dashboard with
 * more cached files than that is exactly where a missing cursor loop silently
 * strands objects.
 */
function makeBucket(keys: string[]) {
  const store = new Set(keys);
  const deleteCalls: number[] = [];

  const bucket = {
    async list(options?: {
      prefix?: string;
      cursor?: string;
      limit?: number;
      delimiter?: string;
    }) {
      const prefix = options?.prefix ?? '';
      const all = [...store].filter((k) => k.startsWith(prefix)).sort();

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
        objects: page.map((key) => ({ key })),
        truncated,
        ...(truncated ? { cursor: String(next) } : {}),
        delimitedPrefixes: [],
      };
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      deleteCalls.push(list.length);
      for (const key of list) store.delete(key);
    },
  };

  return { bucket, store, deleteCalls };
}

const envFor = (bucket: unknown) => ({ DRIVE_CACHE: bucket }) as unknown as EnvWithDriveCache;

describe('purgeDashboardStorage', () => {
  const DASH = 'dash-1';

  it('deletes per-file objects, not just manifests', async () => {
    const { bucket, store } = makeBucket([
      `workspace/${DASH}/snapshot.json`,
      `drive/${DASH}/manifest.json`,
      `drive/${DASH}/files/file-a`,
      `drive/${DASH}/files/file-b`,
      `mirror/github/${DASH}/manifest.json`,
      `mirror/github/${DASH}/files/repo-1`,
      `mirror/box/${DASH}/files/box-1`,
    ]);

    await purgeDashbоardStorage(envFor(bucket), DASH);

    expect([...store]).toEqual([]);
  });

  it('leaves other dashboards untouched', async () => {
    const other = [
      `workspace/dash-2/snapshot.json`,
      `drive/dash-2/files/file-a`,
      `mirror/github/dash-2/files/repo-1`,
    ];
    const { bucket, store } = makeBucket([
      `drive/${DASH}/files/file-a`,
      `mirror/github/${DASH}/files/repo-1`,
      ...other,
    ]);

    await purgeDashbоardStorage(envFor(bucket), DASH);

    expect([...store].sort()).toEqual([...other].sort());
  });

  it('pages past the 1000-key list cap', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => `drive/${DASH}/files/file-${i}`);
    const { bucket, store } = makeBucket(many);

    await purgeDashbоardStorage(envFor(bucket), DASH);

    expect([...store]).toEqual([]);
  });

  it('purges a mirror provider discovered from the bucket', async () => {
    // Not in the hardcoded provider list — must still be swept.
    const { bucket, store } = makeBucket([
      `mirror/dropbox/${DASH}/manifest.json`,
      `mirror/dropbox/${DASH}/files/f-1`,
    ]);

    await purgeDashbоardStorage(envFor(bucket), DASH);

    expect([...store]).toEqual([]);
  });

  it('continues purging other prefixes when one fails', async () => {
    const { bucket, store } = makeBucket([
      `workspace/${DASH}/snapshot.json`,
      `drive/${DASH}/files/file-a`,
    ]);
    const realList = bucket.list.bind(bucket);
    bucket.list = async (options?: Parameters<typeof realList>[0]) => {
      if (options?.prefix === `workspace/${DASH}/`) throw new Error('R2 unavailable');
      return realList(options);
    };

    await purgeDashbоardStorage(envFor(bucket), DASH);

    // The failing prefix survives; the healthy one is still cleaned up.
    expect([...store]).toEqual([`workspace/${DASH}/snapshot.json`]);
  });
});
