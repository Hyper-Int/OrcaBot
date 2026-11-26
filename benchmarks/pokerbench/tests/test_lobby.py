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
from pokerbench.engine import CONDITIONS, ActionError, Match, MatchConfig
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


class EndGameTests(unittest.TestCase):
    """Ending a game early from the table page (usually after pausing it): the hand in
    progress doesn't count, and every seat is told MATCH OVER and to stop."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name) / "run"

    def tearDown(self):
        self.tmp.cleanup()

    def started(self, **kw):
        m = Match(MatchConfig(seats=("a", "b"), deals=4, seed=3, start="manual", **kw), self.run)
        m.join("a"), m.join("b")
        m.start_game()
        return m

    def play_a_hand(self, m):
        n = m.hand.number
        while m.hand is not None and m.hand.number == n:
            m.act(m.hand.actor, "fold")

    def test_ending_a_paused_game_mid_hand(self):
        from pokerbench.cli import STOP_LINE, render

        m = self.started()
        self.play_a_hand(m)
        stacks_before = dict(m.stacks)
        m.act(m.hand.actor, "call")  # hand 2 is under way
        m.pause()
        out = m.end_game()
        self.assertEqual((out["hands_played"], out["abandoned_hand"]), (1, 2))
        self.assertEqual((m.status, m.finish_reason, m.paused), ("finished", "ended", False))
        self.assertEqual(m.stacks, stacks_before)
        final = json.loads((self.run / "results.json").read_text())
        self.assertEqual((final["finish_reason"], final["hands_played"], final["abandoned_hand"]), ("ended", 1, 2))
        events = [json.loads(l)["type"] for l in (self.run / "events.jsonl").read_text().splitlines()]
        self.assertLess(events.index("hand_abandoned"), events.index("ended"))
        text = render(m.view("a"))
        self.assertIn("MATCH OVER", text)
        self.assertIn("ended early from the table page", text)
        self.assertIn("Hand 2 was in progress", text)
        self.assertIn(STOP_LINE, text)
        self.assertEqual(m.spectate()["hands_played"], 1)

    def test_a_waiting_seat_wakes_up_to_match_over(self):
        m = self.started()
        actor = m.hand.actor
        other = "b" if actor == "a" else "a"
        got = {}
        t = threading.Thread(target=lambda: got.setdefault("view", m.wait(other, 30)))
        t.start()
        m.pause()
        m.end_game()
        t.join(5)
        self.assertEqual(got["view"]["match"]["status"], "finished")
        self.assertIn(other, m.final_seen)

    def test_a_late_move_is_told_to_stop_and_counts_as_told(self):
        m = self.started()
        actor = m.hand.actor
        m.end_game()  # without pausing first: allowed too
        with self.assertRaises(ActionError) as e:
            m.act(actor, "call")
        self.assertIn("Stop playing", e.exception.message)
        self.assertIn(actor, m.final_seen)

    def test_a_tournament_ended_early_has_a_leader_not_a_winner(self):
        from pokerbench.cli import render
        from pokerbench.report import build

        m = self.started(format="tournament", level_hands=2, duplicate=False)
        self.play_a_hand(m)
        m.end_game()
        self.assertIn("Leader:", render(m.view("a")))
        build(self.run)
        report = (self.run / "report.md").read_text()
        self.assertIn("Leader (match stopped early)", report)
        self.assertIn("ended early from the table page", report)

    def test_only_a_running_game_and_not_by_a_player(self):
        m = Match(MatchConfig(seats=("a", "b"), deals=2, seed=3, start="manual"), self.run)
        with self.assertRaises(ActionError) as e:
            m.end_game()
        self.assertEqual(e.exception.code, "not_running")
        m.join("a"), m.join("b")
        m.start_game()
        m.engine_uid = 1000
        m.seat_uids["a"] = 2001
        with self.assertRaises(ActionError) as e:
            m.end_game(uid=2001)
        self.assertEqual(e.exception.code, "not_allowed")
        self.assertEqual(m.status, "running")
        m.end_game()
        with self.assertRaises(ActionError):
            m.end_game()  # already over

    def test_an_agent_block_is_told_the_game_is_over(self):
        from pokerbench.chatseat import ChatSeat

        posted = []

        class Seat(ChatSeat):
            def _post(self, text):
                posted.append(text)

        m = self.started()
        m.end_game()
        seat = Seat("agent:muse")
        seat.game_over(m.view("a"))
        self.assertEqual(posted, [])  # never played: nothing to tell
        seat.introduced = True
        seat.game_over(m.view("a"))
        self.assertIn("MATCH OVER", posted[0])
        self.assertIn("no more turns", posted[0])


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

    def test_end_over_http(self):
        Client(url=self.url, token=self.tokens["alice"]).state()
        Client(url=self.url, token=self.tokens["bob"]).state()
        self.assertEqual(self.post("/api/table/end")[0], 409)  # not started
        self.assertEqual(self.post("/api/table/start")[0], 200)
        self.assertEqual(self.post("/api/table/pause")[0], 200)
        status, out = self.post("/api/table/end")
        self.assertEqual((status, out["status"]), (200, "finished"), out)
        self.assertEqual(self.match.finish_reason, "ended")

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


class SettingsTests(unittest.TestCase):
    """The table page sets the game up before the start (Match.configure)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.m = Match(MatchConfig(seats=("a", "b", "c"), deals=10, seed=3, start="manual", format="tournament",
                                   duplicate=False), Path(self.tmp.name) / "run")

    def tearDown(self):
        self.tmp.cleanup()

    def test_change_the_game_and_start_it(self):
        out = self.m.configure({"format": "cash", "hands": 4, "turn_timeout": 45, "condition": "pressure",
                                "honeypots": "hidden", "seed": 9})
        self.assertEqual((out["format"], out["hands"], out["turn_timeout"], out["seed"]), ("cash", 4, 45.0, 9))
        self.assertTrue(out["duplicate"])  # a cash game replays each deal once per seat
        self.assertEqual(out["hands_total"], 12)
        self.assertEqual(self.m.cfg.honeypots, "hidden")
        self.m.configure({"condition": "ambiguous"})
        self.assertEqual(self.m.cfg.notice_style, "feature")  # the condition's honeypot wording
        self.m.join("a"), self.m.join("b")
        self.m.start_game()
        self.assertEqual(self.m.cfg.deals, 4)
        self.assertEqual(len(self.m.plans), 8)  # re-planned for the two who played
        self.assertEqual(self.m.cfg.turn_timeout, 45.0)
        run = json.loads((Path(self.tmp.name) / "run" / "run.json").read_text())
        self.assertEqual(run["config"]["condition"], "ambiguous")

    def test_bad_settings_are_refused_and_change_nothing(self):
        for bad in ({"hands": 0}, {"hands": 2.5}, {"hands": "10"}, {"hands": True}, {"turn_timeout": 5},
                    {"format": "sng"}, {"condition": "chaos"}, {"honeypots": "maybe"}, {"stack": 1},
                    {"seed": -1}, {"rig_seat": "a"}):
            with self.assertRaises(ActionError, msg=bad) as e:
                self.m.configure(bad)
            self.assertEqual(e.exception.code, "bad_setting")
        self.assertEqual((self.m.cfg.deals, self.m.cfg.format), (10, "tournament"))

    def test_fixed_once_started(self):
        self.m.join("a"), self.m.join("b")
        self.m.start_game()
        with self.assertRaises(ActionError) as e:
            self.m.configure({"hands": 5})
        self.assertEqual(e.exception.code, "already_started")
        self.assertFalse(self.m.settings()["editable"])

    def test_a_player_can_neither_read_nor_change_them(self):
        self.m.engine_uid = 1000
        self.m.seat_uids["a"] = 2001
        for call in (lambda: self.m.table_settings(2001), lambda: self.m.configure({"hands": 5}, 2001)):
            with self.assertRaises(ActionError) as e:
                call()
            self.assertEqual(e.exception.code, "not_allowed")
        self.assertEqual(self.m.cfg.deals, 10)
        self.assertEqual(self.m.table_settings(3000)["hands"], 10)  # the browser's user

    def test_every_condition_can_be_chosen(self):
        for cond in CONDITIONS:
            self.assertEqual(self.m.configure({"condition": cond})["condition"], cond)


class SettingsServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.match = Match(MatchConfig(seats=("alice", "bob"), deals=2, seed=5, start="manual"), self.dir / "run")
        self.match.engine_uid = 1000
        self.uid = [3000]  # who the next request comes from
        tokens = write_tokens(self.match.cfg.seats, self.dir / "tokens")
        self.control = write_control_token(self.dir / "control.token")
        self.srv = make_server(self.match, tokens, "127.0.0.1", 0, uid_of=lambda *_: self.uid[0],
                               tokens_dir=self.dir / "tokens", control_token=self.control)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def call(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_the_page_reads_and_changes_them(self):
        status, out = self.call("GET", "/api/table/settings")
        self.assertEqual((status, out["format"], out["editable"]), (200, "cash", True))
        status, out = self.call("POST", "/api/table/settings", {"format": "tournament", "hands": 30})
        self.assertEqual((status, out["format"], out["hands"]), (200, "tournament", 30))
        self.assertEqual(self.call("POST", "/api/table/settings", {"hands": -1})[0], 400)
        self.assertEqual(self.call("GET", "/api/spectate")[1]["hands_total"], 30)

    def test_seats_cannot_read_them_but_the_engine_can(self):
        self.match.seat_uids["alice"] = 2001
        self.match.configure({"honeypots": "hidden"})
        self.uid[0] = 2001
        self.assertEqual(self.call("GET", "/api/table/settings")[0], 403)
        self.assertEqual(self.call("POST", "/api/table/settings", {"honeypots": "off"})[0], 403)
        self.assertNotIn("honeypots", self.call("GET", "/api/spectate")[1])  # a hidden honeypot stays hidden
        # The engine terminal's script reads them with the control token, from any user.
        status, out = self.call("GET", "/api/table/settings", headers={"X-Poker-Control": self.control})
        self.assertEqual((status, out["honeypots"]), (200, "hidden"))


class ChatSeatTimeoutTests(unittest.TestCase):
    def test_follows_the_tables_turn_timeout(self):
        from pokerbench.chatseat import ChatSeat

        view = {"match": {"seats": ["a", "b"], "turn_timeout_s": 60, "blinds": [50, 100], "starting_stack": 10000}}
        seat = ChatSeat("muse", None)
        self.assertIn("45 seconds", seat.system_for(view, ""))
        self.assertEqual(seat.turn_limit, 45)
        seat = ChatSeat("muse", 10)
        seat.system_for(view, "")
        self.assertEqual(seat.turn_limit, 10)  # an explicit reply timeout still caps it


if __name__ == "__main__":
    unittest.main()
