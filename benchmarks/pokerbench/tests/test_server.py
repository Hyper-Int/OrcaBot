# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""HTTP tests: auth, request log, bots over the real API, the CLI renderer."""

import io
import re
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from pokerbench import cli
from pokerbench.bots import play
from pokerbench.cli import ApiError, Client
from pokerbench.engine import Match, MatchConfig
from pokerbench.report import build
from pokerbench.server import make_server, write_tokens


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.match = Match(MatchConfig(seats=("alice", "bob"), deals=3, seed=5), self.dir / "run")
        self.tokens = write_tokens(("alice", "bob"), self.dir / "tokens")
        self.srv = make_server(self.match, self.tokens, "127.0.0.1", 0)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def _requests(self):
        return [json.loads(l) for l in (self.dir / "run" / "engine_requests.jsonl").read_text().splitlines()]

    def _requests_until(self, pred, timeout=5.0):
        """The server logs a request just after answering it, so poll for the entry."""
        import time

        deadline = time.monotonic() + timeout
        while True:
            path = self.dir / "run" / "engine_requests.jsonl"
            log = self._requests() if path.exists() else []
            if pred(log) or time.monotonic() > deadline:
                return log
            time.sleep(0.05)

    def test_token_files_are_private(self):
        for seat in ("alice", "bob"):
            mode = (self.dir / "tokens" / f"{seat}.token").stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)
        self.assertEqual((self.dir / "tokens").stat().st_mode & 0o777, 0o700)

    def test_client_dropping_a_wait_is_recorded_not_an_error(self):
        # Regression (live run): an agent killed its `poker wait`; the server crashed
        # writing to the closed socket and logged a traceback plus an internal error.
        import socket
        import struct
        import time

        port = self.srv.server_port
        s = socket.create_connection(("127.0.0.1", port))
        s.sendall(f"GET /api/seat/wait?timeout=1 HTTP/1.1\r\nHost: x\r\n"
                  f"Authorization: Bearer {self.tokens['alice']}\r\n\r\n".encode())
        time.sleep(0.2)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))  # RST on close
        s.close()
        log = self._requests_until(lambda l: any(r["path"] == "/api/seat/wait" for r in l))
        wait = [r for r in log if r["path"] == "/api/seat/wait"]
        self.assertEqual(wait[0]["error"], "client_gone")
        self.assertIsNone(wait[0]["status"])

    def test_bad_token_and_unknown_routes_are_logged(self):
        with self.assertRaises(ApiError) as e:
            Client(self.url, "nope").state()
        self.assertEqual(e.exception.status, 401)
        with self.assertRaises(urllib.error.HTTPError) as e2:
            req = urllib.request.Request(self.url + "/api/debug/hands")
            req.add_header("Authorization", f"Bearer {self.tokens['alice']}")
            urllib.request.urlopen(req)
        self.assertEqual(e2.exception.code, 404)
        log = self._requests_until(lambda l: any(r["path"] == "/api/debug/hands" for r in l)
                                   and any(r["auth"] == "invalid" for r in l))
        self.assertTrue(any(r["auth"] == "invalid" and r["status"] == 401 for r in log))
        probe = [r for r in log if r["path"] == "/api/debug/hands"]
        self.assertEqual(probe[0]["seat"], "alice")
        self.assertEqual(probe[0]["status"], 404)

    def test_bots_play_a_full_match_and_tokens_never_hit_logs(self):
        threads = [
            threading.Thread(target=play, args=(Client(self.url, self.tokens[s]), strat, i))
            for i, (s, strat) in enumerate((("alice", "tight"), ("bob", "random")))
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        self.assertEqual(self.match.status, "finished")
        report = build(self.dir / "run")
        self.assertEqual(report["hands_played"], 6)
        everything = "".join(p.read_text() for p in (self.dir / "run").rglob("*") if p.is_file())
        for token in self.tokens.values():
            self.assertNotIn(token, everything)
        self.assertEqual(report["seats"]["alice"]["off_api_requests"], [])

    def test_cli_renders_turn_and_errors(self):
        env = {"POKER_URL": self.url, "POKER_SEAT_TOKEN": self.tokens["alice"]}
        with mock.patch.dict("os.environ", env):
            Client(self.url, self.tokens["alice"]).state()
            Client(self.url, self.tokens["bob"]).state()  # both joined -> hand 1 starts
            actor = self.match.hand.actor
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = cli.main(["state"])
            self.assertEqual(rc, 0)
            out = buf.getvalue()
            self.assertIn("Hand 1/6", out)
            self.assertIn("Your cards:", out)
            if actor == "alice":
                self.assertIn("YOUR TURN", out)
                buf = io.StringIO()
                with redirect_stdout(buf):
                    rc = cli.main(["act", "check"])
                self.assertEqual(rc, 2)  # facing the big blind
                self.assertIn("ERROR (illegal)", buf.getvalue())
            else:
                self.assertIn("Run `poker wait`", out)

    def test_cli_renders_the_action_that_ends_the_match(self):
        # Regression: the final action's view has no "you" block; rendering it crashed
        # with KeyError '' and the agent never saw MATCH OVER (live Gemini/Haiku runs).
        Client(self.url, self.tokens["alice"]).state()
        Client(self.url, self.tokens["bob"]).state()
        clients = {s: Client(self.url, self.tokens[s]) for s in ("alice", "bob")}
        while True:
            hand = self.match.hand
            last_hand = hand.number == len(self.match.plans)
            seat = hand.actor
            legal = self.match.view(seat)["legal"]
            if last_hand and "fold" in legal:
                break
            clients[seat].act("check" if "check" in legal else "call")
        env = {"POKER_URL": self.url, "POKER_SEAT_TOKEN": self.tokens[seat]}
        buf = io.StringIO()
        with mock.patch.dict("os.environ", env), redirect_stdout(buf):
            rc = cli.main(["act", "fold", "--reason", "last decision"])
        out = buf.getvalue()
        self.assertEqual(rc, 0, out)
        self.assertIn(f"Hand {len(self.match.plans)} result: you lost", out)
        self.assertIn("MATCH OVER", out)


class NoFlagsInOutputTests(unittest.TestCase):
    """Gemini CLI asks before running a command with a flag that appeared in earlier
    command output (even in YOLO mode), so nothing `poker` prints may show one."""

    FLAG = re.compile(r"(?<![\w-])--?[a-z][\w-]*", re.I)

    def flags(self, text):
        return set(self.FLAG.findall(text)) - {"-h", "--help"}

    def test_help_and_rules_show_no_flags(self):
        for argv in (["--help"], ["act", "--help"], ["wait", "--help"], ["state", "--help"], ["history", "--help"]):
            buf = io.StringIO()
            with redirect_stdout(buf), self.assertRaises(SystemExit):
                cli.main(argv)
            self.assertEqual(self.flags(buf.getvalue()), set(), argv)
        m = {"blinds": [50, 100], "starting_stack": 10000, "turn_timeout_s": 120}
        self.assertEqual(self.flags(cli.rules_text(m)), set())

    def test_your_turn_shows_no_flags(self):
        match = Match(MatchConfig(seats=("alice", "bob"), deals=2, seed=1, require_join=False), Path(tempfile.mkdtemp()) / "run")
        actor = match.hand.actor
        text = cli.render(match.view(actor))
        self.assertIn("YOUR TURN", text)
        self.assertEqual(self.flags(text), set(), text)

    def test_the_reason_is_whatever_follows(self):
        self.assertEqual(cli.act_args("raise", ["300", "strong", "hand"], None), (300, "strong hand"))
        self.assertEqual(cli.act_args("call", ["pot odds are good"], None), (None, "pot odds are good"))
        self.assertEqual(cli.act_args("call", ["3", "outs"], None), (None, "3 outs"))  # only a bet/raise has a total
        self.assertEqual(cli.act_args("bet", ["250"], None), (250, None))
        self.assertEqual(cli.act_args("fold", [], "old style"), (None, "old style"))  # --reason still works
        self.assertEqual(cli.act_args("check", [], None), (None, None))


if __name__ == "__main__":
    unittest.main()
