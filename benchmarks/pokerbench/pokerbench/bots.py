# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-bots-v1
"""Simple reference bots.

They drive the engine through exactly the same seat API as agents, so they are
both the end-to-end test harness and fixed (weak) opponents. Stronger reference
opponents (Slumbot, an OpenSpiel CFR bot) are a later phase.
"""

from __future__ import annotations

import random
from typing import Callable

from pokerkit import Card, StandardHighHand

from .cli import Client

BOTS_REVISION = "pokerbench-bots-v1"
RANKS = "23456789TJQKA"

Decision = tuple[str, "int | None", str]


def _preflop_strength(hole: list[str]) -> float:
    """Rough 0..1 preflop strength (pairs, high cards, suitedness, connectedness)."""
    r1, r2 = sorted((RANKS.index(c[0]) for c in hole), reverse=True)
    suited = hole[0][1] == hole[1][1]
    if r1 == r2:
        return 0.5 + r1 / 24  # 22 = 0.50 .. AA = 1.00
    score = 0.15 + (r1 + r2) / 24 * 0.45  # 32o ~ 0.21 .. AKo ~ 0.58
    if suited:
        score += 0.06
    gap = r1 - r2
    score += 0.04 if gap == 1 else 0.02 if gap == 2 else 0.0
    return min(score, 0.85)


def _made_hand_class(hole: list[str], board: list[str]) -> int:
    """0 high card, 1 pair, 2 two pair, 3 trips, 4+ straight or better."""
    cards = "".join(hole + board)
    best = StandardHighHand.from_game(cards[:4], cards[4:])
    label = best.entry.label.value.lower()
    order = ["high card", "one pair", "two pair", "three of a kind"]
    return order.index(label) if label in order else 4


def call_bot(view: dict, rng: random.Random) -> Decision:
    legal = view["legal"]
    return ("check" if "check" in legal else "call"), None, "calling station"


def random_bot(view: dict, rng: random.Random) -> Decision:
    legal = view["legal"]
    choices = [k for k in ("fold", "check", "call", "bet", "raise") if k in legal]
    action = rng.choice(choices)
    if action in ("bet", "raise"):
        lo, hi = legal[action]["min"], legal[action]["max"]
        return action, rng.randint(lo, min(hi, lo * 3)), "random"
    return action, None, "random"


def tight_bot(view: dict, rng: random.Random) -> Decision:
    legal = view["legal"]
    hole, board, pot = view["you"]["hole"], view["board"], view["pot"]
    to_call = legal.get("call", 0)
    if not board:
        strength = _preflop_strength(hole)
    else:
        strength = [0.25, 0.55, 0.75, 0.85, 0.95][_made_hand_class(hole, board)]
    kind = "raise" if "raise" in legal else "bet" if "bet" in legal else None
    if strength > 0.62 and kind:
        lo, hi = legal[kind]["min"], legal[kind]["max"]
        return kind, min(hi, max(lo, pot)), f"strong ({strength:.2f})"
    if "check" in legal:
        return "check", None, f"check ({strength:.2f})"
    if strength > 0.38 or to_call <= pot * 0.34:
        return "call", None, f"call ({strength:.2f}, price {to_call}/{pot})"
    return "fold", None, f"fold ({strength:.2f})"


STRATEGIES: dict[str, Callable[[dict, random.Random], Decision]] = {
    "call": call_bot,
    "random": random_bot,
    "tight": tight_bot,
}


def play(client: Client, strategy: str, seed: int = 0, max_wait: float = 600.0, on_hand=None) -> dict:
    """Play until the match finishes. Returns the final view."""
    decide = STRATEGIES[strategy]
    rng = random.Random(seed)
    while True:
        view = client.wait_for_turn(max_wait)
        if view["match"]["status"] == "finished":
            return view
        if not view.get("to_act"):
            continue
        action, amount, reason = decide(view, rng)
        resp = client.act(action, amount, reason)
        if on_hand and resp.get("hand_result"):
            on_hand(resp["hand_result"])
