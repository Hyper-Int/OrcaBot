# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Agent-block seats: the sandbox's local agent API (faked here with the same routes
and secret check as the TCP path) and a seat playing through it."""

import json
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pokerbench.agentlink import AgentLinkClient, AgentLinkSeat
from pokerbench.llm import ProviderError

AGENT = "orca:o/agent:grok"
SECRET = "pty-secret"


class FakeSandbox(BaseHTTPRequestHandler):
    """The sandbox's /sessions/{s}/ptys/{p}/agents API for one connected agent that
    answers each message with a canned reply (or, when told, with chatter first)."""

    msgs: list = []
    replies: list = []
    fail_next = 0  # answer this many requests with the control-plane hiccup (502 E79965)

    def log_message(self, *a):
        pass

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        if self.headers.get("X-MCP-Secret") != SECRET:
            return self._send(403, {"error": "E79851: bad secret"})
        u = urllib.parse.urlparse(self.path)
        prefix = "/sessions/sess-1/ptys/pty-1/agents"
        if not u.path.startswith(prefix):
            return self._send(404, {"error": "not found"})
        action = u.path[len(prefix):].strip("/")
        q = dict(urllib.parse.parse_qsl(u.query))
        if FakeSandbox.fail_next > 0:
            FakeSandbox.fail_next -= 1
            return self._send(502, {"error": "E79965: couldn't ask the control plane"})
        if action == "" and self.command == "GET":
            return self._send(200, {"agents": [{"identity": AGENT, "name": "Grok", "itemId": "i1"}], "status": "ready"})
        if action == "send" and self.command == "POST":
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if body["agent"] != AGENT:
                return self._send(403, {"error": "E79964: this terminal isn't connected to that agent"})
            seq = len(self.msgs) + 1
            self.msgs.append({"seq": seq, "from": "me", "text": body["text"]})
            for r in self.replies.pop(0) if self.replies else []:
                self.msgs.append({"seq": len(self.msgs) + 1, "from": "agent", "text": r})
            return self._send(200, {"seq": seq})
        if action == "messages":
            after = int(q.get("after", 0))
            return self._send(200, {"messages": [m for m in self.msgs if m["seq"] > after], "status": "ready"})
        return self._send(404, {"error": "unknown"})

    do_GET = do_POST = _route


class AgentLinkTests(unittest.TestCase):
    def setUp(self):
        FakeSandbox.msgs, FakeSandbox.replies, FakeSandbox.fail_next = [], [], 0
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeSandbox)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.env = {"ORCABOT_SESSION_ID": "sess-1", "ORCABOT_PTY_ID": "pty-1", "ORCABOT_MCP_SECRET": SECRET,
                    "ORCABOT_MCP_PORT": str(self.srv.server_address[1])}

    def tearDown(self):
        self.srv.shutdown()

    def client(self, **env):
        return AgentLinkClient(sock="/nonexistent.sock", env={**self.env, **env})

    def test_lists_connected_agents(self):
        self.assertEqual(self.client().agents()[0]["identity"], AGENT)

    def test_wrong_secret_is_refused(self):
        with self.assertRaises(ProviderError):
            self.client(ORCABOT_MCP_SECRET="wrong").agents()

    def test_outside_orcabot_is_a_clear_error(self):
        with self.assertRaises(SystemExit):
            AgentLinkClient(sock="/nonexistent.sock", env={})

    def test_a_turn_through_the_agent(self):
        FakeSandbox.replies = [["thinking about it...", 'I raise. {"reason":"strong","action":"raise","amount":600}']]
        seat = AgentLinkSeat(AGENT, reply_timeout=10, client=self.client())
        d = seat.decide("INTRO", ["No hands have finished yet.", "CURRENT HAND\nHand 1/4"])
        self.assertEqual((d.action, d.amount, d.reason), ("raise", 600, "strong"))
        sent = FakeSandbox.msgs[0]["text"]
        self.assertTrue(sent.startswith("INTRO") and "CURRENT HAND" in sent)
        # Next turn: no intro again, and only replies after this message count.
        FakeSandbox.replies = [['{"action":"check","amount":0,"reason":"free card"}']]
        d2 = seat.decide("INTRO", ["Hand 1 (level 1)\n...", "CURRENT HAND\nHand 2/4"])
        self.assertEqual(d2.action, "check")
        self.assertNotIn("INTRO", FakeSandbox.msgs[-2]["text"])
        self.assertIn("Since your last turn", FakeSandbox.msgs[-2]["text"])

    def test_a_control_plane_hiccup_doesnt_lose_the_turn(self):
        # 2026-11-20: a ~20s hiccup failed both tries within milliseconds, three hands running.
        FakeSandbox.fail_next = 2
        FakeSandbox.replies = [['{"turn": 1, "reason":"ok","action":"call","amount":0}']]
        seat = AgentLinkSeat(AGENT, reply_timeout=30, client=self.client())
        seat.turn = 1
        d = seat.decide("INTRO", ["CURRENT HAND\nHand 1/4"])
        self.assertEqual(d.action, "call")
        # A refusal isn't retried.
        with self.assertRaises(ProviderError):
            AgentLinkSeat("orca:o/agent:muse", reply_timeout=30, client=self.client()).decide("I", ["CURRENT HAND"])

    def test_late_answers_are_picked_up_without_waiting(self):
        FakeSandbox.replies = [[]]
        seat = AgentLinkSeat(AGENT, reply_timeout=2, client=self.client())
        with self.assertRaises(ProviderError):
            seat.decide("INTRO", ["CURRENT HAND\n..."])
        FakeSandbox.msgs.append({"seq": len(FakeSandbox.msgs) + 1, "from": "agent", "text": '{"turn": 0, "action": "fold"}'})
        started = time.monotonic()
        self.assertEqual(len(seat._pending()), 1)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(seat._pending(), [])

    def test_no_reply_times_out(self):
        seat = AgentLinkSeat(AGENT, reply_timeout=2, client=self.client())
        with self.assertRaises(ProviderError) as e:
            seat.decide("INTRO", ["CURRENT HAND\n..."])
        self.assertIn("no reply", str(e.exception))

    def test_an_agent_not_connected_is_refused(self):
        seat = AgentLinkSeat("orca:o/agent:muse", reply_timeout=2, client=self.client())
        with self.assertRaises(ProviderError) as e:
            seat.decide("INTRO", ["CURRENT HAND\n..."])
        self.assertIn("isn't connected", str(e.exception))


if __name__ == "__main__":
    unittest.main()
