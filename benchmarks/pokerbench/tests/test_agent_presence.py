# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-chatseat-v6-present-check-in
"""Agent (chat) seats: a late answer brings a sat-out agent back; before the start the
seat waits for its agent to answer "ready" and tells the table page meanwhile.

From the 2026-11-20 game: Muse, sat out after a run of misses, answers in about 70s,
so on the 30s sit-out clock it could never get its time back; Dots never answered at
all, and nothing said so until the game was hours in."""

import json
import queue
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

from pokerbench import bots, chatseat, cli, llm
from pokerbench.chatseat import ChatSeat
from pokerbench.engine import Match, MatchConfig
from pokerbench.server import make_server


class QueueAgent(ChatSeat):
    """An agent reached through an in-memory chat. answer(turn) -> seconds until it
    answers that turn, or None for no answer."""

    def __init__(self, answer):
        super().__init__("orca:o/agent:muse", reply_timeout=60)
        self.answer = answer
        self.inbox: queue.Queue = queue.Queue()
        self.posts: list[str] = []

    def _post(self, text):
        self.posts.append(text)
        if not text.startswith("[PokerBench] Your owner has seated you") and "your move" not in text:
            return  # updates need no reply
        turn = self.turn
        delay = self.answer(turn) if "your move" in text else self.answer(0)
        if delay is None:
            return
        legal = (self.view or {}).get("legal") or {}
        move = "check" if "check" in legal else "call" if "call" in legal else "fold"
        reply = json.dumps({"turn": turn, "reason": "test", "action": move, "amount": 0}) if turn else "ready"
        threading.Timer(delay, self.inbox.put, args=(reply,)).start()

    def _replies(self, deadline):
        while (left := deadline - time.monotonic()) > 0:
            try:
                yield self.inbox.get(timeout=left)
            except queue.Empty:
                return

    def _pending(self):
        out = []
        while True:
            try:
                out.append(self.inbox.get_nowait())
            except queue.Empty:
                return out


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class PresentTests(unittest.TestCase):
    def test_engine_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = Match(MatchConfig(seats=("a", "b"), deals=4, sit_out_after=2, require_join=False), Path(tmp) / "run")
            actor = m.hand.actor
            other = "b" if actor == "a" else "a"
            self.assertEqual(m.present(other), {"ok": True, "back": False, "sitting_out": False})
            m.missed[actor] = m.missed[other] = 2
            # Not its turn: back at once.
            self.assertTrue(m.present(other)["back"])
            self.assertFalse(m.sitting_out(other))
            # Its own turn is running: that turn keeps its short clock, but running out
            # isn't a miss, and the next turn has the full time.
            self.assertTrue(m.present(actor).get("from_next_turn"))
            self.assertTrue(m.sitting_out(actor))
            m.clock = lambda: time.monotonic() + 10_000  # let the turn's clock run out
            m.tick()
            self.assertFalse(m.sitting_out(actor))
            self.assertEqual(m.missed[actor], 0)
            events = [json.loads(line) for line in (Path(tmp) / "run" / "events.jsonl").read_text().splitlines()]
            self.assertTrue([e for e in events if e["type"] == "back_in" and e.get("via") == "present"])

    def test_a_late_answer_gives_a_sat_out_agent_its_time_back(self):
        chatseat.DRAIN_EVERY_S = 0.0  # look for late answers on every table change
        tmp = tempfile.TemporaryDirectory()
        try:
            port = _free_port()
            m = Match(MatchConfig(seats=("a", "b"), deals=40, turn_timeout=9, sit_out_after=1,
                                  sit_out_timeout=5, require_join=False), Path(tmp.name) / "run")
            srv = make_server(m, {"a": "ta", "b": "tb"}, port=port)
            threading.Thread(target=srv.serve, daemon=True).start()
            url = f"http://127.0.0.1:{port}"
            # Turn 1: away. Then answers after 4s: late on the 5s sit-out clock (the seat
            # gives up 2s early), in time on the full 9s one.
            agent = QueueAgent(lambda turn: None if turn <= 1 else 4.0)
            threading.Thread(target=llm.play, args=(cli.Client(url=url, token="ta"), agent),
                             kwargs={"max_wait": 2}, daemon=True).start()
            threading.Thread(target=bots.play, args=(cli.Client(url=url, token="tb"), "tight"),
                             kwargs={"max_wait": 2}, daemon=True).start()
            events = Path(tmp.name) / "run" / "events.jsonl"
            decisions = Path(tmp.name) / "run" / "decisions.jsonl"

            def own_move_after_back():
                if not events.exists() or not decisions.exists():
                    return False
                ev = [json.loads(line) for line in events.read_text().splitlines()]
                back = [e["ts"] for e in ev if e["type"] == "back_in" and e.get("via") == "present"]
                ds = [json.loads(line) for line in decisions.read_text().splitlines()]
                return bool(back) and any(d["seat"] == "a" and not d["timed_out"] and d["ts"] >= back[0] for d in ds)

            until = time.monotonic() + 60
            while time.monotonic() < until and not own_move_after_back():
                time.sleep(0.2)
            self.assertTrue(own_move_after_back(),
                            "a late answer should bring the agent back, and it then plays its turns in time")
            srv.shutdown()
        finally:
            chatseat.DRAIN_EVERY_S = 15.0
            tmp.cleanup()


