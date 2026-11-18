# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""The lobby (start="manual"): seats join, more can be added, and the game starts when
someone presses Start on the table page, with whoever has joined."""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from pokerbench.bots import play
from pokerbench.cli import Client
from pokerbench.engine import ActionError, Match, MatchConfig
from pokerbench.server import make_server, write_control_token, write_tokens


class LobbyMatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name) / "run"

    def tearDown(self):
        self.tmp.cleanup()

    def match(self, seats, **kw):
        return Match(MatchConfig(seats=seats, deals=4, seed=3, start="manual", **kw), self.run)

    def test_everyone_joining_does_not_start_it(self):
        m = self.match(("a", "b"))
        m.join("a"), m.join("b")
        self.assertEqual(m.status, "waiting_for_players")

    def test_start_begins_with_who_joined_and_leaves_out_the_rest(self):
        m = self.match(("a", "b", "c", "d"))
        m.join("a"), m.join("c")
        out = m.start_game(uid=None)
        self.assertEqual(out["players"], ["a", "c"])
        self.assertEqual(out["left_out"], ["b", "d"])
        self.assertEqual(m.status, "running")
        self.assertEqual(m.cfg.seats, ("a", "c"))
        self.assertEqual(set(m.stacks), {"a", "c"})
        self.assertEqual(set(m.hand.plan.players), {"a", "c"})
        events = [json.loads(l) for l in (self.run / "events.jsonl").read_text().splitlines()]
        self.assertTrue(any(e["type"] == "started" and e["left_out"] == ["b", "d"] for e in events))

    def test_start_needs_two_players(self):
        m = self.match(("a", "b"))
        m.join("a")
        with self.assertRaises(ActionError) as e:
            m.start_game()
        self.assertEqual(e.exception.code, "not_enough_players")

    def test_a_player_cannot_start(self):
        m = self.match(("a", "b"))
        m.engine_uid = 1000
        self.assertEqual(m.authenticate(None, 2001, "a"), ("a", "claim"))
        m.join("a"), m.join("b")
        with self.assertRaises(ActionError) as e:
            m.start_game(uid=2001)
        self.assertEqual(e.exception.code, "not_allowed")
        self.assertEqual(m.status, "waiting_for_players")
        m.start_game(uid=3000)  # the browser's user
        self.assertEqual(m.status, "running")

    def test_seats_can_be_added_while_waiting_and_not_after(self):
        m = self.match(())  # Agent blocks only: the table can start empty
        self.assertTrue(m.add_seat("muse"))
        self.assertFalse(m.add_seat("muse"))
        m.add_seat("grok")
        with self.assertRaises(ActionError):
            m.add_seat("Not A Name")
        m.join("muse"), m.join("grok")
        m.start_game()
        with self.assertRaises(ActionError) as e:
            m.add_seat("late")
        self.assertEqual(e.exception.code, "already_started")

    def test_a_seat_left_out_is_told_so(self):
        m = self.match(("a", "b", "c"))
        m.join("a"), m.join("b")
        m.start_game()
        self.assertEqual(m.authenticate("c", 5, None), (None, "not_seated"))  # by token
        self.assertEqual(m.authenticate(None, 6, "c"), (None, "not_seated"))  # by claim

    def test_rig_seat_left_out_turns_rigging_off(self):
        m = Match(MatchConfig(seats=("a", "b", "c"), deals=4, seed=3, start="manual", duplicate=False,
                              rig_seat="c", rig_hands=3), self.run)
        m.join("a"), m.join("b")
        m.start_game()
        self.assertIsNone(m.cfg.rig_seat)
        self.assertEqual(m.cfg.rig_hands, 0)

    def test_tournament_starts_too(self):
        m = Match(MatchConfig(seats=("a", "b", "c"), deals=5, seed=1, start="manual", format="tournament",
                              duplicate=False), self.run)
        m.join("b"), m.join("c")
        m.start_game()
        self.assertEqual(m.spectate()["tournament"]["chips"], {"b": 10_000, "c": 10_000})

    def test_auto_start_is_unchanged(self):
        m = Match(MatchConfig(seats=("a", "b"), deals=2, seed=3), self.run)
        m.join("a")
        self.assertEqual(m.status, "waiting_for_players")
        m.join("b")
        self.assertEqual(m.status, "running")


class PauseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = [100.0]
        self.m = Match(MatchConfig(seats=("a", "b"), deals=4, seed=3, start="manual", turn_timeout=30),
                       Path(self.tmp.name) / "run", clock=lambda: self.now[0])
        self.m.join("a"), self.m.join("b")
        self.m.start_game()

    def tearDown(self):
        self.tmp.cleanup()

    def test_paused_nobody_gets_a_turn_and_the_clock_stops(self):
        actor = self.m.hand.actor
        self.now[0] += 10                       # 20s left
        self.m.pause()
        self.assertFalse(self.m.view(actor)["to_act"])
        self.assertTrue(self.m.spectate()["paused"])
        self.now[0] += 500                      # far past the timeout
        self.m.tick()
        self.assertEqual(self.m.hand.actor, actor)  # no timeout fold
        self.assertEqual(self.m.spectate()["live"]["seconds_left"], 20.0)
        self.m.resume()
        self.assertTrue(self.m.view(actor)["to_act"])
        self.assertEqual(self.m._deadline(), 20.0)  # keeps the time it had left
        self.now[0] += 21
        self.m.tick()
        self.assertNotEqual(self.m.hand.actor, actor)  # now it times out

    def test_a_decision_in_progress_still_counts(self):
        actor = self.m.hand.actor
        self.m.pause()
        self.m.act(actor, "call")
        nxt = self.m.hand.actor
        self.assertFalse(self.m.view(nxt)["to_act"])

    def test_a_player_cannot_pause(self):
        self.m.engine_uid = 1000
        self.m.seat_uids["a"] = 2001
        with self.assertRaises(ActionError) as e:
            self.m.pause(uid=2001)
        self.assertEqual(e.exception.code, "not_allowed")
        self.assertFalse(self.m.paused)

    def test_cannot_pause_before_the_start(self):
        m = Match(MatchConfig(seats=("a", "b"), deals=2, seed=3, start="manual"), Path(self.tmp.name) / "r2")
        with self.assertRaises(ActionError):
            m.pause()

    def test_the_cli_says_it_is_paused(self):
        from pokerbench.cli import render

        actor = self.m.hand.actor
        other = "b" if actor == "a" else "a"
        self.m.pause()
        self.assertIn("paused", render(self.m.view(other)))


class LobbyServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.match = Match(MatchConfig(seats=("alice", "bob", "carol"), deals=2, seed=5, start="manual"),
                           self.dir / "run")
        self.tokens = write_tokens(self.match.cfg.seats, self.dir / "tokens")
        self.control = write_control_token(self.dir / "control.token")
        self.srv = make_server(self.match, self.tokens, "127.0.0.1", 0,
                               tokens_dir=self.dir / "tokens", control_token=self.control)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def post(self, path, body=None, headers=None):
        req = urllib.request.Request(self.url + path, data=json.dumps(body or {}).encode(), method="POST",
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_control_token_file_is_private(self):
        self.assertEqual((self.dir / "control.token").stat().st_mode & 0o777, 0o600)

    def test_adding_a_seat_needs_the_control_token(self):
        self.assertEqual(self.post("/api/table/seats", {"seat": "muse"})[0], 403)
        self.assertEqual(self.post("/api/table/seats", {"seat": "muse"}, {"X-Poker-Control": "nope"})[0], 403)
        status, out = self.post("/api/table/seats", {"seat": "muse"}, {"X-Poker-Control": self.control})
        self.assertEqual((status, out["added"]), (200, True))
        self.assertIn("muse", self.match.cfg.seats)
        token = (self.dir / "tokens" / "muse.token").read_text().strip()
        self.assertEqual((self.dir / "tokens" / "muse.token").stat().st_mode & 0o777, 0o600)
        self.assertEqual(Client(url=self.url, token=token).state()["seat"], "muse")  # the new token works

    def test_a_body_the_route_ignores_does_not_break_the_next_request(self):
        # Regression: the table page POSTs "{}" to start; the route never read it, so on the
        # same keep-alive connection the next request arrived as "{}GET ..." (501).
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.srv.server_port)
        conn.request("POST", "/api/table/start", body="{}", headers={"Content-Type": "application/json"})
        conn.getresponse().read()
        conn.request("GET", "/api/spectate")
        r = conn.getresponse()
        self.assertEqual(r.status, 200)
        self.assertEqual(json.loads(r.read())["status"], "waiting_for_players")
        conn.close()

    def test_start_over_http_then_play_to_the_end(self):
        self.assertEqual(self.post("/api/table/start")[0], 409)  # nobody yet
        alice = Client(url=self.url, token=self.tokens["alice"])
        bob = Client(url=self.url, token=self.tokens["bob"])
        alice.state(), bob.state()
        status, out = self.post("/api/table/start")
        self.assertEqual(status, 200, out)
        self.assertEqual(out["left_out"], ["carol"])
        self.assertEqual(self.post("/api/table/start")[0], 409)  # already started
        self.assertEqual(self.post("/api/table/pause")[0], 200)
        self.assertTrue(self.match.paused)
        self.assertEqual(self.post("/api/table/resume")[0], 200)
        self.assertFalse(self.match.paused)
        carol = Client(url=self.url, token=self.tokens["carol"])
        with self.assertRaises(Exception):
            carol.state()
        results = {}
        threads = [threading.Thread(target=lambda c=c, n=n: results.__setitem__(n, play(c, "call")))
                   for n, c in (("alice", alice), ("bob", bob))]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        self.assertEqual(self.match.status, "finished")
        self.assertEqual(set(results), {"alice", "bob"})


if __name__ == "__main__":
    unittest.main()
