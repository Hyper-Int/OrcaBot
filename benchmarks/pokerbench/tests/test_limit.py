# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-engine-v20-limit
"""Limit hold'em (betting="limit"): bets and raises of a fixed size, the small bet (the
big blind) preflop and on the flop, the big bet (twice that) on the turn and river, at
most 4 a street. A separate game from no-limit, rated separately."""

import json
import tempfile
import unittest
from pathlib import Path

from pokerbench.cli import rules_text
from pokerbench.engine import ActionError, Match, MatchConfig
from pokerbench.main import prompt_text

import sys
sys.path.insert(0, str(Path(__file__).parent))
from test_engine import play_out  # noqa: E402


def limit_match(tmp, seats=("alice", "bob"), **kw):
    return Match(MatchConfig(seats=seats, require_join=False, betting="limit", deals=30, seed=3, **kw), Path(tmp))


class LimitTests(unittest.TestCase):
    def test_raises_are_one_fixed_size(self):
        with tempfile.TemporaryDirectory() as d:
            m = limit_match(d)
            seat = m.hand.actor
            legal = m.view(seat)["legal"]
            kind = "raise" if "raise" in legal else "bet"
            self.assertEqual(legal[kind]["min"], legal[kind]["max"], legal)  # one size
            self.assertEqual(legal[kind]["min"], 200)  # preflop: big blind 100, raise to 200
            with self.assertRaises(ActionError):
                m.act(seat, kind, 500, "too big")
            m.act(seat, kind, None, "no amount needed in limit")  # the fixed size

    def test_four_bets_a_street_and_bigger_bets_later(self):
        with tempfile.TemporaryDirectory() as d:
            m = limit_match(d)
            raises = 0
            while True:  # keep raising preflop until the cap
                seat = m.hand.actor
                legal = m.view(seat)["legal"]
                if "raise" not in legal:
                    break
                m.act(seat, "raise", None, "raise")
                raises += 1
            # PokerKit's cap: 4 bets/raises a street by the players (the blind isn't one).
            self.assertEqual(raises, 4)
            m.act(m.hand.actor, "call", None, "call")
            # Flop: the small bet. Then turn and river: the big bet.
            sizes = []
            while m.hand and m.hand.number == 1 and m.status == "running":
                seat = m.hand.actor
                legal = m.view(seat)["legal"]
                if "bet" in legal:
                    sizes.append(legal["bet"]["min"])
                    m.act(seat, "bet", None, "bet")
                    m.act(m.hand.actor, "call", None, "call")
                else:
                    m.act(seat, "check" if "check" in legal else "call", None, "x")
            self.assertEqual(sizes, [100, 200, 200])

    def test_a_whole_limit_game_with_bots(self):
        with tempfile.TemporaryDirectory() as d:
            m = limit_match(d, seats=("a", "b", "c"), duplicate=False)
            play_out(m, ("random", "tight", "call"))
            self.assertEqual(m.status, "finished")
            results = [json.loads(x) for x in (Path(d) / "hand_results.jsonl").read_text().splitlines()]
            self.assertEqual(sum(sum(r["net"].values()) for r in results), 0)
            self.assertEqual(json.loads((Path(d) / "run.json").read_text())["config"]["betting"], "limit")

    def test_settings_rules_and_prompt_say_limit(self):
        with tempfile.TemporaryDirectory() as d:
            m = Match(MatchConfig(seats=("a", "b"), start="manual"), Path(d))
            self.assertEqual(m.settings()["betting"], "no-limit")
            self.assertEqual(m.configure({"betting": "limit"})["betting"], "limit")
            with self.assertRaises(ActionError):
                m.configure({"betting": "pot-limit"})
            info = m.view("a")["match"]
            self.assertEqual(info["betting"], "limit")
            text = rules_text(info)
            self.assertIn("heads-up limit Texas hold'em", text)
            self.assertIn("LIMIT betting", text)
        self.assertIn("6-player limit Texas hold'em", prompt_text("fair", 6, "cash", "limit"))
        self.assertIn("no-limit", prompt_text("fair", 6, "cash"))


if __name__ == "__main__":
    unittest.main()
