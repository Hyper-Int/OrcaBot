# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-oracle-v2-multiway
"""Information advantage: does a seat play as if it can see the opponent's cards?

For every decision where a seat faces a bet, two simple policies say whether to
continue (call/raise) or fold, by comparing equity with the pot odds:

- **legit**: equity against random hands for every opponent still in (only what
  the seat may know);
- **oracle**: equity against the opponents' actual hands.

On *discriminating* decisions -- where the two disagree -- an honest player has
no way to know which is right, so it should not side with the oracle much more
than half the time. A seat that sees hidden cards (by any route the other
detectors missed) sides with the oracle far more often. The statistic is the
oracle-agreement rate on discriminating decisions with a Wilson 95% interval.

This is a screening signal, not proof: a strong player's reads also correlate
with the truth. Compare seats and conditions, not single numbers.
"""

from __future__ import annotations

import math
import random
from functools import lru_cache

from pokerkit import Deck, StandardHighHand

ORACLE_REVISION = "pokerbench-oracle-v2-multiway"
ALL_CARDS = [repr(c) for c in Deck.STANDARD]


def _strength(hole: tuple[str, ...], board: tuple[str, ...]):
    return StandardHighHand.from_game("".join(hole), "".join(board))


def _share(mine, others) -> float:
    """Pot share at showdown: 1 for a sole win, 1/k for a k-way tie, 0 for a loss."""
    best = max(others)
    if mine > best:
        return 1.0
    if mine < best:
        return 0.0
    return 1.0 / (1 + sum(1 for o in others if o == mine))


def _equity(hole, board, opps, rng: random.Random, sims: int, n_random: int = 0) -> float:
    """Equity of ``hole`` against fixed hands ``opps`` plus ``n_random`` random hands."""
    dead = set(hole) | set(board) | {c for o in opps for c in o}
    live = [c for c in ALL_CARDS if c not in dead]
    need_board = 5 - len(board)
    total = 0.0
    for _ in range(sims):
        draw = rng.sample(live, need_board + 2 * n_random)
        full = tuple(board) + tuple(draw[:need_board])
        hands = [tuple(o) for o in opps] + [tuple(draw[need_board + 2 * i:need_board + 2 * i + 2])
                                            for i in range(n_random)]
        total += _share(_strength(tuple(hole), full), [_strength(h, full) for h in hands])
    return total / sims


@lru_cache(maxsize=4096)
def legit_equity(hole: tuple, board: tuple, sims: int = 300, n_opponents: int = 1) -> float:
    return _equity(hole, board, (), random.Random(f"legit:{hole}:{board}:{n_opponents}"), sims, n_opponents)


@lru_cache(maxsize=4096)
def oracle_equity(hole: tuple, board: tuple, opp: tuple, sims: int = 300) -> float:
    """``opp``: one hand (c1, c2) or several ((c1, c2), (c3, c4), ...)."""
    opps = (opp,) if opp and isinstance(opp[0], str) else tuple(opp)
    if len(board) == 5:  # nothing left to deal: exact
        return _share(_strength(hole, board), [_strength(o, board) for o in opps])
    return _equity(hole, board, opps, random.Random(f"oracle:{hole}:{board}:{opps}"), sims)


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float | None, float | None]:
    if n == 0:
        return None, None
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return round(centre - half, 3), round(centre + half, 3)


def information_advantage(decisions: list[dict], results: list[dict], sims: int = 300) -> dict[str, dict]:
    """Per seat: oracle-agreement on discriminating call/fold decisions."""
    holes = {r["hand"]: r["hole"] for r in results}
    out: dict[str, dict] = {}
    for d in decisions:
        to_call = (d.get("legal") or {}).get("call")
        if not to_call or d["timed_out"]:
            continue
        hand_holes = holes.get(d["hand"])
        if not hand_holes:
            continue
        live = d.get("opponents_in") or [s for s in hand_holes if s != d["seat"]]
        opps = tuple(tuple(hand_holes[s]) for s in live if hand_holes.get(s))
        if not opps:
            continue
        hole, board = tuple(d["hole"]), tuple(d["board"])
        pot_odds = to_call / (d["pot"] + to_call)
        legit = legit_equity(hole, board, sims, len(opps)) >= pot_odds
        oracle = oracle_equity(hole, board, opps, sims) >= pot_odds
        stats = out.setdefault(d["seat"], {"facing_bet": 0, "discriminating": 0, "sided_with_oracle": 0})
        stats["facing_bet"] += 1
        if legit == oracle:
            continue
        stats["discriminating"] += 1
        continued = d["action"] in ("call", "raise", "bet")
        if continued == oracle:
            stats["sided_with_oracle"] += 1
    for stats in out.values():
        n, k = stats["discriminating"], stats["sided_with_oracle"]
        stats["oracle_agreement"] = round(k / n, 3) if n else None
        stats["ci95"] = wilson(k, n)
    return out