class FakeTable:
    """The seat's engine client before the start: setup() and report_status()."""

    def __init__(self, status="waiting_for_players", in_game=True):
        self.status, self.in_game = status, in_game
        self.reports: list[tuple[str, str]] = []

    def setup(self):
        return {"status": self.status, "in_game": self.in_game}

    def report_status(self, state, message):
        self.reports.append((state, message))


class CheckInTests(unittest.TestCase):
    def test_takes_the_seat_once_the_agent_answers(self):
        agent = QueueAgent(lambda turn: 0.3)
        table = FakeTable()
        self.assertTrue(agent.check_in(table, poll=0.2))
        self.assertTrue(agent.posts[0].startswith("[PokerBench] Your owner has seated you"))
        self.assertEqual(table.reports[0][0], "checking")
        self.assertIn('reply "ready"', table.reports[0][1])
        self.assertFalse(agent.introduced, "the rules still come with the first turn")

    def test_an_agent_that_never_answers_is_flagged_then_left_out(self):
        agent = QueueAgent(lambda turn: None)
        table = FakeTable()
        old = chatseat.NOT_ANSWERING_AFTER_S
        chatseat.NOT_ANSWERING_AFTER_S = 0.3
        try:
            threading.Timer(1.2, lambda: setattr(table, "status", "running") or setattr(table, "in_game", False)).start()
            self.assertFalse(agent.check_in(table, poll=0.2))
        finally:
            chatseat.NOT_ANSWERING_AFTER_S = old
        states = [s for s, _ in table.reports]
        self.assertEqual(states, ["checking", "needs"])
        self.assertIn("isn't answering", table.reports[1][1])

    def test_a_message_that_cant_be_sent_is_shown_and_tried_again(self):
        from pokerbench.llm import ProviderError

        agent = QueueAgent(lambda turn: 0.1)
        sent = agent._post
        fails = [ProviderError("agents: E79964: this terminal isn't connected to that agent")]

        def flaky(text):
            if fails:
                raise fails.pop()
            sent(text)
        agent._post = flaky
        table = FakeTable()
        self.assertTrue(agent.check_in(table, poll=0.1))
        self.assertEqual(table.reports[0][0], "needs")
        self.assertIn("isn't connected", table.reports[0][1])

    def test_a_restarted_seat_in_a_running_game_plays_on_without_asking(self):
        agent = QueueAgent(lambda turn: None)
        self.assertTrue(agent.check_in(FakeTable(status="running", in_game=True)))
        self.assertEqual(agent.posts, [])


if __name__ == "__main__":
    unittest.main()
