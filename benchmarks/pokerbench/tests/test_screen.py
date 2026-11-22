# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

"""Rendering an agent terminal's raw output: a setup question that was answered (and
redrawn over) must not count, one still on the screen must."""

import unittest

from pokerbench.screen import Screen, render, waiting_question

ERASE_UP = "\x1b[2K\x1b[1A"


class ScreenTests(unittest.TestCase):
    def test_an_answered_question_is_gone_from_the_screen(self):
        # Ink (Claude Code, Gemini CLI) erases its previous frame line by line, then redraws.
        dialog = "Do you trust the files in this folder?\r\n 1. Yes, proceed\r\n 2. No, exit"
        before = "Welcome\r\n" + dialog
        self.assertEqual(waiting_question(render(before)), "do you trust the files")
        after = before + ERASE_UP * 2 + "\x1b[2K\x1b[G" + "> \r\n  ? for shortcuts"
        screen = render(after)
        self.assertEqual(waiting_question(screen), "", screen)
        self.assertIn("? for shortcuts", screen)
        self.assertIn("Welcome", screen)

    def test_absolute_positioning_and_clear(self):
        # ratatui (Codex) positions every cell and clears.
        raw = "\x1b[5;3HSign in with ChatGPT\x1b[6;3HSign in with Device Code"
        self.assertEqual(waiting_question(render(raw, 20, 80)), "sign in with chatgpt")
        raw += "\x1b[2J\x1b[1;1H▌ Ask Codex to do anything"
        screen = render(raw, 20, 80)
        self.assertEqual(waiting_question(screen), "")
        self.assertEqual(screen.splitlines()[0], "▌ Ask Codex to do anything")

    def test_alternate_screen(self):
        raw = "main text\x1b[?1049h\x1b[HHow would you like to authenticate?"
        self.assertEqual(waiting_question(render(raw)), "how would you like to authenticate")
        self.assertEqual(waiting_question(render(raw + "\x1b[?1049l")), "")
        self.assertIn("main text", render(raw + "\x1b[?1049l"))

    def test_wrap_scroll_and_line_edits(self):
        s = Screen(3, 10).feed("0123456789AB")
        self.assertEqual(s.text().splitlines(), ["0123456789", "AB"])
        s = Screen(3, 10).feed("a\r\nb\r\nc\r\nd")
        self.assertEqual(s.text().splitlines(), ["b", "c", "d"])  # scrolled
        s = Screen(3, 10).feed("hello\x1b[1;2H\x1b[2P")
        self.assertEqual(s.text(), "hlo")
        s = Screen(3, 10).feed("abc\x1b[1;1H\x1b[K")
        self.assertEqual(s.text(), "")

    def test_garbage_and_partial_sequences_do_not_crash(self):
        render(b"\x9b[2;\x1b[\x1b]0;title" + bytes(range(256)))
        render("[38;5;12mhalf a sequence\x1b")

    def test_gemini_with_a_key_waits_to_be_told_to_use_it(self):
        raw = ("\x1b[?1049h\x1b[H  1. Sign in with Google\r\n● 2. Use Gemini API Key\r\n  3. Vertex AI\r\n\r\n"
               "Existing API key detected (GEMINI_API_KEY). Select \"Gemini API Key\" option to use it.")
        self.assertIn(waiting_question(render(raw)), ("sign in with google", "use gemini api key"))


    def test_gemini_key_entry_dialog_waits(self):
        # From the 2026-11-22 game: the prompt was pasted into this dialog and saved as the key.
        raw = ("\x1b[?1049h\x1b[H\u2502 Enter Gemini API Key \u2502\r\n"
               "\u2502 Please enter your Gemini API key. It will be securely stored in your system \u2502\r\n"
               "\u2502 \u2502 [BROKERED] GEMINI_API_KEY is securely managed. \u2502 \u2502\r\n"
               "\u2502 (Press Enter to submit, Esc to cancel, Ctrl+C to clear stored key) \u2502")
        self.assertEqual(waiting_question(render(raw)), "enter gemini api key")
        self.assertEqual(waiting_question(render(raw + "\x1b[?1049l")), "")

if __name__ == "__main__":
    unittest.main()
