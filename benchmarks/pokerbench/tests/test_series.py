# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-engine-v23-series-in-spectate
"""A series: consecutive cash games with the same seed, game k seating every deal rotated
by k, so across the series each player plays every deal from every seat exactly once and
never sees a deal twice (duplicate across games instead of replays at one table, which an
agent with a memory could recognise)."""

import json
import os
import subprocess
import tempfile
import unittest
from collections import defaultdict
from dataclasses import replace
from pathlib import Path

from pokerbench.engine import Match, MatchConfig, deck_for_deal, schedule

ROOT = Path(__file__).resolve().parents[1]


def series_cfg(seats, k, deals=4):
    return MatchConfig(seats=tuple(seats), deals=deals, seed=7, duplicate=False, rotation=k,
                       series="s1", series_game=k, series_games=len(seats), format="cash")


class SpectateTests(unittest.TestCase):
    def test_the_public_view_says_which_game_of_the_series(self):
        with tempfile.TemporaryDirectory() as d:
            m = Match(series_cfg(("a", "b", "c"), 2), Path(d) / "run")
            self.assertEqual(m.spectate()["series"], {"id": "s1", "game": 2, "games": 3})
            single = Match(MatchConfig(seats=("a", "b"), deals=2), Path(d) / "run2")
            self.assertNotIn("series", single.spectate())


class ScheduleTests(unittest.TestCase):
    def test_every_player_plays_every_deal_from_every_seat_once(self):
        for seats in (("a", "b"), ("a", "b", "c"), ("a", "b", "c", "d", "e", "f")):
            seen = defaultdict(set)  # (deal, player) -> positions
            for k in range(len(seats)):
                plans = schedule(series_cfg(seats, k))
                self.assertEqual(len(plans), 4, "no replays at the table")
                for p in plans:
                    self.assertFalse(p.mirror)
                    for pos, player in enumerate(p.players):
                        seen[(p.deal, player)].add(pos)
            for (deal, player), positions in seen.items():
                self.assertEqual(positions, set(range(len(seats))), (seats, deal, player))

    def test_same_cards_every_game(self):
        # The deck depends on (seed, deal) only, so game k deals game 0's cards.
        self.assertEqual(deck_for_deal(7, 3), deck_for_deal(7, 3))

    def test_a_series_is_cash_without_replays(self):
        with self.assertRaises(ValueError):
            MatchConfig(seats=("a", "b"), series="s", duplicate=True, format="cash")
        with self.assertRaises(ValueError):
            MatchConfig(seats=("a", "b"), series="s", duplicate=False, format="tournament")


class SeatOrderTests(unittest.TestCase):
    def test_later_games_keep_the_first_games_order(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = replace(series_cfg(("c", "a", "b"), 1), start="manual",
                          seat_order=("b", "c", "a"))
            m = Match(cfg, Path(d) / "run")
            for s in ("a", "b", "c"):
                m.join(s)
            m.start_game()
            self.assertEqual(m.cfg.seats, ("b", "c", "a"))
            self.assertEqual(json.loads((Path(d) / "run" / "run.json").read_text())["config"]["seat_order"],
                             ["b", "c", "a"])


class StateTests(unittest.TestCase):
    def state(self, path, *args):
        src = (ROOT / "bin" / "table-engine").read_text()
        start = src.index("state() { python3")
        fn = src[start:src.index("\nPY\n}", start) + 5]
        r = subprocess.run(["bash", "-c", f'STATE={path}\n{fn}\nstate "$@"', "x", *args],
                           capture_output=True, text=True, env={"PATH": os.environ["PATH"]})
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_series_bookkeeping(self):
        with tempfile.TemporaryDirectory() as d:
            st, run = Path(d) / "series.json", Path(d) / "run.json"
            self.state(st, "set", "id=series-1", "games=3", "next=0", "seed=42")
            run.write_text(json.dumps({"finish_reason": "deals_done", "config": {
                "seed": 99, "deals": 50, "condition": "fair", "honeypots": "obvious", "turn_timeout": 300.0,
                "seats": ["neon", "sonnet", "astra"]}}))
            self.assertEqual(self.state(st, "from-run", str(run)).strip(), "deals_done")
            got = self.state(st, "get")
            for want in ("S_ID=series-1", "S_NEXT=0", "S_SEED=99", "S_DEALS=50", "S_CONDITION=fair",
                         "S_SEAT_ORDER=neon,sonnet,astra"):
                self.assertIn(want, got)
            self.state(st, "set", "next=3")
            self.assertEqual(self.state(st, "get").strip(), "", "a finished series isn't carried on")


if __name__ == "__main__":
    unittest.main()
