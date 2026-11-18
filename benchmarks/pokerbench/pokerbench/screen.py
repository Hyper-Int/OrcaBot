# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-screen-v1-render
"""What an agent terminal shows right now, from its raw recent output.

A seat's helper asks Orcabot for its own terminal's raw output (/screen: the last 64KB
with escape codes, plus the window size) and renders it here, then looks for a setup
question the agent is still waiting on (login, trust this folder, ...). Rendering
matters: an agent's interface redraws in place with cursor moves, so a question that
was answered is still in the output text, but no longer on the screen.

A small terminal model, enough for the agents' interfaces (Ink: Claude Code, Gemini
CLI; ratatui: Codex): printing with wrap, cursor moves and positioning, erasing,
scroll regions, inserting and deleting lines and characters, the alternate screen.
Colours and modes are ignored. Standard library only: the engine publishes it for
seats as seat_screen.py.

    python3 seat_screen.py --rows 40 --cols 120 < output      # prints the question, if any
    python3 seat_screen.py --rows 40 --cols 120 --print < output
"""

from __future__ import annotations

import argparse
import re
import sys

SCREEN_REVISION = "pokerbench-screen-v1-render"

# Setup screens of Claude Code, Codex and Gemini CLI that wait for the user. While one is
# on the screen, a pasted prompt would land in it.
QUESTIONS = (
    # Claude Code
    "select login method", "choose the text style", "do you trust the files", "trust this folder",
    "bypass permissions mode", "yes, i accept", "paste code here", "browser didn", "login successful",
    "security notes", "detected a custom api key",
    # Codex
    "choose how you want to use codex", "sign in with chatgpt", "sign in with device code",
    "allow codex to work in this folder",
    # Gemini CLI
    "how would you like to authenticate", "sign in with google", "use gemini api key",
    "existing api key detected", "do you trust this folder", "trust folder",
    # any
    "press enter to continue",
)


