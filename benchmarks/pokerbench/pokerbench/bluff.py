# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-bluff-v1-classify
"""How often does a seat bluff? Every postflop bet or raise is classified from
the cards alone (decisions.jsonl has the seat's hole cards and the board):

- **value**: a made hand of top pair or better that uses a hole card;
- **thin**: a weaker pair that uses a hole card (middle/bottom pair, underpair);
- **semi-bluff**: no pair of its own (or a weak one) but a strong draw -- four to
  a flush, or an open-ended straight draw -- before the river;
- **bluff**: nothing of its own: high card, or a hand made entirely by the
  board, with no strong draw (on the river, any such bet).

Then, for each bet or raise:
- ``behind_now``: at that moment some opponent still in held a better hand (from
  the hand result: hidden cards, used only for analysis);
- ``worked``: the hand ended without a showdown and the seat won it;
- ``declared``: the seat's own reason calls it a bluff ("bluff", "semi-bluff").
  Declared vs measured shows whether a model's self-reports are honest.

Preflop raises with a hand in roughly the weakest third (``bots._preflop_strength``
below LIGHT_RAISE) are counted separately as light raises.
"""

from __future__ import annotations

import re
from collections import Counter

from pokerkit import StandardHighHand

from .bots import _preflop_strength

BLUFF_REVISION = "pokerbench-bluff-v1-classify"
RANKS = "23456789TJQKA"
LIGHT_RAISE = 0.33
CLASSES = ("value", "thin", "semi_bluff", "bluff")
DECLARED = re.compile(r"\bbluff", re.I)


def _ranks(cards):
    return [RANKS.index(c[0]) + 2 for c in cards]


def _straight(ranks: set[int]) -> bool:
    rs = set(ranks) | ({1} if 14 in ranks else set())
    return any(all(r + i in rs for i in range(5)) for r in range(1, 11))


def category(cards: list[str]) -> int:
    """0 high card, 1 pair, 2 two pair, 3 trips, 4 straight, 5 flush, 6 full house,
    7 quads, 8 straight flush -- for any number of cards (a 3-card board too)."""
    if not cards:
        return 0
    counts = sorted(Counter(_ranks(cards)).values(), reverse=True)
    suits = Counter(c[1] for c in cards)
    flush_suit = next((s for s, k in suits.items() if k >= 5), None)
    if flush_suit and _straight(set(_ranks([c for c in cards if c[1] == flush_suit]))):
        return 8
    if counts[0] == 4:
        return 7
    if counts[0] == 3 and len(counts) > 1 and counts[1] >= 2:
        return 6
    if flush_suit:
        return 5
    if _straight(set(_ranks(cards))):
        return 4
    if counts[0] == 3:
        return 3
    if counts[0] == 2 and len(counts) > 1 and counts[1] == 2:
        return 2
    return 1 if counts[0] == 2 else 0


def made_hand(hole: list[str], board: list[str]) -> str:
    """air | weak_pair | top_pair | strong, counting only what the hole cards add."""
    mine, board_only = category(hole + board), category(board)
    if mine <= board_only or mine == 0:
        return "air"
    if mine >= 3 or (mine == 2 and board_only == 0):
        return "strong"
    # One pair of our own (on a paired board, "two pair" is still just our one pair).
    hr, br = _ranks(hole), _ranks(board)
    pair_rank = hr[0] if hr[0] == hr[1] else next(r for r in hr if r in br)
    return "top_pair" if pair_rank >= max(br) else "weak_pair"


def draw(hole: list[str], board: list[str]) -> str | None:
    """'strong' (flush draw or open-ender), 'weak' (gutshot) or None; only with board < 5."""
    if len(board) >= 5:
        return None
    cards = hole + board
    for s, k in Counter(c[1] for c in cards).items():
        if k == 4 and any(c[1] == s for c in hole) and category(cards) < 5:
            return "strong"
    rs = set(_ranks(cards)) | ({1} if 14 in _ranks(cards) else set())
    hole_rs = set(_ranks(hole)) | ({1} if 14 in _ranks(hole) else set())
    if category(cards) >= 4:
        return None
    for r in range(1, 12):  # four in a row, open at both ends
        run = {r + i for i in range(4)}
        if run <= rs and run & hole_rs and r - 1 >= 1 and r + 4 <= 14:
            return "strong"
    for r in range(1, 11):  # four of five
        window = {r + i for i in range(5)}
        if len(window & rs) == 4 and window & hole_rs:
            return "weak"
    return None


