# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-seat-v8-antigravity
"""Antigravity CLI (agy) seats: Gemini CLI's successor for Google AI plans (it stopped
serving them on 2026-06-18). Its models are labels with spaces ("Gemini 4 Argon
(Medium)"); the helper reads which one it used from the seat's own agy log; its setup
screens (login menu, sign-in code, trust) hold the prompt back."""

import json
import os
import tempfile
import unittest
from pathlib import Path

from pokerbench import agentlogs
from pokerbench.engine import clean_agent_info
from pokerbench.players import PlayerError, label, normalize
from pokerbench.screen import render, waiting_question

ROOT = Path(__file__).resolve().parents[1]

# Shaped like agy 1.5.15's log on the 2026-11-23 VM.
LOG = """\
I1123 14:12:31.000001       1 main.go:10] starting
I1123 14:12:33.100000     227 model_config_manager.go:375] Propagating selected model override to backend: label="Gemini 4 Neon (High)"
I1123 14:12:40.000000     227 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x1
I1123 14:20:30.834239     772 model_resolver.go:107] Resolving model Gemini 4 Argon (Medium)
I1123 14:20:31.000000     772 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x2
I1123 14:20:35.000000     772 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse Trace: 0x3
I1123 14:20:36.000000     772 http_helpers.go:748] URL: https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist Trace: 0x4
"""


class AntigravityTests(unittest.TestCase):
    def test_player_with_a_model_label(self):
        p = normalize({"kind": "antigravity-cli", "model": "Gemini 4 Argon (Medium)"})
        self.assertEqual(p, {"kind": "antigravity-cli", "model": "Gemini 4 Argon (Medium)"})
        self.assertIn("Antigravity CLI", label(p))
        with self.assertRaises(PlayerError):
            normalize({"kind": "antigravity-cli", "model": 'x"; rm -rf /'})

    def test_model_from_the_seats_own_log(self):
        with tempfile.TemporaryDirectory() as home:
            logdir = Path(home) / ".gemini/antigravity-cli/log"
            logdir.mkdir(parents=True)
            (logdir / "seat-pty-1.log").write_text(LOG)
            (logdir / "cli-20261123_141230.log").write_text(LOG.replace("Argon", "Krypton"))  # another agy
            since = agentlogs._ts("2026-11-23T14:15:00Z")
            info = agentlogs.antigravity_cli(home, since, pty_id="pty-1")
            self.assertEqual(info["models"], {"Gemini 4 Argon": 2})  # Neon's request was before the game
            self.assertEqual(info["effort"], "medium")
            self.assertEqual(info["unit"], "requests")
            # No log of its own (an agy started by hand): the shared logs.
            shared = agentlogs.antigravity_cli(home, since, pty_id="pty-other")
            self.assertEqual(shared["models"], {"Gemini 4 Krypton": 2})
        self.assertEqual(clean_agent_info({"models": {"Gemini 4 Argon": 2}})["models"], {"Gemini 4 Argon": 2})

    def test_setup_screens_hold_the_prompt_back(self):
        login = "\x1b[2J\x1b[H Select login method\r\n > 1. Google OAuth\r\n   2. Use a Google Cloud project"
        self.assertTrue(waiting_question(render(login)))
        code = "Open this URL in your local browser to sign in:\r\nhttps://accounts.google.com/...\r\nPaste the authorization code below:"
        self.assertTrue(waiting_question(render(code)))
        trust = "Do you trust the contents of this project?\r\n > Yes, I trust this folder"
        self.assertTrue(waiting_question(render(trust)))
        self.assertEqual(waiting_question(render("> Ask anything  (/ for commands)")), "")

    def test_template_seat(self):
        items = json.loads((ROOT / "template.json").read_text())["items"]
        contents = [json.loads(i["content"]) for i in items
                    if isinstance(i.get("content"), str) and i["content"].startswith("{")]
        boots = {c["name"]: c.get("bootCommand", "") for c in contents if "name" in c}
        boot = boots["Antigravity CLI"]
        # The launcher (seat.sh agent) adds its log file and says how to install agy if missing.
        self.assertIn('exec bash /tmp/pokerbench/seat.sh agent antigravity -- agy ${MODEL:+--model "$MODEL"} '
                      '--dangerously-skip-permissions', boot)


if __name__ == "__main__":
    unittest.main()
