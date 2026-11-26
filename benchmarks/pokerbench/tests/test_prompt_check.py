"""The seat helper gives an agent the game prompt only once it has drawn its input box,
and checks the prompt took (the seat used `poker`). 2026-11-23: a restarted Antigravity
terminal got its prompt 1s after launch, before agy could take it, and sat idle at its
empty input box while its turns timed out. A prompt that took and an agent that then
stalls are left alone: that is the model's doing, and part of what is measured."""

import json
import re
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pokerbench.engine import Match, MatchConfig
from pokerbench.report import _stalls
from pokerbench.screen import agent_state

ROOT = Path(__file__).resolve().parents[1]
SEAT = ROOT / "bin" / "seat"

AGY_IDLE = """▄▀▀▄        Antigravity CLI 1.5.15
─────────────────────────────────────────────────────────────────
>
─────────────────────────────────────────────────────────────────
? for shortcuts  auto · Gemini 4 Neon · high"""
AGY_WORKING = """  End.
⣻  Working...
─────────────────────────────────────────────────────────────────
>
─────────────────────────────────────────────────────────────────
esc to cancel                      auto · Gemini 4 Neon · high"""
CLAUDE_IDLE = """╭──────────────────────────────────────╮
│ > Try "write a test for seat.sh"     │
╰──────────────────────────────────────╯
  ? for shortcuts"""
CODEX_IDLE = """› Ask Codex to do anything

  100% context left · ? for shortcuts"""
CODEX_WORKING = "• Working (12s • esc to interrupt)\n\n› Ask Codex to do anything"
PASTED_TOO_EARLY = """[seat] REVISION: pokerbench-seat-v11: seat neon runs as pokerseat-3007
You are playing a 10-player no-limit Texas hold'em game against 9 other players"""


class AgentStateTests(unittest.TestCase):
    def test_states(self):
        self.assertEqual(agent_state(AGY_IDLE), "idle")
        self.assertEqual(agent_state(AGY_WORKING), "working")
        self.assertEqual(agent_state(CLAUDE_IDLE), "idle")
        self.assertEqual(agent_state(CODEX_IDLE), "idle")
        self.assertEqual(agent_state(CODEX_WORKING), "working")
        self.assertEqual(agent_state(PASTED_TOO_EARLY), "starting")
        self.assertEqual(agent_state(""), "starting")
        self.assertEqual(agent_state("Do you trust the files in this folder?\n> 1. Yes"), "question")


class Fake(BaseHTTPRequestHandler):
    """Both sides: the terminal (/screen, /input) and the engine (/api/seat/...)."""
    state: dict = {}

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200, headers=()):
        body = json.dumps(obj).encode() if not isinstance(obj, bytes) else obj
        self.send_response(code)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        st = Fake.state
        if self.path == "/screen":
            screen = st["screens"][min(st["polls"], len(st["screens"]) - 1)]
            st["polls"] += 1
            self._json(screen.replace("\n", "\r\n").encode(), headers=(("X-Screen-Rows", "30"), ("X-Screen-Cols", "80")))
        elif self.path == "/api/seat/activity":
            if not st["engine_new"]:
                return self._json({"error": "not_found"}, 404)
            t = st.get("played_at")
            self._json({"last_play_s_ago": None if t is None else round(time.time() - t, 1)})
        else:
            self._json({}, 404)

    def do_POST(self):
        st = Fake.state
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path == "/input":
            st["inputs"].append(json.loads(body))
            n = len(st["inputs"])
            if n in st["takes_on"]:  # this one reaches the agent: it starts playing
                st["played_at"] = time.time() + 0.5
        elif self.path == "/api/seat/prompted":
            st["prompted"].append(json.loads(body))
        self._json({"ok": True})


