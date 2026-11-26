# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-scoreboard-v1
"""The public scoreboard: ratings.py's numbers over the finished series games, models
only, each series' own bb/100 in the order played."""

import json
import tempfile
import unittest
from pathlib import Path

from pokerbench import ratings as R
from pokerbench.scoreboard import scoreboard, split_entrant

PLAYERS = {"a": {"kind": "codex", "model": "gpt-6.2-astra", "effort": "medium"},
           "b": {"kind": "claude-code", "model": "claude-haiku-5-5", "effort": "medium"}}


def write_game(root, name, series, game, deals, edge, status="finished", started="2026-01-01T00:00:00Z", **cfg):
    """A heads-up series game: seat a wins ``edge`` chips a hand on every deal."""
    d = Path(root) / name
    d.mkdir(parents=True)
    config = {"format": "cash", "betting": "no-limit", "big_blind": 100, "seats": ["a", "b"],
              "series": series, "series_game": game, "series_games": 2, "rotation": game, "seed": 7, **cfg}
    (d / "run.json").write_text(json.dumps({"status": status, "started_at": started, "config": config,
                                            "players": PLAYERS}))
    (d / "hand_results.jsonl").write_text("".join(
        json.dumps({"hand": i + 1, "deal": i, "net": {"a": edge, "b": -edge}, "blinds": [50, 100]}) + "\n"
        for i in range(deals)))
    return d


class ScoreboardTests(unittest.TestCase):
    def test_matches_the_ratings_over_the_same_games(self):
        with tempfile.TemporaryDirectory() as d:
            write_game(d, "g1", "series-1", 0, 10, 50, started="2026-01-01T00:00:00Z")
            write_game(d, "g2", "series-1", 1, 10, 30, started="2026-01-02T00:00:00Z")
            write_game(d, "g3", "series-2", 0, 10, -20, started="2026-01-03T00:00:00Z")
            write_game(d, "g4", "series-2", 1, 10, 0, status="running", started="2026-01-04T00:00:00Z")
            write_game(d, "t1", "", 0, 10, 99)                      # not a series game
            write_game(d, "lim", "series-9", 0, 10, 99, betting="limit")  # another benchmark
            write_game(d, "abandoned/g0", "series-1", 0, 10, 99)    # set aside

            b = scoreboard(d, n_boot=50, now=1_800_000_000)
            self.assertEqual((b["games"], b["hands"]), (3, 30))
            self.assertEqual(b["series"], [{"games": 2, "of": 2}, {"games": 1, "of": 2}])
            self.assertEqual(b["as_of"], "2027-01-15T08:00:00Z")
            astra, haiku = b["models"]
            self.assertEqual((astra["model"], astra["effort"]), ("gpt-6.2-astra", "medium"))
            self.assertEqual(haiku["model"], "claude-haiku-5-5")
            # Each series' own bb/100, in the order played: (50+30)/2 = +40 bb/100, then -20.
            self.assertEqual(astra["series"], [40.0, -20.0])
            self.assertEqual(haiku["series"], [-40.0, 20.0])
            # ratings.py over the same three games gives the same numbers.
            games = [R.load_game(Path(d) / g) for g in ("g1", "g2", "g3")]
            ref = R.compute_ratings(games, n_boot=50)["variants"]["no-limit/cash"]["win_rates"]
            self.assertEqual([(r["bb_per_100"], r["ci95"]) for r in ref],
                             [(m["bb_per_100"], m["ci95"]) for m in b["models"]])
            # Models only: no agent (harness) or seat names leave the VM.
            text = json.dumps(b)
            for private in ("codex", "claude-code", '"a"', '"b"'):
                self.assertNotIn(private, text)

    def test_nothing_yet(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(scoreboard(d))
            self.assertIsNone(scoreboard(Path(d) / "missing"))

    def test_split_entrant(self):
        self.assertEqual(split_entrant("codex / gpt-6.2-astra / medium"), ("gpt-6.2-astra", "medium"))
        self.assertEqual(split_entrant("antigravity-cli / Gemini 4 Neon / high"), ("Gemini 4 Neon", "high"))
        self.assertEqual(split_entrant("claude-code / claude-opus-5-5 / unknown"), ("claude-opus-5-5", None))
        self.assertEqual(split_entrant("odd"), ("odd", None))


if __name__ == "__main__":
    unittest.main()