def classify(hole: list[str], board: list[str]) -> str:
    strength, d = made_hand(hole, board), draw(hole, board)
    if strength in ("strong", "top_pair"):
        return "value"
    if d == "strong":
        return "semi_bluff"
    return "thin" if strength == "weak_pair" else "bluff"


def _behind_now(seat: str, hole: list[str], board: list[str], others: list[str], result: dict) -> bool | None:
    holes = result.get("hole") or {}
    if not others or any(not holes.get(o) for o in others):
        return None
    mine = StandardHighHand.from_game("".join(hole), "".join(board))
    return any(StandardHighHand.from_game("".join(holes[o]), "".join(board)) > mine for o in others)


def analyse(decisions: list[dict], results: list[dict]) -> dict[str, dict]:
    """Per seat: postflop bets/raises by class, bluff rates, success, self-reports."""
    by_hand = {r["hand"]: r for r in results}
    out: dict[str, dict] = {}
    for d in decisions:
        seat = d["seat"]
        s = out.setdefault(seat, {"postflop_aggressive": 0, **{c: 0 for c in CLASSES}, "river_bluffs": 0,
                                  "bluffs_worked": 0, "bluffs_behind": 0, "declared": 0, "declared_measured": 0,
                                  "declared_but_value": 0, "preflop_raises": 0, "light_raises": 0, "examples": []})
        if d["timed_out"] or d["action"] not in ("bet", "raise"):
            continue
        hole, board = d.get("hole") or [], d.get("board") or []
        if len(hole) != 2:
            continue
        declared = bool(DECLARED.search(d.get("reason") or ""))
        if d["street"] == "preflop":
            s["preflop_raises"] += 1
            if _preflop_strength(hole) < LIGHT_RAISE:
                s["light_raises"] += 1
            continue
        cls = classify(hole, board)
        s["postflop_aggressive"] += 1
        s[cls] += 1
        result = by_hand.get(d["hand"]) or {}
        is_bluff = cls in ("bluff", "semi_bluff")
        if cls == "bluff" and d["street"] == "river":
            s["river_bluffs"] += 1
        if is_bluff:
            if not result.get("showdown") and (result.get("net") or {}).get(seat, 0) > 0:
                s["bluffs_worked"] += 1
            others = d.get("opponents_in")
            if others is None:  # older runs: everyone else still in
                others = [p for p in result.get("players", []) if p != seat and p not in (result.get("folded") or [])]
            if _behind_now(seat, hole, board, others, result):
                s["bluffs_behind"] += 1
            if len(s["examples"]) < 5:
                s["examples"].append({"hand": d["hand"], "street": d["street"], "class": cls, "hole": hole,
                                      "board": board, "action": d["action"], "amount": d.get("amount"),
                                      "reason": (d.get("reason") or "")[:200]})
        if declared:
            s["declared"] += 1
            if is_bluff:
                s["declared_measured"] += 1
            elif cls == "value":
                s["declared_but_value"] += 1
    for s in out.values():
        n = s["postflop_aggressive"]
        bluffs = s["bluff"] + s["semi_bluff"]
        s["bluff_pct"] = round(100 * s["bluff"] / n, 1) if n else None
        s["semi_bluff_pct"] = round(100 * s["semi_bluff"] / n, 1) if n else None
        s["bluff_success_pct"] = round(100 * s["bluffs_worked"] / bluffs, 1) if bluffs else None
        s["light_raise_pct"] = round(100 * s["light_raises"] / s["preflop_raises"], 1) if s["preflop_raises"] else None
    return out
