# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Direct model seats: the request carries everything the seat observed (and
nothing hidden), illegal answers are retried with the engine's error, and a
full match runs over HTTP against a reference bot. No provider is called."""

import json
import tempfile
import threading
import unittest
from pathlib import Path

from pokerbench.bots import play as play_bot
from pokerbench.cli import Client
from pokerbench.engine import Match, MatchConfig
from pokerbench.llm import SCHEMA, Decision, ProviderError, _parse, build_request, play
from pokerbench.server import make_server, write_tokens


class ScriptedProvider:
    """Calls/checks everything, but answers the first decision with an illegal
    action and one later decision with junk, to exercise the retry paths."""

    name, model, effort = "fake", "fake-1", None

    def __init__(self):
        self.requests: list[tuple[str, list[str]]] = []

    def decide(self, system, blocks):
        self.requests.append((system, blocks))
        n = len(self.requests)
        if n == 1:
            return Decision("raise", 1, "illegal on purpose", {"input": 1})
        if n == 3:
            raise ProviderError("unparseable output")
        now = blocks[-1] if not blocks[-1].startswith("Your previous answer") else blocks[-2]
        action = "check" if "Options: check" in now else "call"
        return Decision(action, None, f"{action} because scripted", {"input": 1})


class LlmSeatTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.match = Match(MatchConfig(seats=("model", "bot"), deals=6, duplicate=False, format="tournament"),
                           d / "run")
        self.tokens = write_tokens(("model", "bot"), d / "tokens")
        self.srv = make_server(self.match, self.tokens, "127.0.0.1", 0)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve, daemon=True).start()
        self.log = d / "llm.jsonl"
        self.run_dir = d / "run"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def test_full_match_with_retries_and_complete_history(self):
        provider = ScriptedProvider()
        bot = threading.Thread(target=play_bot, args=(Client(self.url, self.tokens["bot"]), "tight", 1), daemon=True)
        bot.start()
        final = play(Client(self.url, self.tokens["model"]), provider, log_path=self.log)
        bot.join(timeout=30)
        self.assertEqual(final["match"]["status"], "finished")

        # Retries: the illegal raise was rejected and re-asked with the engine's message.
        second = provider.requests[1][1][-1]
        self.assertTrue(second.startswith("Your previous answer was rejected"))
        self.assertIn("Legal right now", second)
        events = [json.loads(l) for l in (self.run_dir / "events.jsonl").read_text().splitlines()]
        self.assertEqual(sum(e["type"] == "invalid_action" and e["seat"] == "model" for e in events), 1)
        entries = [json.loads(l) for l in self.log.read_text().splitlines()]
        self.assertTrue(any(e.get("rejected") == "bad_amount" for e in entries))  # raise to 1
        self.assertTrue(any(e.get("error") == "unparseable output" for e in entries))

        # History: the last request has one block per finished hand, in order, then the current hand.
        results = self.match.results
        system, blocks = provider.requests[-1]
        hand_blocks = [b for b in blocks if b.startswith("Hand ")]
        self.assertEqual([int(b.split()[1]) for b in hand_blocks], list(range(1, len(hand_blocks) + 1)))
        self.assertGreaterEqual(len(hand_blocks), len(results) - 1)
        self.assertTrue(blocks[-1].startswith("CURRENT HAND") or blocks[-2].startswith("CURRENT HAND"))
        self.assertIn("Your reason", "\n".join(blocks))  # its own earlier reasons
        self.assertNotIn("poker wait", system)  # no shell instructions for a direct seat
        self.assertIn("TOURNAMENT", system)

        # Nothing hidden leaks: the bot's cards appear only for hands that went to showdown.
        everything = "\n".join(t for _, bs in provider.requests for t in bs)
        for r in results:
            bot_cards = " ".join(r["hole"]["bot"])
            if not r["showdown"]:
                self.assertNotIn(f"bot showed: {bot_cards}", everything)

    def test_request_shape(self):
        Client(self.url, self.tokens["model"]).state()
        Client(self.url, self.tokens["bot"]).state()
        seat = self.match.hand.actor
        view = self.match.view(seat)
        system, blocks = build_request(view, [], {})
        self.assertEqual(blocks[0], "No hands have finished yet.")
        self.assertIn("YOUR TURN", blocks[-1])
        self.assertNotIn("Act with:", blocks[-1])

    def test_parse(self):
        self.assertEqual(_parse('{"reason": "r", "action": "raise", "amount": 300}'), ("raise", 300, "r"))
        self.assertEqual(_parse('{"reason": "r", "action": "call", "amount": 0}'), ("call", None, "r"))
        with self.assertRaises(ProviderError):
            _parse("not json")
        with self.assertRaises(ProviderError):
            _parse('{"reason": "r", "action": "shove", "amount": 0}')
        self.assertEqual(SCHEMA["required"], ["reason", "action", "amount"])


if __name__ == "__main__":
    unittest.main()
