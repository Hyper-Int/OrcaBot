# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-stats-v2-n-seat-duplicate
"""Win-rate statistics.

The headline number is bb/100 (big blinds won per 100 hands). Its confidence
interval is computed over *duplicate pairs* -- the two mirrored plays of one
deal -- rather than over single hands: the pair total cancels most of the card
luck, so the interval is far tighter for the same number of hands.
"""

from __future__ import annotations

import math
from collections import defaultdict

STATS_REVISION = "pokerbench-stats-v2-n-seat-duplicate"
Z95 = 1.959964


def _mean_ci(values: list[float]) -> tuple[float | None, float | None]:
    n = len(values)
    if n == 0:
        return None, None
    mean = sum(values) / n
    if n < 2:
        return mean, None
    var = sum((v - mean) ** 2 for v in values) / (n - 1)
    return mean, Z95 * math.sqrt(var / n)


def leaderboard(results: list[dict], seats, big_blind: int) -> list[dict]:
    """Per-seat totals, sorted best first.

    ``bb_per_100`` uses every hand. ``dup_bb_per_100`` and its ``dup_ci95`` use
    only deals whose every duplicate play is complete (2 plays heads-up, one per
    seat at a bigger table); ``None`` until there are enough.
    """
    per_deal: dict[int, list[dict]] = defaultdict(list)
    for r in results:
        per_deal[r["deal"]].append(r)
    group = len(seats)
    pairs = [hands for hands in per_deal.values() if len(hands) == group]

    rows = []
    for seat in seats:
        hands = [r for r in results if seat in r["net"]]
        net = sum(r["net"][seat] for r in hands)
        n = len(hands)
        # A group is `group` hands, so per-hand rate = group total / group.
        pair_rates = [sum(h["net"].get(seat, 0) for h in pair) / group / big_blind * 100 for pair in pairs]
        dup_mean, dup_ci = _mean_ci(pair_rates)
        single_mean, single_ci = _mean_ci([r["net"][seat] / big_blind * 100 for r in hands])
        rows.append({
            "seat": seat,
            "hands": n,
            "net_chips": net,
            "bb_per_100": round(single_mean, 2) if single_mean is not None else None,
            "ci95": round(single_ci, 2) if single_ci is not None else None,
            "duplicate_pairs": len(pairs),
            "dup_bb_per_100": round(dup_mean, 2) if dup_mean is not None else None,
            "dup_ci95": round(dup_ci, 2) if dup_ci is not None else None,
            "showdowns_won": sum(1 for r in hands if r["showdown"] and r["net"][seat] > 0),
            "hands_won": sum(1 for r in hands if r["net"][seat] > 0),
        })
    rows.sort(key=lambda r: r["net_chips"], reverse=True)
    return rows
