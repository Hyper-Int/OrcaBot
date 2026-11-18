# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Players are what is linked to the engine: seats come and go with canvas links, the
table page chooses what plays each one, and a seat terminal is bound to its own OS user."""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from pokerbench.engine import ActionError, Match, MatchConfig
from pokerbench.host import Engine, Host, linked_seats
from pokerbench.players import PlayerError, label, normalize, seat_name
from pokerbench.server import make_server, write_control_token, write_tokens


class PlayerTests(unittest.TestCase):
    def test_normalize_keeps_only_what_the_kind_uses(self):
        self.assertEqual(normalize({"kind": "codex", "model": "gpt-5.5", "strategy": "x"}),
                         {"kind": "codex", "model": "gpt-5.5"})
        self.assertEqual(normalize({"kind": "api"}), {"kind": "api", "provider": "anthropic", "model": "claude-opus-5-5"})
        self.assertEqual(normalize({"kind": "house"}), {"kind": "house", "strategy": "tight"})

    def test_bad_players(self):
        for bad in ({"kind": "agent"}, {"kind": "nope"}, {"kind": "api", "provider": "openai"},
                    {"kind": "codex", "model": "rm -rf /"}, {"kind": "house", "strategy": "bluff"}, "codex"):
            with self.assertRaises(PlayerError, msg=bad):
                normalize(bad)
        self.assertEqual(normalize({"kind": "agent", "name": "Muse"}, allow_agent=True)["kind"], "agent")

    def test_labels(self):
        self.assertEqual(label({"kind": "claude-code", "model": "opus"}), "Claude Code (opus)")
        self.assertEqual(label({"kind": "api", "provider": "openai", "model": "gpt-5.5"}), "openai/gpt-5.5 (API)")

    def test_seat_names_come_from_the_canvas(self):
        self.assertEqual(seat_name("Seat: Claude Code", set()), "claude-code")
        self.assertEqual(seat_name("Claude Sonnet (API)", set()), "claude-sonnet-api")
        self.assertEqual(seat_name("Codex", {"codex"}), "codex-2")
        self.assertEqual(seat_name("", set()), "player")
        self.assertEqual(seat_name("___", set()), "player")


class EngineSeatTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.m = Match(MatchConfig(seats=(), deals=2, seed=3, start="manual"), Path(self.tmp.name) / "run")
        self.m.engine_uid = 1000

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_linked_terminal_is_bound_to_its_user(self):
        self.m.add_seat("codex", uid=2003)
        self.assertEqual(self.m.authenticate(None, 2003, None), ("codex", "uid"))  # no claim needed
        self.assertEqual(self.m.authenticate(None, 2009, "codex"), (None, "seat_taken"))  # another terminal

    def test_unlinking_takes_the_seat_away(self):
        self.m.add_seat("codex", uid=2003)
        self.m.add_seat("house", uid=2004)
        self.m.join("codex")
        self.assertTrue(self.m.remove_seat("codex"))
        self.assertEqual(self.m.cfg.seats, ("house",))
        self.assertNotIn("codex", self.m.joined)
        self.assertNotIn("codex", self.m.seat_uids)
        self.assertFalse(self.m.remove_seat("codex"))

    def test_a_restarted_terminal_is_rebound_and_plays_on(self):
        for seat, uid in (("a", 2001), ("b", 2002)):
            self.m.add_seat(seat, uid=uid)
            self.m.join(seat)
        self.m.start_game()
        self.assertTrue(self.m.bind_seat("a", 2050))  # the terminal restarted: a new PTY user
        self.assertEqual(self.m.authenticate(None, 2050, None), ("a", "uid"))
        self.assertEqual(self.m.authenticate(None, 2001, None), (None, "unauthenticated"))  # the old one is gone
        with self.assertRaises(ActionError):
            self.m.remove_seat("a")  # but nobody leaves a running game

    def test_the_table_page_switches_a_bot_seat_and_it_checks_in_again(self):
        self.m.add_seat("seat1", uid=2001)
        setup = self.m.seat_setup("seat1", {"kind": "house"})  # the terminal's own default
        self.assertEqual(setup["player"], {"kind": "house", "strategy": "tight"})
        self.m.join("seat1")
        out = self.m.set_player("seat1", {"kind": "api", "provider": "openai", "model": "gpt-5.5"}, uid=3000)
        self.assertEqual(out["player"]["kind"], "api")
        self.assertNotIn("seat1", self.m.joined)  # it has to check in as the new player
        self.assertEqual(self.m.spectate()["seat_status"]["seat1"]["state"], "switching")
        self.assertEqual(self.m.seat_setup("seat1", {"kind": "house"})["player"]["kind"], "api")
        self.assertEqual(self.m.seat_setup("seat1")["rev"], 1)
        self.assertEqual(self.m.spectate()["players"]["seat1"]["label"], "openai/gpt-5.5 (API)")

    def test_an_agent_terminal_is_its_agent(self):
        # Claude Code runs interactively in its terminal: the table page can't swap it.
        self.m.add_seat("claude", uid=2001)
        self.m.seat_setup("claude", {"kind": "claude-code"})
        with self.assertRaises(ActionError) as e:
            self.m.set_player("claude", {"kind": "house"})
        self.assertIn("running in its terminal", e.exception.message)
        # ...and a bot terminal can't become one.
        self.m.add_seat("bot", uid=2002)
        self.m.seat_setup("bot", {"kind": "house"})
        with self.assertRaises(ActionError) as e:
            self.m.set_player("bot", {"kind": "codex"})
        self.assertIn("own terminal", e.exception.message)

    def test_players_cannot_choose_and_agent_blocks_are_fixed(self):
        self.m.add_seat("seat1", uid=2001)
        with self.assertRaises(ActionError) as e:
            self.m.set_player("seat1", {"kind": "house"}, uid=2001)
        self.assertEqual(e.exception.code, "not_allowed")
        self.m.add_seat("muse", player={"kind": "agent", "name": "Muse"})
        with self.assertRaises(ActionError) as e:
            self.m.set_player("muse", {"kind": "house"})
        self.assertEqual(e.exception.code, "bad_player")
        with self.assertRaises(ActionError):
            self.m.set_player("seat1", {"kind": "warlock"})

    def test_a_seat_says_why_it_cannot_play(self):
        self.m.add_seat("codex", uid=2003)
        self.m.report_seat_status("codex", "needs", "Codex isn't signed in\x1b[2J")
        self.assertEqual(self.m.spectate()["seat_status"]["codex"],
                         {"state": "needs", "message": "Codex isn't signed in [2J"})
        self.m.join("codex")
        self.assertNotIn("codex", self.m.spectate()["seat_status"])  # ready now

    def test_seats_sharing_the_engines_user_claim_by_name(self):
        # Outside Orcabot's PTY pool every terminal is root, like the engine.
        self.m.engine_uid = 0
        self.m.add_seat("a")
        self.m.add_seat("b")
        self.assertEqual(self.m.authenticate(None, 0, "a"), ("a", "claim"))
        self.assertEqual(self.m.authenticate(None, 0, "b"), ("b", "claim"))
        self.assertEqual(self.m.authenticate(None, 0, "a"), ("a", "claim"))
        self.assertFalse(self.m._isolation()["enforced"])


class FakeSandbox:
    """What the sandbox says is linked to the engine terminal."""

    def __init__(self):
        self.terminals, self.agent_list, self.fail = [], [], None

    def links(self):
        if self.fail:
            raise self.fail
        return {"terminals": self.terminals, "pool": True}

    def agents(self):
        return self.agent_list


class HostTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.match = Match(MatchConfig(seats=(), deals=2, seed=5, start="manual"), d / "run")
        tokens = write_tokens((), d / "tokens")
        control = write_control_token(d / "control.token")
        self.uid = [3000]  # who the next request comes from (the table page)
        self.srv = make_server(self.match, tokens, "127.0.0.1", 0, uid_of=lambda *_: self.uid[0],
                               tokens_dir=d / "tokens", control_token=control)
        threading.Thread(target=self.srv.serve, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        (d / "pub").mkdir()
        self.sandbox = FakeSandbox()
        self.lines = []
        self.host = Host(Engine(self.url, control), d / "pub", d / "tokens", d / "run", "g1", "pokerbench",
                         sandbox=self.sandbox, say=self.lines.append)
        self.pub = d / "pub"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def test_names_are_stable_and_unique(self):
        seats = linked_seats([{"itemId": "i2", "name": "Codex", "ptyId": "p2"},
                              {"itemId": "i1", "name": "Codex", "ptyId": "p1"}],
                             [{"identity": "orca:o/agent:muse", "name": "Muse"}])
        self.assertEqual(sorted(seats), ["codex", "codex-2", "muse"])
        self.assertEqual(seats["codex"]["item"], "i1")
        self.assertEqual(seats["muse"]["kind"], "agent")

    def test_linking_and_unlinking_seat_and_unseat(self):
        self.sandbox.terminals = [{"itemId": "i1", "name": "Claude Code", "ptyId": "p1", "uid": 2001},
                                  {"itemId": "i2", "name": "House bot", "ptyId": "p2", "uid": 2002}]
        self.sandbox.agent_list = [{"identity": "orca:o/agent:muse", "name": "Muse"}]
        self.host.step()
        self.assertEqual(set(self.match.cfg.seats), {"claude-code", "house-bot", "muse"})
        self.assertEqual(self.match.seat_uids["claude-code"], 2001)
        self.assertEqual(self.match.players["muse"], {"kind": "agent", "name": "Muse"})
        seats = json.loads((self.pub / "seats.json").read_text())
        self.assertEqual(seats["by_pty"], {"p1": "claude-code", "p2": "house-bot"})
        self.assertIn('POKER_STARTED=0', (self.pub / "engine.env").read_text())
        # A blip at the control plane unseats nobody.
        from pokerbench.agentlink import SandboxError
        self.sandbox.fail = SandboxError("links: 502", status=502)
        self.host.step()
        self.assertEqual(len(self.match.cfg.seats), 3)
        # Unlinked: gone. Restarted: rebound to its new user.
        self.sandbox.fail = None
        self.sandbox.terminals = [{"itemId": "i1", "name": "Claude Code", "ptyId": "p9", "uid": 2009}]
        self.host.step()
        self.assertEqual(set(self.match.cfg.seats), {"claude-code", "muse"})
        self.assertEqual(self.match.seat_uids["claude-code"], 2009)
        self.assertEqual(json.loads((self.pub / "seats.json").read_text())["by_pty"], {"p9": "claude-code"})
        self.assertTrue(any(line.startswith("   - house-bot") for line in self.lines))

    def test_an_old_sandbox_without_links_keeps_seats_from_seats(self):
        from pokerbench.agentlink import SandboxError
        self.sandbox.fail = SandboxError("links: 404", status=404)
        self.host.static = ("a", "b")
        self.host.seats = {"a": {"kind": "static"}, "b": {"kind": "static"}}
        self.match.add_seat("a"), self.match.add_seat("b")
        self.host.step()
        self.assertEqual(set(self.match.cfg.seats), {"a", "b"})
        self.assertTrue(any("predates linked seats" in line for line in self.lines))

    def test_the_start_renders_the_prompt_for_the_chosen_condition(self):
        self.sandbox.terminals = [{"itemId": "i1", "name": "A", "ptyId": "p1"},
                                  {"itemId": "i2", "name": "B", "ptyId": "p2"}]
        self.host.step()
        self.match.configure({"condition": "pressure", "format": "cash"})
        self.match.join("a"), self.match.join("b")
        self.match.start_game()
        self.host.step()
        self.assertIn("retired", (self.pub / "prompt.txt").read_text())
        self.assertIn("POKER_STARTED=1", (self.pub / "engine.env").read_text())
        self.assertTrue(any("== Started: a b" in line for line in self.lines))

    def post(self, path, body, headers=None):
        req = urllib.request.Request(self.url + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_seat_routes(self):
        self.match.add_seat("codex")
        hdr = {"X-Poker-Seat": "codex"}
        self.uid[0] = 2003  # the seat's terminal
        status, out = self.post("/api/seat/setup", {"default": {"kind": "api"}}, hdr)
        self.assertEqual((status, out["player"]["kind"]), (200, "api"))
        self.assertEqual(self.post("/api/seat/status", {"state": "needs", "message": "not signed in"}, hdr)[0], 200)
        self.assertNotIn("codex", self.match.joined)  # asking isn't checking in
        self.assertEqual(self.post("/api/table/players", {"seat": "codex", "player": {"kind": "house"}})[0], 403)
        self.uid[0] = 3000  # the table page
        status, out = self.post("/api/table/players", {"seat": "codex", "player": {"kind": "house"}})
        self.assertEqual((status, out["player"]["kind"]), (200, "house"))
        # Seating is the engine's job: refused without its control token.
        self.assertEqual(self.post("/api/table/seats", {"seat": "x"})[0], 403)
        self.assertEqual(self.post("/api/table/seats/remove", {"seat": "codex"})[0], 403)


class CliFindsItsSeatTests(unittest.TestCase):
    """An agent started in its own terminal before the game has no POKER_SEAT: the poker
    command finds the engine and its seat from what the engine publishes."""

    def test_from_engine_env_and_seats_json(self):
        import os
        from unittest import mock

        from pokerbench.cli import Client

        with tempfile.TemporaryDirectory() as tmp:
            pub, tokens = Path(tmp) / "pub", Path(tmp) / "tokens"
            pub.mkdir(), tokens.mkdir()
            (pub / "engine.env").write_text(f'POKER_URL=http://127.0.0.1:9999\nPOKER_TOKENS_DIR={tokens}\n'
                                            'POKER_SEATS="claude-code"\nPOKER_STARTED=1\n')
            (pub / "seats.json").write_text(json.dumps({"by_pty": {"pty-7": "claude-code"}}))
            (tokens / "claude-code.token").write_text("tok\n")
            env = {"POKER_PUB": str(pub), "ORCABOT_PTY_ID": "pty-7"}
            with mock.patch.dict(os.environ, env, clear=True):
                c = Client()
            self.assertEqual((c.url, c.seat, c.token), ("http://127.0.0.1:9999", "claude-code", "tok"))
            with mock.patch.dict(os.environ, {**env, "ORCABOT_PTY_ID": "pty-other"}, clear=True):
                self.assertIsNone(Client().seat)  # a terminal that isn't linked has no seat
            with mock.patch.dict(os.environ, {**env, "POKER_URL": "http://x", "POKER_SEAT": "a"}, clear=True):
                c = Client()
            self.assertEqual((c.url, c.seat), ("http://x", "a"))  # what it was told wins


if __name__ == "__main__":
    unittest.main()
