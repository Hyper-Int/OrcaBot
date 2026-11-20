# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Siren agent seats: reply parsing and what each turn's message contains.
(The chat itself is exercised end to end against a local Siren hub; see README.)"""

import queue
import unittest

from pokerbench.llm import ProviderError, feed_decision
from pokerbench.siren import SirenProvider, parse_reply


class ParseReplyTests(unittest.TestCase):
    def test_json_anywhere_in_the_reply(self):
        self.assertEqual(parse_reply('{"reason":"top pair","action":"raise","amount":900}'), ("raise", 900, "top pair"))
        self.assertEqual(parse_reply('Sure!\n```json\n{"reason": "draw", "action": "call", "amount": 0}\n```'),
                         ("call", None, "draw"))
        self.assertEqual(parse_reply('{"action": "all-in", "reason": "shove"}'), ("allin", None, "shove"))

    def test_action_line(self):
        self.assertEqual(parse_reply("A raise is right here.\nACTION: raise 600"), ("raise", 600, "A raise is right here."))
        self.assertEqual(parse_reply("ACTION: fold"), ("fold", None, ""))

    def test_no_move(self):
        for text in ("hmm, let me think", "", '{"reason": "no action key"}'):
            with self.assertRaises(ProviderError):
                parse_reply(text)
        with self.assertRaises(ProviderError):
            parse_reply('{"action": "dance"}')
        with self.assertRaises(ProviderError):
            parse_reply('{"action": "bet", "amount": "lots"}')


def provider():
    p = SirenProvider.__new__(SirenProvider)  # no siren-stdio process
    p.introduced, p.last_hand_sent, p.events = False, 0, queue.Queue()
    p.turn, p.turn_limit, p.turn_deadline, p.view, p.updated = 1, 150.0, None, {}, None
    return p


class MessageTests(unittest.TestCase):
    def test_intro_once_then_only_new_hands(self):
        p = provider()
        first = p.message("INTRO", ["No hands have finished yet.", "CURRENT HAND\nHand 1/6 ..."])
        self.assertTrue(first.startswith("INTRO"))
        self.assertIn("CURRENT HAND", first)
        self.assertNotIn("Since your last turn", first)
        p.introduced = True
        second = p.message("INTRO", ["Hand 1 (level 1)\n...", "Hand 2 (level 1)\n...", "CURRENT HAND\nHand 3/6"])
        self.assertNotIn("INTRO", second)
        self.assertIn("Since your last turn", second)
        self.assertIn("Hand 1 (level 1)", second)
        self.assertIn("Hand 2 (level 1)", second)
        # Same hand, next street: nothing new has finished.
        third = p.message("INTRO", ["Hand 1 (level 1)\n...", "Hand 2 (level 1)\n...", "CURRENT HAND\nHand 3/6 flop"])
        self.assertNotIn("Since your last turn", third)
        self.assertTrue(third.startswith("[PokerBench] Turn 1: your move"))
        self.assertIn("CURRENT HAND", third)

    def test_a_rejection_is_passed_on(self):
        p = provider()
        p.introduced = True
        msg = p.message("INTRO", ["CURRENT HAND\n...", "Your previous answer was rejected: bad amount. Choose again."])
        self.assertIn("rejected: bad amount", msg)

    def test_feed_shows_message_sizes(self):
        line = feed_decision({"attempt": 0, "action": "call", "latency_s": 21.5,
                              "usage": {"chars_out": 640, "chars_in": 72}, "reason": "pot odds"})
        self.assertIn("sent 640 chars / got 72", line)


if __name__ == "__main__":
    unittest.main()
