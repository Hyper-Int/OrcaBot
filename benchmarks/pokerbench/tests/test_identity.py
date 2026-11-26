# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Seat identity: peer-UID parsing, token/UID binding, claims, isolation status."""

import json
import tempfile
import threading
import unittest
from pathlib import Path

from pokerbench.cli import ApiError, Client
from pokerbench.engine import Match, MatchConfig
from pokerbench.identity import parse_peer_uid
from pokerbench.server import make_server, write_tokens

# Two loopback sockets: the client 127.0.0.1:40000 -> :8765 owned by uid 2001,
# and the engine's accepted end owned by uid 1000.
PROC_NET_TCP = """\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:9C40 0100007F:223D 01 00000000:00000000 00:00000000 00000000  2001        0 2 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:223D 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 3 1 0000000000000000 20 4 30 10 -1
"""


class ParseTests(unittest.TestCase):
    def test_finds_the_client_sockets_owner(self):
        self.assertEqual(parse_peer_uid(PROC_NET_TCP, 40000, 8765), 2001)

    def test_unknown_connection(self):
        self.assertIsNone(parse_peer_uid(PROC_NET_TCP, 40001, 8765))
        self.assertIsNone(parse_peer_uid("header only\n", 40000, 8765))


class FakeUid:
    """Stand-in for /proc/net/tcp: the test sets which OS user the next request comes from."""

    def __init__(self):
        self.uid = None

    def __call__(self, client_port, server_port):
        return self.uid


class BindingTests(unittest.TestCase):
    def setUp(self, require_isolation=False):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.match = Match(MatchConfig(seats=("alice", "bob"), deals=2, require_isolation=require_isolation),
                           d / "run")
        self.match.engine_uid = 1000
        self.tokens = write_tokens(("alice", "bob"), d / "tokens")
        self.uid = FakeUid()
        self.srv = make_server(self.match, self.tokens, "127.0.0.1", 0, uid_of=self.uid)
        self.url = f"http://127.0.0.1:{self.srv.server_port}"
        threading.Thread(target=self.srv.serve, daemon=True).start()
        self.run_dir = d / "run"

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def as_user(self, uid, token=None, seat=None):
        self.uid.uid = uid
        return Client(self.url, token if token is not None else "", seat=seat)

    def integrity(self):
        path = self.run_dir / "integrity.jsonl"
        return [json.loads(l) for l in path.read_text().splitlines()] if path.exists() else []

    def test_stolen_token_from_another_user_is_rejected(self):
        self.as_user(2001, self.tokens["alice"]).state()  # binds alice -> 2001
        with self.assertRaises(ApiError) as e:
            self.as_user(2002, self.tokens["alice"]).state()
        self.assertEqual(e.exception.status, 403)
        events = [e for e in self.integrity() if e["type"] == "token_uid_mismatch"]
        self.assertEqual(events[0]["bound_uid"], 2001)
        self.assertEqual(events[0]["uid"], 2002)

    def test_tokenless_claims_bind_seats_and_isolation_is_enforced(self):
        self.as_user(2001, seat="alice").state()
        self.as_user(2002, seat="bob").state()
        self.assertEqual(self.match.status, "running")
        iso = self.match.spectate()["isolation"]
        self.assertTrue(iso["enforced"], iso)
        self.assertEqual(iso["seat_uids"], {"alice": 2001, "bob": 2002})
        # Afterwards the OS user alone identifies the seat.
        self.assertEqual(self.as_user(2001).state()["you"]["seat"], "alice")

    def test_claiming_a_taken_seat_or_the_other_seat_is_refused_and_logged(self):
        self.as_user(2001, seat="alice").state()
        with self.assertRaises(ApiError) as e:
            self.as_user(2002, seat="alice").state()
        self.assertEqual(e.exception.status, 409)
        with self.assertRaises(ApiError) as e:
            self.as_user(2001, seat="bob").state()
        self.assertEqual(e.exception.status, 403)
        types = [e["type"] for e in self.integrity()]
        self.assertIn("claim_rejected", types)
        self.assertIn("claim_other_seat", types)

    def test_unauthenticated_requests_are_refused(self):
        with self.assertRaises(ApiError) as e:
            self.as_user(2003).state()
        self.assertEqual(e.exception.status, 401)
        with self.assertRaises(ApiError):
            self.as_user(2003, token="forged").state()
        self.assertIn("invalid_token", [e["type"] for e in self.integrity()])
        # A wrong token is refused even from a user that holds a seat.
        self.as_user(2001, seat="alice").state()
        with self.assertRaises(ApiError) as e:
            self.as_user(2001, token="forged").state()
        self.assertEqual(e.exception.status, 401)

    def test_shared_or_root_users_are_reported_as_not_isolated(self):
        self.as_user(0, self.tokens["alice"]).state()
        self.as_user(0, self.tokens["bob"]).state()
        iso = self.match.spectate()["isolation"]
        self.assertFalse(iso["enforced"])
        self.assertIn("a seat runs as root", iso["problems"])
        self.assertIn("both seats run as the same OS user", iso["problems"])
        run = json.loads((self.run_dir / "run.json").read_text())
        self.assertFalse(run["isolation"]["enforced"])


class RequireIsolationTests(BindingTests):
    def setUp(self):
        super().setUp(require_isolation=True)

    def test_match_waits_until_isolated(self):
        self.as_user(1000, self.tokens["alice"]).state()  # same user as the engine
        view = self.as_user(2002, self.tokens["bob"]).state()
        self.assertEqual(self.match.status, "waiting_for_players")
        self.assertIn("engine's OS user", view["waiting_reason"])

    # The inherited tests that expect play to start are not meaningful here.
    test_tokenless_claims_bind_seats_and_isolation_is_enforced = None
    test_shared_or_root_users_are_reported_as_not_isolated = None


if __name__ == "__main__":
    unittest.main()
