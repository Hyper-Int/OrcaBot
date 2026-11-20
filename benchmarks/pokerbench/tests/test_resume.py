# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Long unattended games: a restarted engine carries the game on from its checkpoint,
seats that keep missing turns sit out on a short clock, clients wait for an engine that
is restarting, and chat agents are kept posted between turns."""

import json
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

from pokerbench import cli
from pokerbench.chatseat import ChatSeat
from pokerbench.engine import Match, MatchConfig, load_checkpoint, resumable


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def started(run: Path, clock=None, **kw) -> Match:
    seats = kw.pop("seats", ("a", "b", "c"))
    m = Match(MatchConfig(seats=seats, start="manual", **kw), run, **({"clock": clock} if clock else {}))
    for s in seats:
        m.join(s)
    m.start_game()
    return m


def finish_hand(m: Match) -> None:
    n = m.hand.number
    while m.hand is not None and m.hand.number == n:
        legal = m.hand.legal()
        m.act(m.hand.actor, "check" if "check" in legal else "fold")


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name) / "run"

    def tearDown(self):
        self.tmp.cleanup()

    def restart(self, clock=None, grace=240.0) -> Match:
        cp = load_checkpoint(self.run)
        self.assertIsNotNone(cp)
        return Match(MatchConfig.from_dict(cp["config"]), self.run, resume=cp, rejoin_grace=grace,
                     **({"clock": clock} if clock else {}))

    def test_a_tournament_carries_on_where_it_was(self):
        m = started(self.run, format="tournament", duplicate=False, deals=20, seed=5)
        finish_hand(m)
        finish_hand(m)
        stacks, button = dict(m.stacks), m.button
        first_try = {s: m.hand.hole(s) for s in m.hand.plan.players}
        m.act(m.hand.actor, "call")  # hand 3 under way when the engine dies
        self.assertTrue(resumable(self.run))

        r = self.restart()
        self.assertEqual((r.status, len(r.results), r.hand, r.resumes), ("running", 2, None, 1))
        self.assertEqual(r.stacks, stacks)
        self.assertEqual(r.view("a")["resuming"]["next_hand"], 3)
        r.join("a"), r.join("b")
        self.assertIsNone(r.hand)  # still waiting for c
        r.join("c")
        self.assertEqual(r.hand.number, 3)
        self.assertEqual((r.hand.plan.players, r.button), (m.hand.plan.players, button))  # same seating
        # A fresh deck: nobody replays cards they have seen.
        self.assertNotEqual({s: r.hand.hole(s) for s in r.hand.plan.players}, first_try)
        finish_hand(r)
        self.assertEqual(len(r.results), 3)
        events = [json.loads(l) for l in (self.run / "events.jsonl").read_text().splitlines()]
        self.assertIn("resumed", [e["type"] for e in events])
        replay = [e for e in events if e["type"] == "hand_started" and e["hand"] == 3]
        self.assertEqual([e.get("replay_deck") for e in replay], [None, 1])

    def test_a_cash_game_replays_the_same_deal(self):
        m = started(self.run, deals=3, seed=2, seats=("a", "b"))
        finish_hand(m)
        cards = {s: m.hand.hole(s) for s in ("a", "b")}
        r = self.restart()
        r.join("a"), r.join("b")
        self.assertEqual(r.hand.number, 2)
        self.assertEqual({s: r.hand.hole(s) for s in ("a", "b")}, cards)

    def test_the_hold_ends_after_the_grace_or_from_the_table_page(self):
        clock = Clock()
        started(self.run, clock=clock, deals=3)
        r = self.restart(clock=clock, grace=60)
        r.join("a")
        r.tick()
        self.assertIsNone(r.hand)
        self.assertEqual(r.spectate()["resuming"]["waiting_for"], ["b", "c"])
        clock.t += 61
        r.tick()
        self.assertIsNotNone(r.hand)  # b and c just get timed out as usual

        started(Path(self.tmp.name) / "run2", deals=3)
        self.run = Path(self.tmp.name) / "run2"
        r2 = self.restart()
        r2.resume()  # DEAL NOW on the table page
        self.assertIsNotNone(r2.hand)

    def test_a_finished_or_ended_game_starts_anew(self):
        m = started(self.run, deals=1, seats=("a", "b"), duplicate=False)
        finish_hand(m)
        self.assertEqual(m.status, "finished")
        self.assertFalse(resumable(self.run))
        run2 = Path(self.tmp.name) / "run2"
        m2 = started(run2, deals=5)
        m2.end_game()
        self.assertFalse(resumable(run2))
        self.assertFalse(resumable(Path(self.tmp.name) / "lobby-only"))

    def test_resumable_picks_the_newest_unfinished_game(self):
        import contextlib
        import io

        from pokerbench.main import main

        runs = Path(self.tmp.name) / "runs"
        started(runs / "20260101-000000", deals=5)
        started(runs / "20260102-000000", deals=5)

        def newest() -> str:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                main(["resumable", "--runs", str(runs)])
            return out.getvalue().strip()

        self.assertEqual(newest(), "20260102-000000")
        m = started(runs / "20260103-000000", deals=5)
        m.end_game()
        self.assertEqual(newest(), "")  # the newest game was ended: a new one, not an older one
        self.assertEqual(Path(runs / "nothing").exists(), False)

    def test_the_report_drops_decisions_from_the_interrupted_hand(self):
        from pokerbench.report import build

        m = started(self.run, deals=5, seats=("a", "b"))
        finish_hand(m)
        m.act(m.hand.actor, "call")  # hand 2, interrupted
        time.sleep(1.1)  # timestamps are to the second
        r = self.restart()
        r.join("a"), r.join("b")
        finish_hand(r)
        r.end_game()
        rep = build(self.run)
        self.assertEqual(rep["hands_played"], 2)
        self.assertEqual(sum(s["decisions"] for s in rep["seats"].values()),
                         sum(len(x["actions"]) for x in r.results))


class SitOutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clock = Clock()
        self.m = started(Path(self.tmp.name) / "run", clock=self.clock, deals=50, turn_timeout=300,
                         seats=("a", "b"))

    def tearDown(self):
        self.tmp.cleanup()

    def time_out(self, seat: str) -> None:
        while self.m.hand.actor != seat:
            legal = self.m.hand.legal()
            self.m.act(self.m.hand.actor, "call" if "call" in legal else "check")
        self.clock.t += self.m._deadline() + 1
        self.m.tick()

    def test_missing_turns_in_a_row_shortens_the_clock_until_it_acts(self):
        m = self.m
        for _ in range(3):
            self.time_out("a")
        self.assertTrue(m.sitting_out("a"))
        self.assertEqual(m.spectate()["sitting_out"], ["a"])
        while m.hand.actor != "a":
            m.act(m.hand.actor, "call" if "call" in m.hand.legal() else "check")
        self.assertEqual(m._deadline(), 30.0)
        view = m.view("a")
        self.assertTrue(view["sitting_out"])
        self.assertIn("sitting out", cli.render(view))
        m.act("a", "call" if "call" in m.hand.legal() else "check")
        self.assertFalse(m.sitting_out("a"))
        self.assertEqual(m.missed["a"], 0)


class TurnOrderTests(unittest.TestCase):
    def test_the_view_says_how_soon_your_turn_comes(self):
        with tempfile.TemporaryDirectory() as d:
            m = started(Path(d) / "run", seats=("a", "b", "c", "d"), deals=5, turn_timeout=60)
            order = [m.hand.seat_at(i) for i in m.hand.state.actor_indices]
            last = order[-1]
            v = m.view(last)
            self.assertEqual(v["turn_in"], 3)
            self.assertGreater(v["turn_within_s"], 120)
            self.assertIn("after 3 more players", cli.render(v))
            self.assertEqual(m.view(order[0])["turn_in"], 0)


class ClientRetryTests(unittest.TestCase):
    def test_the_client_waits_for_a_restarting_engine_and_rereads_its_token(self):
        from pokerbench.server import make_server

        old = cli.RETRY_EVERY_S
        cli.RETRY_EVERY_S = 0.1
        tmp = tempfile.TemporaryDirectory()
        try:
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0))
                port = s.getsockname()[1]
            token_file = Path(tmp.name) / "a.token"
            token_file.write_text("old-token")
            m = Match(MatchConfig(seats=("a", "b"), deals=3, require_join=False), Path(tmp.name) / "run")
            srv = make_server(m, {"a": "new-token", "b": "tb"}, port=port)

            def later():
                time.sleep(0.5)
                token_file.write_text("new-token")  # the restarted engine's token
                srv.serve()

            threading.Thread(target=later, daemon=True).start()
            c = cli.Client(url=f"http://127.0.0.1:{port}", token="old-token", token_file=str(token_file),
                           retry_s=10)
            view = c.state()
            self.assertEqual(view["seat"], "a")
            srv.shutdown()
        finally:
            cli.RETRY_EVERY_S = old
            tmp.cleanup()


class FakeChat(ChatSeat):
    def __init__(self, replies=()):
        super().__init__("agent:test", reply_timeout=60)
        self.posts, self.queued = [], list(replies)

    def _post(self, text):
        self.posts.append(text)

    def _replies(self, deadline):
        while self.queued:
            yield self.queued.pop(0)


class ChatSeatTests(unittest.TestCase):
    def view(self, actions, turn_in=2):
        return {"match": {"status": "running", "hand": 4, "turn_timeout_s": 120, "seats": ["me", "x", "y"],
                          "blinds": [50, 100], "starting_stack": 10000},
                "you": {"seat": "me"}, "street": "flop", "actions": actions, "turn_in": turn_in,
                "turn_within_s": 80}

    def test_a_late_answer_to_an_earlier_turn_is_ignored(self):
        seat = FakeChat(['{"turn": 1, "action": "fold", "reason": "late"}',
                         '{"turn": 2, "action": "call", "reason": "now"}'])
        seat.introduced, seat.turn = True, 1
        seat.system_for(self.view([]), "sys")
        d = seat.decide("sys", ["CURRENT HAND\nHand 4/10"])
        self.assertEqual((d.action, d.reason), ("call", "now"))
        self.assertIn('{"turn": 2', seat.posts[-1])

    def test_updates_between_turns_only_when_something_happened(self):
        seat = FakeChat()
        a1 = {"seat": "x", "street": "flop", "action": "bet", "to": 200}
        seat.between_turns(self.view([a1]))
        self.assertEqual(seat.posts, [])  # not introduced yet: it wouldn't know the game
        seat.introduced = True
        seat.between_turns(self.view([a1]))
        seat.between_turns(self.view([a1]))  # nothing new
        self.assertEqual(len(seat.posts), 1)
        self.assertIn("no reply needed", seat.posts[0])
        self.assertIn("x bet to 200", seat.posts[0])
        self.assertIn("after 2 more players", seat.posts[0])
        a2 = {"seat": "y", "street": "flop", "action": "call", "amount": 200}
        seat.between_turns(self.view([a1, a2], turn_in=1))
        self.assertIn("y call 200", seat.posts[1])
        self.assertNotIn("x bet", seat.posts[1])
        seat.between_turns(self.view([a1, a2, a1], turn_in=None))  # folded / no turn this street
        self.assertEqual(len(seat.posts), 2)

    def test_the_intro_says_it_is_a_live_timed_game(self):
        from pokerbench.chatseat import intro_system

        m = {"seats": ["me", "x", "y"], "blinds": [50, 100], "starting_stack": 10000, "turn_timeout_s": 120,
             "sit_out_after": 3, "sit_out_timeout_s": 30}
        text = intro_system({"match": m}, 100)
        self.assertIn("LIVE, TIMED game", text)
        self.assertIn("100 seconds", text)
        self.assertIn("miss 3 turns in a row", text)
        self.assertIn('"turn": N', text)


if __name__ == "__main__":
    unittest.main()
