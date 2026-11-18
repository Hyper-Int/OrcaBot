# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-siren-v3-table-timeout
"""Siren agent seats: an agent that lives in Siren (Grok Bot, Muse, Dots, Claude Code
with the Siren plugin, ...) plays a seat by chat.

Siren chats are end-to-end encrypted (MLS), so this talks to Siren through
``siren-stdio`` (Siren repo, ``mls/tools``), a small MLS client driven by JSON lines.
It runs as a **linked device of the agent's owner**: the owner approves it once on
their phone, and from then on its direct messages to their agent are requests from
the owner, which is what wakes a Siren agent (others' messages don't, unless the
agent is public, and public requests are capped at 20 an hour).

Each turn is one message to the agent: the hands that finished since its last turn
(as its seat saw them), then the current situation and how to answer. The agent
keeps the chat, so unlike a direct model seat it isn't re-sent the whole history. It
answers with one line of JSON ``{"reason", "action", "amount"}`` (or ``ACTION: raise
900``); anything else is rejected with the engine's reason and asked again, through
the same loop as direct model seats (``llm.play``).

Siren agents are slow to wake (seconds for Grok, a minute or two for agents that
poll), so give these seats a long ``--turn-timeout`` on the engine.
"""

from __future__ import annotations

import json
import queue
import subprocess
import threading
import time
from collections.abc import Iterator

from .chatseat import ChatSeat, parse_reply  # noqa: F401 (parse_reply re-exported)
from .llm import ProviderError

SIREN_REVISION = "pokerbench-siren-v3-table-timeout"


class SirenProvider(ChatSeat):
    """A seat played by a Siren agent, through a linked device of its owner (outside
    Orcabot; inside it, an Agent block does this: see agentlink.py)."""

    name = "siren"

    def __init__(self, agent: str, *, bin: str = "siren-stdio", state: str, server: str | None = None,
                 device: str = "pokerbench", phone: str | None = None, reply_timeout: float | None = None,
                 say=print):
        super().__init__(agent, reply_timeout)  # agent: its Siren identity, e.g. "+447700900001/agent:grok"
        self.device, self.say = device, say
        cmd = [bin, "--state", state, "--name", "PokerBench"]
        if server:
            cmd += ["--server", server]
        cmd += ["--phone", phone] if phone else ["--device", device, "--label", "PokerBench"]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.events: queue.Queue = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        ready = self._wait(lambda e: e.get("ev") == "ready", timeout=900, what="Siren login",
                           on_other=self._pairing_notice)
        self.identity = ready["identity"]
        self._send({"op": "chat", "with": agent, "ref": "chat"})
        self.chat = self._wait(lambda e: e.get("ref") == "chat" and e.get("ev") in ("chat", "error"),
                               timeout=60, what="opening the chat")
        if self.chat.get("ev") == "error":
            raise SystemExit(f"couldn't open a chat with {agent}: {self.chat.get('error')}")
        self.chat = self.chat["chat"]
        say(f"siren: {self.identity} -> {agent} (chat {self.chat[:12]}…)")

    # -- siren-stdio plumbing ------------------------------------------------------
    def _read(self) -> None:
        for line in self.proc.stdout:
            try:
                self.events.put(json.loads(line))
            except ValueError:
                pass
        self.events.put({"ev": "exit", "code": self.proc.wait()})

    def _send(self, cmd: dict) -> None:
        if self.proc.poll() is not None:
            raise ProviderError("siren-stdio is not running")
        self.proc.stdin.write(json.dumps(cmd) + "\n")
        self.proc.stdin.flush()

    def _pairing_notice(self, e: dict) -> None:
        if e.get("ev") == "pairing":
            self.say(f"siren: approve this seat on your iPhone: open {e['link']} or enter {e['code']} "
                     f"in Siren (Agents -> Connect an agent). Waiting...")

    def _wait(self, want, timeout: float, what: str, on_other=None) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise SystemExit(f"siren: timed out waiting for {what}")
            try:
                e = self.events.get(timeout=left)
            except queue.Empty:
                continue
            if e.get("ev") == "exit":
                raise SystemExit(f"siren-stdio exited ({e.get('code')}) while waiting for {what}")
            if want(e):
                return e
            if on_other:
                on_other(e)

    # -- ChatSeat transport ------------------------------------------------------------
    def _post(self, text: str) -> None:
        self._sent_at = time.time() * 1000
        self._send({"op": "say", "chat": self.chat, "text": text, "ref": "turn"})

    def _replies(self, deadline: float) -> Iterator[str]:
        while (left := deadline - time.monotonic()) > 0:
            try:
                e = self.events.get(timeout=left)
            except queue.Empty:
                return
            if e.get("ev") == "exit":
                raise ProviderError(f"siren-stdio exited ({e.get('code')})")
            if e.get("ev") == "error":
                raise ProviderError(f"siren: {e.get('error')}")
            if e.get("ev") != "message" or e.get("chat") != self.chat or e.get("sender") != self.agent:
                continue
            if (e.get("ts") or 0) < self._sent_at - 5000:
                continue  # a late answer to an earlier turn
            yield e.get("text") or ""

    def close(self) -> None:
        try:
            self._send({"op": "quit"})
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()

