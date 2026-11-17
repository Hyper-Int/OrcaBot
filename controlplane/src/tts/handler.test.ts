// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Ballot selection is weighted toward the configurations ranked least, because
// uniform sampling left the counts Poisson-spread: at 43 real ballots that was 2
// to 9 appearances around a mean of 4.7, with six configurations stranded below
// the display cutoff while others were measured twice over.
//
// The properties worth pinning are the ones a plausible rewrite would break.
// Duplicates are the sharpest: a ballot showing the same clip twice asks the
// reader to rank it against itself. The bias is the point of the function. And
// the bias must stay a bias rather than becoming an ordering, because always
// serving the k rarest as a set would leave them only ever ranked against each
// other, and Bradley-Terry cannot place a disconnected clique on the same scale
// as the rest of the table.

import { describe, expect, it } from 'vitest';
import { pickLeastRanked } from './handler';

const counts = (o: Record<string, number>) => new Map(Object.entries(o));

describe('pickLeastRanked', () => {
  it('returns exactly k items', () => {
    const pool = ['a', 'b', 'c', 'd', 'e'];
    for (const k of [1, 2, 3, 4]) {
      expect(pickLeastRanked(pool, k, counts({})).length).toBe(k);
    }
  });

  it('never repeats a configuration within one ballot', () => {
    // Sampling without replacement, not k independent draws. With a heavy skew
    // an implementation that drew independently would return the rare item
    // several times, and the ballot would ask for it to be ranked against itself.
    const pool = ['rare', 'common1', 'common2', 'common3'];
    const c = counts({ rare: 0, common1: 40, common2: 40, common3: 40 });
    for (let i = 0; i < 400; i++) {
      const got = pickLeastRanked(pool, 3, c);
      expect(new Set(got).size).toBe(got.length);
    }
  });

  it('returns the whole pool when k covers it, without dropping any', () => {
    const pool = ['a', 'b', 'c'];
    const got = pickLeastRanked(pool, 3, counts({ a: 9, b: 0, c: 4 }));
    expect([...got].sort()).toEqual(['a', 'b', 'c']);
    expect(pickLeastRanked(pool, 9, counts({})).length).toBe(3);
  });

  it('picks the least-ranked far more often than the most-ranked', () => {
    const pool = ['rare', 'mid', 'common'];
    const c = counts({ rare: 0, mid: 4, common: 12 });
    const seen: Record<string, number> = { rare: 0, mid: 0, common: 0 };
    for (let i = 0; i < 3000; i++) {
      for (const p of pickLeastRanked(pool, 1, c)) seen[p]++;
    }
    expect(seen.rare).toBeGreaterThan(seen.mid);
    expect(seen.mid).toBeGreaterThan(seen.common);
    // Comfortably wide of the 3000/3 a uniform pick would give each.
    expect(seen.rare).toBeGreaterThan(1500);
  });

  it('still reaches a well-ranked configuration sometimes', () => {
    // A strict least-first ordering would return `rare` every time and starve
    // the rest, which disconnects the comparison graph. The weighting has to
    // leave every pairing reachable.
    const pool = ['rare', 'common'];
    const c = counts({ rare: 0, common: 8 });
    let common = 0;
    for (let i = 0; i < 3000; i++) {
      if (pickLeastRanked(pool, 1, c)[0] === 'common') common++;
    }
    expect(common).toBeGreaterThan(0);
  });

  it('treats an unseen configuration as the rarest', () => {
    // Absent from the map means never ranked, which is a zero rather than a gap.
    // Defaulting it the other way would starve exactly the new arrivals a fresh
    // export adds.
    const pool = ['brand-new', 'established'];
    const c = counts({ established: 6 }); // brand-new absent entirely
    let fresh = 0;
    for (let i = 0; i < 2000; i++) {
      if (pickLeastRanked(pool, 1, c)[0] === 'brand-new') fresh++;
    }
    expect(fresh).toBeGreaterThan(1400);
  });

  it('is near-uniform once counts are high and close together', () => {
    // 1/(count+1) self-attenuates: the bias matters when 2 against 9 decides
    // visibility, and should fade when everything is well measured.
    const pool = ['a', 'b'];
    const c = counts({ a: 60, b: 64 });
    let a = 0;
    for (let i = 0; i < 4000; i++) {
      if (pickLeastRanked(pool, 1, c)[0] === 'a') a++;
    }
    expect(a).toBeGreaterThan(1900);
    expect(a).toBeLessThan(2600);
  });
});
