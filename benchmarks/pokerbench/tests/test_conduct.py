# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-conduct-v1
"""Conduct: invalid moves by error, and preflop decisions on a hand the seat didn't
hold, per game (report) and per entrant across games (ratings). The phantom cases are
real reasons from a 2026-11-24 series; the false-alarm guards are real reasons too."""

import json
import tempfile
import unittest
from pathlib import Path

from pokerbench import ratings as R
from pokerbench.conduct import counted_decisions, invalid_summary, phantom_hand, seat_conduct


def dec(hole, reason, street="preflop", seat="hydrogen", hand=1, action="fold", ts="2026-11-24T10:00:00Z", **kw):
    return {"seat": seat, "hand": hand, "street": street, "hole": hole, "reason": reason,
            "action": action, "timed_out": False, "ts": ts, **kw}


class PhantomHandTests(unittest.TestCase):
    def test_a_made_up_hand_is_caught(self):
        self.assertEqual(phantom_hand(dec(["4h", "Kh"], "94o in LJ is an easy fold")), "94o")
        self.assertEqual(phantom_hand(dec(["Qd", "Kc"], "96o is trash from the hijack.")), "96o")
        self.assertEqual(phantom_hand(dec(["Ad", "Td"], "Folding 96s in early position UTG+2.")), "96s")

    def test_its_own_hand_is_not(self):
        self.assertIsNone(phantom_hand(dec(["7c", "Kd"], "K7o is too weak against an early open")))
        self.assertIsNone(phantom_hand(dec(["Kd", "7c"], "K7 offsuit, fold")))
        # Ranks right, suited/offsuit wrong: a slip, not an imagined hand.
        self.assertIsNone(phantom_hand(dec(["Ac", "5s"], "3-bet bluff with A5s, blocking aces", action="raise")))
        # Its cards by code, while naming an opponent's range.
        self.assertIsNone(phantom_hand(dec(["Kh", "4h"], "Kh4h is behind a range like AJo+ here")))

    def test_ranges_and_numbers_are_not_hands(self):
        self.assertIsNone(phantom_hand(dec(["As", "Jd"], "Pot odds are about 22% and top pair is ahead", action="call")))
        self.assertIsNone(phantom_hand(dec(["Js", "Kh"], "thin value vs TT/99 after two checks")))
        self.assertIsNone(phantom_hand(dec(["9s", "9h"], "fold 33 here", street="preflop")))

    def test_only_preflop(self):
        self.assertIsNone(phantom_hand(dec(["Tc", "9h"], "Call against AKo and AQo", street="turn", action="call")))

    def test_timed_out_or_no_reason(self):
        self.assertIsNone(phantom_hand({**dec(["4h", "Kh"], "94o fold"), "timed_out": True}))
        self.assertIsNone(phantom_hand(dec(["4h", "Kh"], "")))


class SeatConductTests(unittest.TestCase):
    def test_counts_by_error_and_phantoms(self):
        events = [{"type": "invalid_action", "seat": "hydrogen", "error": "not_your_turn"}] * 3 + [
            {"type": "invalid_action", "seat": "hydrogen", "error": "illegal"},
            {"type": "invalid_action", "seat": "neon", "error": "not_your_turn"}]
        ds = [dec(["4h", "Kh"], "94o in LJ is an easy fold", hand=27), dec(["Ah", "Ad"], "AA, raise", hand=28)]
        c = seat_conduct("hydrogen", ds, events)
        self.assertEqual(c["invalid_actions"], 4)
        self.assertEqual(c["invalid_by_error"], {"not_your_turn": 3, "illegal": 1})
        self.assertEqual(c["preflop_decisions"], 2)
        self.assertEqual(c["phantom_hands"], 1)
        self.assertEqual(c["phantom_examples"][0]["held"], "4hKh")
        self.assertEqual(c["phantom_examples"][0]["named"], "94o")
        self.assertEqual(invalid_summary(c), "4 (3 not your turn, 1 illegal)")
        self.assertEqual(invalid_summary(seat_conduct("argon", [], events)), "0")

    def test_decisions_in_a_hand_dealt_again_do_not_count(self):
        events = [{"type": "resumed", "next_hand": 5, "ts": "2026-11-24T10:05:00Z"}]
        ds = [dec(["4h", "Kh"], "94o", hand=5, ts="2026-11-24T10:04:00Z"),
              dec(["4h", "Kh"], "94o", hand=5, ts="2026-11-24T10:06:00Z"),
              dec(["4h", "Kh"], "94o", hand=4, ts="2026-11-24T10:03:00Z")]
        self.assertEqual([d["ts"][11:16] for d in counted_decisions(ds, events)], ["10:06", "10:03"])


