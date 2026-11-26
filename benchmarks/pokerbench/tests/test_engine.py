# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Engine tests: rules, duplicate deals, timeouts, and that no view leaks hidden cards.

Run: python -m unittest discover -s benchmarks/pokerbench/tests
"""

import json
import random
import tempfile
import unittest
from pathlib import Path

from pokerbench.bots import STRATEGIES
from pokerbench.engine import ActionError, Match, MatchConfig, deck_for_deal, public_result


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def make_match(tmp, **kw):
    cfg = MatchConfig(seats=("alice", "bob"), require_join=False, **kw)
    return Match(cfg, Path(tmp))


def play_out(match, strategies=("random", "random"), seed=0, observe=None):
    """Drive a match to the end through the public seat API (no HTTP)."""
    rngs = {s: random.Random(seed + i) for i, s in enumerate(match.cfg.seats)}
    strat = dict(zip(match.cfg.seats, strategies))
    while match.status == "running":
        seat = match.hand.actor
        if observe:
            observe(match)
        view = match.view(seat)
        action, amount, reason = STRATEGIES[strat[seat]](view, rngs[seat])
        match.act(seat, action, amount, reason)


class DuplicateDealTests(unittest.TestCase):
    def test_mirror_hands_swap_the_same_cards(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = make_match(tmp, deals=6, seed=42)
            play_out(m, ("call", "call"))
            self.assertEqual(len(m.results), 12)
            by_deal = {}
            for r in m.results:
                by_deal.setdefault(r["deal"], []).append(r)
            for deal, (first, mirror) in by_deal.items():
                self.assertFalse(first["mirror"])
                self.assertTrue(mirror["mirror"])
                self.assertEqual(first["board"], mirror["board"])
                a, b = first["players"]
                self.assertEqual(mirror["players"], [b, a])
                # The same cards go to the same position; the seat holding them swaps.
                self.assertEqual(first["hole"][a], mirror["hole"][b])
                self.assertEqual(first["hole"][b], mirror["hole"][a])

    def test_calling_stations_break_even_over_duplicate_pairs(self):
        # Identical strategies on mirrored deals must net exactly zero per pair.
        with tempfile.TemporaryDirectory() as tmp:
            m = make_match(tmp, deals=10, seed=7)
            play_out(m, ("call", "call"))
            board = {row["seat"]: row for row in m.final_results()["leaderboard"]}
            self.assertEqual(board["alice"]["net_chips"], 0)
            self.assertEqual(board["alice"]["dup_bb_per_100"], 0)

    def test_seed_is_reproducible(self):
        self.assertEqual(deck_for_deal(3, 5), deck_for_deal(3, 5))
        self.assertNotEqual(deck_for_deal(3, 5), deck_for_deal(4, 5))
        self.assertNotEqual(deck_for_deal(3, 5), deck_for_deal(3, 6))

    def test_positions_alternate_between_deals(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = make_match(tmp, deals=2)
            firsts = [p.players for p in m.plans if not p.mirror]
            self.assertNotEqual(firsts[0], firsts[1])


class LeakTests(unittest.TestCase):
    """A seat must never see the opponent's live hole cards; spectators never see live hole cards."""

    def _assert_absent(self, cards, payload, what):
        text = json.dumps(payload)
        for c in cards:
            self.assertNotIn(f'"{c}"', text, f"{what} leaked {c}")

    def test_views_never_contain_hidden_cards(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = make_match(tmp, deals=40, seed=1)

            def observe(match):
                hand = match.hand
                board = set(hand.board())
                for seat in match.cfg.seats:
                    opp = next(s for s in match.cfg.seats if s != seat)
                    hidden = set(hand.hole(opp)) - board - set(hand.hole(seat))
                    view = match.view(seat)
                    prev = view.pop("previous_hand", None)
                    self._assert_absent(hidden, view, f"view({seat})")
                    if prev is not None and not prev["showdown"]:
                        prev_opp = next(s for s in prev["players"] if s != seat)
                        self.assertIsNone(prev["hole"][prev_opp])
                live_hidden = (set(hand.hole("alice")) | set(hand.hole("bob"))) - board
                spec = match.spectate()
                spec.pop("last_hand", None)  # finished hands are revealed by design
                self._assert_absent(live_hidden, spec, "spectate")

            play_out(m, ("random", "tight"), observe=observe)

    def test_public_result_hides_folded_cards(self):
        r = {"players": ["a", "b"], "showdown": False, "hole": {"a": ["As", "Ks"], "b": ["2c", "7d"]}}
        self.assertEqual(public_result(r, "a")["hole"], {"a": ["As", "Ks"], "b": None})
        r["showdown"] = True
        self.assertEqual(public_result(r, "a")["hole"]["b"], ["2c", "7d"])


class RuleTests(unittest.TestCase):
    def test_illegal_actions_are_rejected_and_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = make_match(tmp, deals=1)
            actor = m.hand.actor  # button, facing the big blind
            other = next(s for s in m.cfg.seats if s != actor)
            with self.assertRaises(ActionError) as e:
                m.act(other, "call")
            self.assertEqual(e.exception.code, "not_your_turn")
            with self.assertRaises(ActionError) as e:
                m.act(actor, "check")
            self.assertEqual(e.exception.code, "illegal")
            with self.assertRaises(ActionError) as e:
                m.act(actor, "raise", 10**9)
            self.assertEqual(e.exception.code, "bad_amount")
            with self.assertRaises(ActionError) as e:
                m.act(actor, "raise")
            self.assertEqual(e.exception.code, "missing_amount")
            self.assertEqual(m.counters[actor]["invalid"], 3)
            m.act(actor, "call")  # complete the small blind
            # Big blind may now check; folding for free is not offered.
            self.assertNotIn("fold", m.view(other)["legal"])
            with self.assertRaises(ActionError):
                m.act(other, "fold")

    def test_raise_amounts_are_street_totals_and_allin_works(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = make_match(tmp, deals=1)
            a = m.hand.actor
            b = next(s for s in m.cfg.seats if s != a)
            m.act(a, "raise", 300)
            self.assertEqual(m.hand.bet(a), 300)
            resp = m.act(b, "allin")
            self.assertTrue(resp["applied"]["allin"])
            m.act(a, "call")
            # All-in and called preflop: the board runs out and the hand ends.
            self.assertEqual(len(m.results), 1)
            r = m.results[0]
            self.assertEqual(len(r["board"]), 5)
            self.assertEqual(r["net"][a], -r["net"][b])
            self.assertIn(abs(r["net"][a]), (0, 10_000))

    def test_timeout_checks_when_free_else_folds(self):
        with tempfile.TemporaryDirectory() as tmp:
            clock = FakeClock()
            cfg = MatchConfig(seats=("alice", "bob"), deals=1, turn_timeout=10, require_join=False)
            m = Match(cfg, Path(tmp), clock=clock)
            actor = m.hand.actor
            clock.t += 9
            m.tick()
            self.assertEqual(m.hand.actor, actor)  # not yet
            clock.t += 2
            m.tick()  # facing the big blind -> fold
            self.assertEqual(m.results[0]["actions"][0], {"seat": actor, "street": "preflop", "action": "fold"})
            decisions = [json.loads(l) for l in (Path(tmp) / "decisions.jsonl").read_text().splitlines()]
            self.assertTrue(decisions[0]["timed_out"])
            self.assertEqual(m.counters[actor]["timeouts"], 1)

    def test_join_wait_holds_the_first_hand(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = Match(MatchConfig(seats=("alice", "bob"), deals=1), Path(tmp))
            self.assertEqual(m.status, "waiting_for_players")
            self.assertIsNone(m.hand)
            m.join("alice")
            self.assertEqual(m.view("alice")["waiting_for"], ["bob"])
            m.join("bob")
            self.assertEqual(m.status, "running")
            self.assertIsNotNone(m.hand)

    def test_run_files_are_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = make_match(tmp, deals=2)
            play_out(m, ("tight", "random"))
            d = Path(tmp)
            for name in ("run.json", "results.json", "decisions.jsonl", "events.jsonl", "hand_results.jsonl"):
                self.assertTrue((d / name).exists(), name)
            self.assertEqual(len(list((d / "hands").glob("*.phh"))), 4)
            self.assertIn("players = ['", (d / "hands" / "hand-00001.phh").read_text())


if __name__ == "__main__":
    unittest.main()
