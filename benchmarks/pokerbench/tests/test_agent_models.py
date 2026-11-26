# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-report-v19-recovered-agents
"""Which model each agent terminal's agent used, read from the agent's own logs by its
seat helper and reported to the engine; the report says it. From the 2026-11-22 games:
nothing recorded that Gemini CLI's "Auto" ran every request on gemini-3.8-flash, or that
Claude Code ran at effort medium."""

import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

from pokerbench import agentlogs, cli
from pokerbench.engine import Match, MatchConfig, clean_agent_info
from pokerbench.report import _agent_lines, agent_summary, build, off_api_requests
from pokerbench.server import make_server

SINCE = "2026-11-22T23:53:23Z"
BEFORE, DURING = "2026-11-22T17:50:00.000Z", "2026-11-22T23:54:00.500Z"


def _write(path: Path, lines: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(x) + "\n" for x in lines) + "not json\n", encoding="utf-8")


def fake_home(root: Path) -> Path:
    """Logs shaped like the real ones (2026-11-22 VM), with a previous game's entries too."""
    _write(root / ".claude/projects/-workspace/s1.jsonl", [
        {"type": "api-request", "timestamp": BEFORE, "version": "2.1.300",
         "params": {"model": "claude-sonnet-5-5", "output_config": {"effort": "high"}}},
        {"type": "user", "timestamp": DURING, "version": "2.1.330", "message": {"content": "poker"}},
        *[{"type": "api-request", "timestamp": DURING, "version": "2.1.330",
           "params": {"model": "claude-opus-5-5", "output_config": {"effort": "medium"}}}] * 3,
        {"type": "api-request", "timestamp": DURING, "version": "2.1.330", "params": {"model": "claude-haiku-5-5"}},
        {"type": "assistant", "timestamp": DURING, "message": {"model": "claude-opus-5-5"}},
    ])
    _write(root / ".codex/sessions/2026/11/22/rollout-2026-11-22T23-46-06-x.jsonl", [
        {"type": "session_meta", "timestamp": "2026-11-22T23:46:06Z", "payload": {"cli_version": "0.171.0"}},
        {"type": "turn_context", "timestamp": BEFORE, "payload": {"model": "gpt-6.1"}},
        {"type": "turn_context", "timestamp": DURING, "payload": {
            "model": "gpt-6.2-sol", "collaboration_mode": {"mode": "default", "settings": {"reasoning_effort": None}}}},
        {"type": "turn_context", "timestamp": DURING, "payload": {"model": "gpt-6.2-sol", "effort": "high"}},
    ])
    _write(root / ".gemini/tmp/workspace/chats/session-2026-11-22T23-46-1.jsonl", [
        {"type": "user", "timestamp": DURING, "content": "poker"},
        *[{"type": "gemini", "timestamp": DURING, "model": "gemini-3.8-flash"}] * 4,
        {"type": "gemini", "timestamp": BEFORE, "model": "gemini-3.8-pro"},
    ])
    return root


class AgentLogsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = fake_home(Path(self.tmp.name))
        self.since = agentlogs._ts(SINCE)

    def tearDown(self):
        self.tmp.cleanup()

    def test_claude_code(self):
        self.assertEqual(agentlogs.read("claude-code", str(self.home), self.since), {
            "models": {"claude-opus-5-5": 3, "claude-haiku-5-5": 1}, "unit": "requests",
            "effort": "medium 3, default 1", "version": "2.1.330"})

    def test_codex(self):
        self.assertEqual(agentlogs.read("codex", str(self.home), self.since), {
            "models": {"gpt-6.2-sol": 2}, "unit": "turns", "effort": "default 1, high 1", "version": "0.171.0"})

    def test_gemini_cli_only_counts_this_game(self):
        info = agentlogs.read("gemini-cli", str(self.home), self.since)
        self.assertEqual(info["models"], {"gemini-3.8-flash": 4})
        self.assertEqual(info["unit"], "responses")

    def test_nothing_yet_and_old_files(self):
        old = time.time() - 86400
        for dirpath, _, files in os.walk(self.home):
            for f in files:
                os.utime(os.path.join(dirpath, f), (old, old))
        self.assertEqual(agentlogs.read("gemini-cli", str(self.home), self.since).get("models"), None)
        with tempfile.TemporaryDirectory() as empty:
            self.assertEqual(agentlogs.read("codex", empty, self.since), {"unit": "turns"})