class Screen:
    def __init__(self, rows: int = 40, cols: int = 120):
        self.rows, self.cols = max(2, rows), max(10, cols)
        self.main = self._blank()
        self.alt = self._blank()
        self.grid = self.main
        self.r = self.c = 0
        self.wrap_next = False
        self.top, self.bottom = 0, self.rows - 1
        self.saved = (0, 0)

    def _blank(self) -> list[list[str]]:
        return [[" "] * self.cols for _ in range(self.rows)]

    # -- primitives ---------------------------------------------------------------------
    def _clamp(self) -> None:
        self.r = min(max(self.r, 0), self.rows - 1)
        self.c = min(max(self.c, 0), self.cols - 1)
        self.wrap_next = False

    def _scroll_up(self, n: int = 1, top: int | None = None) -> None:
        top = self.top if top is None else top
        for _ in range(n):
            del self.grid[top]
            self.grid.insert(self.bottom, [" "] * self.cols)

    def _scroll_down(self, n: int = 1, top: int | None = None) -> None:
        top = self.top if top is None else top
        for _ in range(n):
            del self.grid[self.bottom]
            self.grid.insert(top, [" "] * self.cols)

    def _linefeed(self) -> None:
        if self.r == self.bottom:
            self._scroll_up()
        elif self.r < self.rows - 1:
            self.r += 1

    def _put(self, ch: str) -> None:
        if self.wrap_next:
            self.c = 0
            self._linefeed()
            self.wrap_next = False
        self.grid[self.r][self.c] = ch
        if self.c == self.cols - 1:
            self.wrap_next = True
        else:
            self.c += 1

    # -- escape sequences ------------------------------------------------------------------
    def _csi(self, params: str, final: str) -> None:
        private = params.startswith("?")
        nums = [int(p) if p.isdigit() else 0 for p in params.lstrip("?>=").split(";")] if params.strip("?>=") else []
        n = nums[0] if nums and nums[0] else 1
        g = self.grid
        if final in "AFk":
            self.r -= n
            if final == "F":
                self.c = 0
        elif final in "BEe":
            self.r += n
            if final == "E":
                self.c = 0
        elif final in "Ca":
            self.c += n
        elif final == "D":
            self.c -= n
        elif final in "G`":
            self.c = n - 1
        elif final == "d":
            self.r = n - 1
        elif final in "Hf":
            self.r = (nums[0] if nums and nums[0] else 1) - 1
            self.c = (nums[1] if len(nums) > 1 and nums[1] else 1) - 1
        elif final == "J":
            mode = nums[0] if nums else 0
            if mode == 0:
                g[self.r][self.c:] = [" "] * (self.cols - self.c)
                for row in range(self.r + 1, self.rows):
                    g[row] = [" "] * self.cols
            elif mode == 1:
                for row in range(self.r):
                    g[row] = [" "] * self.cols
                g[self.r][: self.c + 1] = [" "] * (self.c + 1)
            else:
                for row in range(self.rows):
                    g[row] = [" "] * self.cols
            return
        elif final == "K":
            mode = nums[0] if nums else 0
            if mode == 0:
                g[self.r][self.c:] = [" "] * (self.cols - self.c)
            elif mode == 1:
                g[self.r][: self.c + 1] = [" "] * (self.c + 1)
            else:
                g[self.r] = [" "] * self.cols
            return
        elif final == "X":
            end = min(self.cols, self.c + n)
            g[self.r][self.c:end] = [" "] * (end - self.c)
            return
        elif final == "P":
            row = g[self.r]
            del row[self.c:self.c + n]
            row.extend([" "] * (self.cols - len(row)))
            return
        elif final == "@":
            row = g[self.r]
            row[self.c:self.c] = [" "] * n
            del row[self.cols:]
            return
        elif final == "L" and self.top <= self.r <= self.bottom:
            self._scroll_down(n, top=self.r)
            return
        elif final == "M" and self.top <= self.r <= self.bottom:
            self._scroll_up(n, top=self.r)
            return
        elif final == "S":
            self._scroll_up(n)
            return
        elif final == "T" and not private:
            self._scroll_down(n)
            return
        elif final == "r" and not private:
            top = (nums[0] if nums and nums[0] else 1) - 1
            bottom = (nums[1] if len(nums) > 1 and nums[1] else self.rows) - 1
            if 0 <= top < bottom < self.rows:
                self.top, self.bottom = top, bottom
            self.r, self.c = 0, 0
        elif final == "s":
            self.saved = (self.r, self.c)
            return
        elif final == "u":
            self.r, self.c = self.saved
        elif final in "hl" and private:
            if any(p in (47, 1047, 1049) for p in nums):
                if final == "h":
                    if nums and 1049 in nums:
                        self.saved = (self.r, self.c)
                    self.alt = self._blank()
                    self.grid = self.alt
                else:
                    self.grid = self.main
                    if nums and 1049 in nums:
                        self.r, self.c = self.saved
            return
        else:
            return  # colours (m), modes and the rest change nothing we read
        self._clamp()

    def feed(self, data: str) -> "Screen":
        i, n = 0, len(data)
        while i < n:
            ch = data[i]
            if ch == "\x1b" and i + 1 < n:
                nxt = data[i + 1]
                if nxt == "[":
                    m = re.compile(r"\[([0-9;?>=!]*)[ -/]*([@-~])").match(data, i + 1)
                    if m:
                        self._csi(m.group(1), m.group(2))
                        i = m.end()
                        continue
                elif nxt in "]PX^_":  # OSC / DCS / ...: skip to BEL or ST
                    end = len(data)
                    for term in ("\x07", "\x1b\\"):
                        j = data.find(term, i + 2)
                        if j != -1:
                            end = min(end, j + len(term))
                    i = end
                    continue
                elif nxt in "()*+":
                    i += 3
                    continue
                elif nxt == "7":
                    self.saved = (self.r, self.c)
                elif nxt == "8":
                    self.r, self.c = self.saved
                    self._clamp()
                elif nxt == "M":
                    if self.r == self.top:
                        self._scroll_down()
                    else:
                        self.r = max(0, self.r - 1)
                elif nxt == "D":
                    self._linefeed()
                elif nxt == "E":
                    self.c = 0
                    self._linefeed()
                elif nxt == "c":
                    self.__init__(self.rows, self.cols)
                i += 2
                continue
            if ch == "\r":
                self.c, self.wrap_next = 0, False
            elif ch in "\n\x0b\x0c":
                self._linefeed()
                self.wrap_next = False
            elif ch == "\b":
                self.c, self.wrap_next = max(0, self.c - 1), False
            elif ch == "\t":
                self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
            elif ch >= " " and ch != "\x7f":
                self._put(ch)
            i += 1
        return self

    def text(self) -> str:
        return "\n".join("".join(row).rstrip() for row in self.grid).rstrip("\n")


def render(raw: bytes | str, rows: int = 40, cols: int = 120) -> str:
    data = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    return Screen(rows, cols).feed(data).text()


def waiting_question(screen_text: str) -> str:
    """The setup question on the screen, or "" if none."""
    flat = re.sub(r"\s+", " ", screen_text.lower())
    return next((q for q in QUESTIONS if q in flat), "")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="render a terminal's raw output; print a waiting setup question")
    p.add_argument("--rows", type=int, default=0)
    p.add_argument("--cols", type=int, default=0)
    p.add_argument("--print", action="store_true", help="print the rendered screen instead")
    args = p.parse_args(argv)
    text = render(sys.stdin.buffer.read(), args.rows or 40, args.cols or 120)
    print(text if args.print else waiting_question(text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