class RatingsConductTests(unittest.TestCase):
    def test_totals_per_entrant_across_games_in_the_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            for gid, n_invalid in (("g1", 2), ("g2", 3)):
                d = Path(tmp) / gid
                d.mkdir()
                (d / "run.json").write_text(json.dumps({
                    "config": {"seats": ["hydrogen", "neon"], "format": "cash", "big_blind": 100},
                    "status": "finished", "players": {"hydrogen": {"kind": "house"}, "neon": {"kind": "house"}}}))
                (d / "hand_results.jsonl").write_text(
                    json.dumps({"hand": 1, "deal": 1, "net": {"hydrogen": -50, "neon": 50}}) + "\n")
                (d / "events.jsonl").write_text("".join(
                    json.dumps({"type": "invalid_action", "seat": "hydrogen", "error": "not_your_turn"}) + "\n"
                    for _ in range(n_invalid)))
                (d / "decisions.jsonl").write_text("\n".join(json.dumps(x) for x in [
                    dec(["4h", "Kh"], "94o in LJ is an easy fold"),
                    dec(["Ah", "Kd"], "AKo, raise", seat="neon", action="raise")]) + "\n")
            names = {f"{g}/{s}": f"agy / {s}" for g in ("g1", "g2") for s in ("hydrogen", "neon")}
            games = [R.load_game(Path(tmp) / g, names) for g in ("g1", "g2")]
            result = R.compute_ratings(games, n_boot=20)
            rows = result["variants"]["no-limit/cash"]["conduct"]
            hy = next(r for r in rows if r["entrant"] == "agy / hydrogen")
            ne = next(r for r in rows if r["entrant"] == "agy / neon")
            self.assertEqual((ne["invalid_actions"], ne["phantom_hands"]), (0, 0))
            self.assertEqual((hy["games"], hy["decisions"], hy["invalid_actions"], hy["not_your_turn"],
                              hy["phantom_hands"], hy["preflop_decisions"]), (2, 2, 5, 5, 2, 2))
            md = R.render_markdown(result)
            self.assertIn("### Conduct (not part of any rating)", md)


if __name__ == "__main__":
    unittest.main()


class SeriesNameTests(unittest.TestCase):
    def test_a_seat_named_differently_in_one_game_of_a_series_is_one_row(self):
        series = {"id": "s1", "game": 0, "games": 3, "rotation": 0, "seed": 7}
        games = []
        for i, effort in enumerate(("unknown", "medium", "unknown")):
            g = R.Game(id=f"g{i}", format="cash", betting="no-limit", started_at=f"2026-01-0{i + 1}",
                       status="finished", finish_reason="completed", big_blind=100,
                       entrants={"astra": f"codex / astra / {effort}"},
                       hands=[{"deal": 1, "net": {"astra": 0}, "bb": 100}], series={**series, "game": i})
            g.conduct = {"astra": {"decisions": 10, "invalid_actions": 1, "invalid_by_error": {"illegal": 1},
                                   "preflop_decisions": 5, "phantom_hands": 0}}
            games.append(g)
        rows = R.conduct_totals(games)
        self.assertEqual([(r["entrant"], r["games"], r["invalid_actions"]) for r in rows],
                         [("codex / astra / unknown", 3, 3)])
