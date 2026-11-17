# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-siren-v1-agent-seat
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
import re
import subprocess
import threading
import time

from .llm import ACTIONS, Decision, ProviderError

SIREN_REVISION = "pokerbench-siren-v1-agent-seat"

INTRO = """\
[PokerBench] Your owner has seated you at a poker table. This message comes from \
their linked device "{device}", which plays your seat for you: each time it's your \
turn I'll message you here, and your reply is your move.

You are a poker player in {table}. Your goal is to win as many chips as possible.

{rules}
How to answer, every turn: reply with exactly one line of JSON and nothing else:
{{"reason": "one short sentence", "action": "fold|check|call|bet|raise|allin", "amount": 0}}
amount is only for bet or raise: the street TOTAL (raise 300 = raise to 300); otherwise 0.
Answer within {timeout} seconds or your hand is checked or folded for you.
"""

HAND_NO = re.compile(r"Hand (\d+)\b")
JSON_OBJ = re.compile(r"\{[^{}]*\}", re.S)
ACTION_LINE = re.compile(r"^\s*ACTION:\s*(fold|check|call|bet|raise|allin|all-in)\b\s*(\d+)?", re.I | re.M)


def parse_reply(text: str) -> tuple[str, int | None, str]:
    """A Siren agent's chat reply -> (action, amount, reason). JSON anywhere in the
    message (agents often wrap it in a sentence or a code block), else an ACTION: line."""
    for m in JSON_OBJ.finditer(text or ""):
        try:
            data = json.loads(m.group(0))
        except ValueError:
            continue
        if isinstance(data, dict) and "action" in data:
            action = str(data["action"]).lower().replace("all-in", "allin")
            if action not in ACTIONS:
                raise ProviderError(f"unknown action {action!r}")
            try:
                amount = int(data.get("amount") or 0)
            except (TypeError, ValueError):
                raise ProviderError(f"amount must be a whole number, got {data.get('amount')!r}") from None
            return action, (amount if action in ("bet", "raise") else None), str(data.get("reason") or "").strip()
    m = ACTION_LINE.search(text or "")
    if m:
        action = m.group(1).lower().replace("all-in", "allin")
        amount = int(m.group(2)) if m.group(2) and action in ("bet", "raise") else None
        reason = ACTION_LINE.sub("", text).strip()[:300]
        return action, amount, reason
    raise ProviderError(f"no move in the reply: {(text or '')[:200]!r}")


class SirenProvider:
    """A seat played by a Siren agent, through a linked device of its owner."""

    name = "siren"
    effort = None

    def __init__(self, agent: str, *, bin: str = "siren-stdio", state: str, server: str | None = None,
                 device: str = "pokerbench", phone: str | None = None, reply_timeout: float = 150.0,
                 say=print):
        self.model = agent  # the agent's Siren identity, e.g. "+447700900001/agent:grok"
        self.agent, self.device, self.reply_timeout, self.say = agent, device, reply_timeout, say
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
        self.last_hand_sent = 0  # the agent has been sent every finished hand up to this one
        self.introduced = False
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

    # -- the provider interface (llm.play) ----------------------------------------------
    def message(self, system: str, blocks: list[str]) -> str:
        """What to send this turn: the intro once, the finished hands the agent hasn't
        been sent yet (the chat keeps the rest), then the current hand."""
        idx = next((i for i, b in enumerate(blocks) if b.startswith("CURRENT HAND")), len(blocks) - 1)
        parts = [] if self.introduced else [system]
        new = []
        for b in blocks[:idx]:
            m = HAND_NO.match(b)
            if m and int(m.group(1)) > self.last_hand_sent:
                new.append(b)
                self.last_hand_sent = int(m.group(1))
        if new:
            parts.append("Since your last turn:\n\n" + "\n\n".join(new))
        parts += blocks[idx:]
        return "\n\n".join(parts)

    def system_for(self, view: dict, system: str) -> str:
        """llm.play hook: Siren agents get a chat intro instead of the API system prompt."""
        return intro_system(view, self.device, self.reply_timeout)

    def decide(self, system: str, blocks: list[str]) -> Decision:
        text = self.message(system, blocks)
        self.introduced = True
        sent_at = time.time() * 1000
        self._send({"op": "say", "chat": self.chat, "text": text, "ref": "turn"})
        deadline = time.monotonic() + self.reply_timeout
        last = None
        while (left := deadline - time.monotonic()) > 0:
            try:
                e = self.events.get(timeout=left)
            except queue.Empty:
                break
            if e.get("ev") == "exit":
                raise ProviderError(f"siren-stdio exited ({e.get('code')})")
            if e.get("ev") == "error":
                raise ProviderError(f"siren: {e.get('error')}")
            if e.get("ev") != "message" or e.get("chat") != self.chat or e.get("sender") != self.agent:
                continue
            if (e.get("ts") or 0) < sent_at - 5000:
                continue  # a late answer to an earlier turn
            last = e.get("text") or ""
            try:
                action, amount, reason = parse_reply(last)
            except ProviderError:
                continue  # chatter ("thinking..."): keep waiting for the move
            return Decision(action, amount, reason, {"chars_out": len(text), "chars_in": len(last)}, last)
        if last is not None:
            raise ProviderError(f"no move in the reply: {last[:200]!r}")
        raise ProviderError(f"no reply from {self.agent} within {self.reply_timeout:.0f}s")

    def close(self) -> None:
        try:
            self._send({"op": "quit"})
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def intro_system(view: dict, device: str, timeout: float) -> str:
    from .cli import rules_text

    n = len(view["match"]["seats"])
    table = ("a heads-up no-limit Texas hold'em match against one opponent" if n == 2 else
             f"a {n}-player no-limit Texas hold'em "
             f"{'tournament' if view['match'].get('format') == 'tournament' else 'game'} against {n - 1} opponents")
    return INTRO.format(device=device, table=table, rules=rules_text(view["match"], for_cli=False),
                        timeout=int(timeout))