def give_prompt(screens, takes_on, engine_new=True, rejoin="1"):
    Fake.state = {"screens": screens, "polls": 0, "inputs": [], "prompted": [], "takes_on": takes_on,
                  "engine_new": engine_new}
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        with tempfile.TemporaryDirectory() as pub:
            shutil.copy(ROOT / "pokerbench" / "screen.py", Path(pub) / "seat_screen.py")
            (Path(pub) / "prompt.txt").write_text("Play poker.\n")
            src = SEAT.read_text()
            fns = "\n".join(re.search(rf"^{n}\(\) \{{.*?^\}}", src, re.S | re.M).group(0)
                            for n in ("api", "own", "waiting_on", "type_in", "wait_input_box", "last_play_ago",
                                      "took", "give_prompt"))
            script = ("sleep() { command sleep 0.05; }\nscreen_sum= WAIT_Q= AGENT_STATE=\nPROMPT_CHECK_S=2\n" + fns +
                      f'\ngive_prompt "$PUB/prompt.txt" "" "Note: under way." {rejoin}\n')
            r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=120,
                               env={"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "PUB": pub,
                                    "POKER_OWN_URL": url, "POKER_URL": url, "SEAT": "neon",
                                    "POKER_TOKENS_DIR": pub})
            return r, Fake.state
    finally:
        srv.shutdown()
        srv.server_close()


class GivePromptTests(unittest.TestCase):
    def test_waits_for_the_input_box_then_types_once(self):
        r, st = give_prompt([PASTED_TOO_EARLY] * 3 + [AGY_IDLE], takes_on={1})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(st["inputs"]), 1)
        self.assertGreaterEqual(st["polls"], 5)  # it waited for the box (twice in a row)
        self.assertIn("Note: under way.", st["inputs"][0]["text"])
        self.assertEqual(st["prompted"], [{"attempt": 1, "rejoin": True}])

    def test_a_lost_prompt_is_typed_again(self):
        r, st = give_prompt([AGY_IDLE], takes_on={2})
        self.assertEqual(len(st["inputs"]), 2, r.stdout)
        self.assertIn("typing it again", r.stdout)
        self.assertEqual([p["attempt"] for p in st["prompted"]], [1, 2])

    def test_a_busy_agent_is_not_prompted_again(self):
        # It got the prompt and is working (or looping) without using `poker`: left alone.
        r, st = give_prompt([AGY_IDLE, AGY_IDLE, AGY_WORKING], takes_on=set())
        self.assertEqual(len(st["inputs"]), 1, r.stdout)

    def test_gives_up_after_three(self):
        r, st = give_prompt([CODEX_IDLE], takes_on=set())
        self.assertEqual(len(st["inputs"]), 3)
        self.assertIn("after 3 tries", r.stdout)

    def test_an_older_engine_is_not_checked(self):
        r, st = give_prompt([CLAUDE_IDLE], takes_on=set(), engine_new=False)
        self.assertEqual(len(st["inputs"]), 1)


class EngineTests(unittest.TestCase):
    def test_activity_and_prompt_events(self):
        with tempfile.TemporaryDirectory() as d:
            now = [100.0]
            m = Match(MatchConfig(seats=("a", "b"), deals=4, start="manual"), Path(d) / "run", clock=lambda: now[0])
            self.assertEqual(m.seat_activity("a"), {"last_play_s_ago": None})
            m.join("a")
            now[0] += 7.5
            self.assertEqual(m.seat_activity("a"), {"last_play_s_ago": 7.5})
            m.prompt_given("a", 2, True)
            ev = [json.loads(l) for l in (Path(d) / "run" / "events.jsonl").read_text().splitlines()]
            self.assertTrue(any(e["type"] == "prompt_given" and e["attempt"] == 2 and e["rejoin"] for e in ev))
            self.assertEqual(m.prompt_given("zz"), {"ok": False})


class StallTests(unittest.TestCase):
    def test_longest_run_and_restarts(self):
        ds = [{"hand": h, "timed_out": t} for h, t in [(1, False), (2, True), (3, True), (4, False),
                                                       (5, True), (6, True), (7, True), (8, False)]]
        ev = [{"type": "sitting_out", "seat": "neon"}, {"type": "prompt_given", "seat": "neon", "attempt": 1,
                                                        "rejoin": True, "hand": 66},
              {"type": "prompt_given", "seat": "neon", "attempt": 2, "rejoin": True, "hand": 66},
              {"type": "prompt_given", "seat": "opus", "attempt": 1, "rejoin": False, "hand": 1}]
        st = _stalls("neon", ds, ev)
        self.assertEqual(st["longest_timeout_run"], 3)
        self.assertEqual(st["longest_timeout_hands"], [5, 7])
        self.assertEqual(st["sat_out"], 1)
        self.assertEqual(st["terminal_restarts"], [66])
        self.assertEqual(st["prompt_retyped"], 1)


if __name__ == "__main__":
    unittest.main()
