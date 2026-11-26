# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Seats as canvas components: self-reported labels and the model seat's live feed."""

import json
import tempfile
import unittest
from pathlib import Path

from pokerbench.engine import Match, MatchConfig
from pokerbench.llm import feed_decision, feed_situation
from pokerbench.report import build
from test_engine import play_out


class SeatInfoTests(unittest.TestCase):
    def test_seats_report_labels_and_config_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = Match(MatchConfig(seats=("a", "b", "c"), deals=4, seat_info=(("c", "acme/configured"),)), Path(tmp))
            m.join("a", "anthropic/claude-code (claude-sonnet-5-5)")
            m.join("a", "openai/impostor")  # only the first report counts
            m.join("b", "google/gemini-3.8-flash (API)<script>")  # markup is stripped
            m.join("c", "acme/self-reported")
            self.assertEqual(m.status, "running")
            labels = m.spectate()["labels"]
            self.assertEqual(labels["a"], "anthropic/claude-code (claude-sonnet-5-5)")
            self.assertEqual(labels["b"], "google/gemini-3.8-flash (API)script")
            self.assertEqual(labels["c"], "acme/configured")
            play_out(m, ("call", "tight", "random"))
            run = json.loads((Path(tmp) / "run.json").read_text())
            self.assertEqual(run["reported_seat_info"]["a"], "anthropic/claude-code (claude-sonnet-5-5)")
            rep = build(Path(tmp))
            self.assertEqual(rep["seats"]["a"]["label"], "anthropic/claude-code (claude-sonnet-5-5)")
            self.assertEqual(rep["seats"]["c"]["label"], "acme/configured")
            events = [json.loads(x) for x in (Path(tmp) / "events.jsonl").read_text().splitlines()]
            self.assertEqual(sum(e["type"] == "seat_info" for e in events), 3)

    def test_join_without_info_still_works(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = Match(MatchConfig(seats=("a", "b"), deals=2), Path(tmp))
            m.join("a")
            m.join("b", "")
            self.assertEqual(m.status, "running")
            self.assertEqual(m.spectate()["labels"], {})


class FeedTests(unittest.TestCase):
    def test_situation_and_decision_lines(self):
        view = {"match": {"hand": 7, "blinds": [75, 150]}, "street": "flop", "board": ["Ah", "7c", "2d"],
                "pot": 600, "you": {"position": "BTN", "hole": ["As", "Kd"], "stack": 9100}}
        line = feed_situation(view)
        for part in ("#7 flop", "blinds 75/150", "BTN", "[As Kd]", "board Ah 7c 2d", "pot 600", "stack 9100"):
            self.assertIn(part, line)
        ok = feed_decision({"attempt": 0, "action": "raise", "amount": 900, "latency_s": 4.2,
                            "usage": {"input": 1200, "output": 80}, "reason": "top pair, top kicker"})
        self.assertIn("raise 900", ok)
        self.assertIn("4.2s, 1200 in / 80 out", ok)
        self.assertIn('"top pair, top kicker"', ok)
        self.assertIn("call", feed_decision({"attempt": 0, "action": "call", "amount": 0, "usage": {}}))
        err = feed_decision({"attempt": 1, "error": "APIConnectionError: refused", "latency_s": 0.1})
        self.assertIn("try 2 failed", err)
        auto = feed_decision({"auto_action": "fold", "last_error": None})
        self.assertIn("fold [auto", auto)

    def test_rejected_answer_is_shown(self):
        line = feed_decision({"attempt": 0, "action": "bet", "amount": 5, "latency_s": 1, "usage": {},
                              "reason": "min bet", "rejected": "bad_amount"})
        self.assertIn("REJECTED: bad_amount", line)


if __name__ == "__main__":
    unittest.main()