class EngineAndReportTests(unittest.TestCase):
    def test_clean_agent_info(self):
        self.assertEqual(clean_agent_info({"models": {"gpt-6.2-sol": 7, "x\nInjected<b>": 1, "bad": "7"},
                                           "effort": "default", "version": "0.171.0", "extra": "dropped"}),
                         {"models": {"gpt-6.2-sol": 7, "xInjectedb": 1}, "effort": "default", "version": "0.171.0"})
        self.assertEqual(clean_agent_info({"effort": "high"}), {})  # no models: nothing
        self.assertEqual(clean_agent_info("nope"), {})

    def test_seat_reports_over_http_and_the_report_says_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = Match(MatchConfig(seats=("a", "b"), deals=4, require_join=False), Path(tmp) / "run")
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0))
                port = s.getsockname()[1]
            srv = make_server(m, {"a": "ta", "b": "tb"}, port=port)
            threading.Thread(target=srv.serve, daemon=True).start()
            try:
                client = cli.Client(url=f"http://127.0.0.1:{port}", token="ta")
                info = {"models": {"gemini-3.8-flash": 709}, "unit": "responses", "version": "0.70.0"}
                self.assertEqual(client._req("POST", "/api/seat/agent", info), {"ok": True})
                client._req("POST", "/api/seat/agent", info)  # unchanged: not logged again
            finally:
                srv.shutdown()
            self.assertEqual(m.agent_info, {"a": info})
            self.assertEqual(m._run_info()["agent_info"], {"a": info})
            events = [json.loads(x) for x in (Path(tmp) / "run" / "events.jsonl").read_text().splitlines()]
            self.assertEqual(len([e for e in events if e["type"] == "agent_info"]), 1)

        self.assertEqual(off_api_requests([{"method": "POST", "path": "/api/seat/agent", "seat": "a"}]), [])
        self.assertEqual(agent_summary({"models": {"claude-opus-5-5": 112}, "unit": "requests", "effort": "medium",
                                        "version": "2.1.330"}),
                         "claude-opus-5-5 (112 requests), effort medium, v2.1.330")
        rep = {"seats": {"a": {"agent": info}, "b": {"agent": None}}}
        self.assertEqual(_agent_lines(rep), ["- Agents (from each agent's own logs, as its seat reported them): "
                                             "a: gemini-3.8-flash (709 responses), v0.70.0"])
        self.assertEqual(_agent_lines({"seats": {"b": {}}}), [])


    def test_the_report_uses_recovered_agent_info_where_a_seat_reported_none(self):
        # Codex seats before pokerbench-seat-v15 reported only in a helper's first game.
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            m = Match(MatchConfig(seats=("a", "b"), deals=4, require_join=False), run)
            live = {"models": {"claude-opus-5-5": 9}, "unit": "requests", "effort": "medium"}
            (run / "run.json").write_text(json.dumps({**json.loads((run / "run.json").read_text()),
                                                      "agent_info": {"a": live}}))
            (run / "agent_info_recovered.json").write_text(json.dumps({
                "a": {"models": {"wrong": 1}, "effort": "low"},  # a reported: its own report wins
                "b": {"models": {"gpt-6.2-astra": 1}, "unit": "turns", "effort": "medium", "note": "from its log"},
                "_note": "recovered"}))
            rep = build(run)
        self.assertEqual(rep["seats"]["a"]["agent"]["models"], {"claude-opus-5-5": 9})
        self.assertEqual(rep["seats"]["b"]["agent"],
                         {"models": {"gpt-6.2-astra": 1}, "unit": "turns", "effort": "medium", "recovered": True})
        self.assertEqual(agent_summary(rep["seats"]["b"]["agent"]),
                         "gpt-6.2-astra (1 turns), effort medium, read from its log afterwards")

if __name__ == "__main__":
    unittest.main()
