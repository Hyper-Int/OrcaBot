# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-seat-v10-seat-users
"""An agent seat runs as its own OS user with a private home (seat.sh agent), so agents
can't read each other's live transcripts (hole cards, reasoning) or the engine's files:
every Orcabot terminal is root with one shared HOME. Each start archives the seat's
earlier conversations (no memory of earlier games) and syncs the login with the shared
home. Run here without root: a fake setpriv records what would run."""

import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class SeatUserTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.pub, self.root, self.shared, self.etc, self.bin = t / "pub", t / "pb", t / "home", t / "etc", t / "bin"
        for d in (self.pub, self.shared, self.etc, self.bin):
            d.mkdir()
        (self.pub / "seats.json").write_text(json.dumps({"by_pty": {"pty-1": "sonnet", "pty-2": "fable"}}, indent=1))
        (self.etc / "passwd").write_text("root:x:0:0::/root:/bin/bash\n")
        (self.etc / "group").write_text("root:x:0:\n")
        self.log = t / "setpriv.log"
        # Fake setpriv: records its arguments and the HOME it would give, then exits.
        (self.bin / "setpriv").write_text(f'#!/bin/sh\necho "$*" >> {self.log}\n')
        (self.bin / "claude").write_text("#!/bin/sh\n")
        (self.bin / "agy").write_text("#!/bin/sh\n")
        for f in ("setpriv", "claude", "agy"):
            (self.bin / f).chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def launch(self, vendor, *argv, pty="pty-1"):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.shared), "POKER_PUB": str(self.pub),
               "POKER_SEATS_ROOT": str(self.root), "POKER_PASSWD_DIR": str(self.etc), "POKER_TEST_ROOT": "1",
               "POKER_TEST_CHOWN": "true", "ORCABOT_PTY_ID": pty}
        r = subprocess.run(["bash", str(ROOT / "bin" / "seat"), "agent", vendor, "--", *argv],
                           env=env, capture_output=True, text=True, timeout=30)
        time.sleep(0.3)  # the helper loop runs in the background
        return r

    def test_claude_seat_gets_its_own_user_home_and_login(self):
        creds = self.shared / ".claude/.credentials.json"
        creds.parent.mkdir(parents=True)
        creds.write_text('{"token": "shared"}')
        (self.shared / ".claude.json").write_text('{"hasCompletedOnboarding": true}')
        r = self.launch("anthropic", "claude", "--model", "sonnet")
        self.assertEqual(r.returncode, 0, r.stderr)
        uids = json.loads((self.root / "uids.json").read_text())
        self.assertEqual(uids, {"sonnet": 3000})
        self.assertIn("pokerseat-3000:x:3000:3000:PokerBench seat sonnet:", (self.etc / "passwd").read_text())
        home = self.root / "seats" / "sonnet"
        self.assertEqual(oct(home.stat().st_mode & 0o777), "0o700")
        self.assertEqual((home / ".claude/.credentials.json").read_text(), '{"token": "shared"}')
        self.assertTrue((home / ".claude.json").exists())
        runs = self.log.read_text().splitlines()
        agent = [l for l in runs if l.endswith("claude --model sonnet")]
        helper = [l for l in runs if "seat.sh helper anthropic" in l]
        self.assertEqual(len(agent), 1, runs)
        self.assertEqual(len(helper), 1, runs)
        for line in agent + helper:
            self.assertIn("--reuid=3000 --regid=3000 --clear-groups env HOME=" + str(home), line)

        # A second seat gets the next uid; the first keeps its own.
        self.launch("anthropic", "claude", pty="pty-2")
        self.assertEqual(json.loads((self.root / "uids.json").read_text()), {"fable": 3001, "sonnet": 3000})

    def test_restart_archives_earlier_conversations_and_hands_back_a_newer_login(self):
        self.launch("anthropic", "claude")
        home = self.root / "seats" / "sonnet"
        (home / ".claude/projects/-workspace").mkdir(parents=True)
        (home / ".claude/projects/-workspace/s.jsonl").write_text("game 1 hole cards")
        time.sleep(1.1)
        (home / ".claude/.credentials.json").parent.mkdir(parents=True, exist_ok=True)
        (home / ".claude/.credentials.json").write_text('{"token": "refreshed by the seat"}')
        self.launch("anthropic", "claude")
        self.assertFalse((home / ".claude/projects").exists(), "the earlier conversation must be gone")
        archived = list((self.root / "archive" / "sonnet").glob("*/.claude/projects/-workspace/s.jsonl"))
        self.assertEqual(len(archived), 1)
        self.assertEqual(oct((self.root / "archive").stat().st_mode & 0o777), "0o700")
        self.assertEqual((self.shared / ".claude/.credentials.json").read_text(), '{"token": "refreshed by the seat"}')

    def test_antigravity_gets_its_own_log_file(self):
        tok = self.shared / ".gemini/antigravity-cli/antigravity-oauth-token"
        tok.parent.mkdir(parents=True)
        tok.write_text("t")
        self.launch("antigravity", "agy", "--model", "Gemini 4 Argon (Medium)")
        home = self.root / "seats" / "sonnet"
        self.assertTrue((home / ".gemini/antigravity-cli/antigravity-oauth-token").exists())
        agent = [l for l in self.log.read_text().splitlines() if " agy " in f" {l} "]
        self.assertTrue(agent and agent[0].endswith(
            f"--log-file {home}/.gemini/antigravity-cli/log/seat-pty-1.log"), agent)

    def test_without_setpriv_it_runs_as_before(self):
        (self.bin / "setpriv").unlink()
        marker = Path(self.tmp.name) / "ran"
        (self.bin / "claude").write_text(f"#!/bin/sh\ntouch {marker}\n")
        r = self.launch("anthropic", "claude")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(marker.exists())
        self.assertFalse((self.root / "uids.json").exists())


if __name__ == "__main__":
    unittest.main()
