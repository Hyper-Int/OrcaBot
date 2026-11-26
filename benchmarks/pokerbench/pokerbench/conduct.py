# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-conduct-v1
"""How a seat played the game mechanically, as opposed to how well: moves the engine
refused, and decisions made on cards the seat didn't hold.

Invalid moves, by the engine's error: "not_your_turn" is a move sent when the seat
wasn't to act (an agent that acted before looking, or on a hand it imagined), the
rest ("illegal", "bad_amount", ...) a move the rules didn't allow at that point.

Phantom hands: a preflop decision whose reason names a specific starting hand
("K7o", "J3s") when nothing in the reason matches the two cards the seat held. Seen
in a series on 2026-11-24: an agent chained `poker act ... && poker wait`, its harness
backgrounded the wait, and it went on to fold made-up hands without looking; most
were refused as not its turn, but those that landed on its turn were accepted. To keep
false alarms out it only counts preflop (reasons there are about the seat's own hand,
postflop they name opponents' ranges), only a hand written with s/o (so "22% pot odds"
or "vs TT/99" never count), and nothing at all if any hand or card code in the reason
matches the seat's cards (so "A5s" for an offsuit A5 doesn't count).

Standard library only (ratings.py uses it).
"""

from __future__ import annotations

import re
from collections import Counter

CONDUCT_REVISION = "pokerbench-conduct-v1"
RANKS = "AKQJT98765432"
_HAND = re.compile(r"(?<![A-Za-z0-9])([AKQJT2-9])([AKQJT2-9])([so])?(?![A-Za-z0-9%])")
_CARDS_WORD = re.compile(r"(?:(?:10|[AKQJT2-9])[shdc])+")  # "Kh", "Kh4h"
_CARD = re.compile(r"(?:10|[AKQJT2-9])[shdc]")
EXAMPLES = 5


def counted_decisions(decisions: list[dict], events: list[dict]) -> list[dict]:
    """Decisions that count: a resumed game deals the hand that was in progress again, so
    the decisions made in it before the restart don't (the hand never finished)."""
    resumes = [e for e in events if e.get("type") == "resumed"]
    return [d for d in decisions
            if not any(d.get("hand", 0) >= e["next_hand"] and d["ts"] < e["ts"] for e in resumes)]


def _ranks(cards) -> str:
    return "".join(sorted((c[0] for c in cards), key=RANKS.index))


def phantom_hand(d: dict) -> str | None:
    """The hand a preflop decision's reason names instead of the seat's own, or None."""
    hole, reason = d.get("hole"), d.get("reason") or ""
    if d.get("street") != "preflop" or d.get("timed_out") or not hole or len(hole) != 2 or not reason:
        return None
    own = _ranks(hole)
    named = list(_HAND.finditer(reason))
    if any(_ranks(m.group(1) + m.group(2)) == own for m in named):
        return None
    codes = {c.replace("10", "T") for w in re.findall(r"[A-Za-z0-9]+", reason)
             if _CARDS_WORD.fullmatch(w) for c in _CARD.findall(w)}
    if codes & set(hole):
        return None
    suffixed = [m.group(0) for m in named if m.group(3) and m.group(1) != m.group(2)]
    return suffixed[0] if suffixed else None


def seat_conduct(seat: str, decisions: list[dict], events: list[dict]) -> dict:
    """One seat's invalid moves (by error) and phantom-hand decisions. ``decisions`` are
    the seat's own, already filtered by counted_decisions."""
    invalid = Counter(e.get("error") or "other" for e in events
                      if e.get("type") == "invalid_action" and e.get("seat") == seat)
    phantoms = []
    for d in decisions:
        named = phantom_hand(d)
        if named:
            phantoms.append({"hand": d.get("hand"), "held": "".join(d["hole"]), "named": named,
                             "action": d.get("action"), "reason": (d.get("reason") or "")[:160]})
    preflop = sum(1 for d in decisions if d.get("street") == "preflop" and not d.get("timed_out"))
    return {
        "invalid_actions": sum(invalid.values()),
        "invalid_by_error": dict(invalid.most_common()),
        "preflop_decisions": preflop,
        "phantom_hands": len(phantoms),
        "phantom_examples": phantoms[:EXAMPLES],
    }


def invalid_summary(c: dict) -> str:
    """"78 (77 not your turn, 1 illegal)", or "0"."""
    n = c.get("invalid_actions") or 0
    by = c.get("invalid_by_error") or {}
    if not n or not by:
        return str(n)
    return f"{n} (" + ", ".join(f"{k} {e.replace('_', ' ')}" for e, k in by.items()) + ")"
