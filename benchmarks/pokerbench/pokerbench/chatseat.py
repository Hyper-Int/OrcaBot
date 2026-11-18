# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-chatseat-v1-shared
"""Chat seats: an outside agent (one with its own computer and its own memory, such
as Grok Bot, Muse or Dots) plays a seat by being messaged.

Each turn is one message: an intro the first time (the rules and how to answer),
then the hands that finished since its last turn (as its seat saw them), then the
current hand. The agent keeps the chat, so unlike a direct model seat it isn't
re-sent its whole history. It answers with one line of JSON ``{"reason", "action",
"amount"}`` found anywhere in its reply, or an ``ACTION: raise 900`` line; chatter
before the move ("thinking...") is skipped, and an unusable or illegal move goes back
with the reason through the same loop as direct model seats (``llm.play``).

How the message travels is the subclass's job: ``agentlink`` (an Orcabot Agent block
connected to the table) or ``siren`` (a standalone MLS client, outside Orcabot).
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator

from .llm import ACTIONS, Decision, ProviderError

CHATSEAT_REVISION = "pokerbench-chatseat-v1-shared"

INTRO = """\
[PokerBench] Your owner has seated you at a poker table. Each time it's your turn \
I'll message you here, and your reply is your move.

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
    """An agent's chat reply -> (action, amount, reason). JSON anywhere in the
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


def intro_system(view: dict, timeout: float) -> str:
    from .cli import rules_text

    n = len(view["match"]["seats"])
    table = ("a heads-up no-limit Texas hold'em match against one opponent" if n == 2 else
             f"a {n}-player no-limit Texas hold'em "
             f"{'tournament' if view['match'].get('format') == 'tournament' else 'game'} against {n - 1} opponents")
    return INTRO.format(table=table, rules=rules_text(view["match"], for_cli=False), timeout=int(timeout))


class ChatSeat:
    """The provider interface llm.play uses, for an agent reached by chat. Subclasses
    implement ``_post(text)`` and ``_replies(deadline)`` (the agent's messages after
    the last post, as they arrive)."""

    name = "chat"
    effort = None

    def __init__(self, agent: str, reply_timeout: float):
        self.model = agent
        self.agent, self.reply_timeout = agent, reply_timeout
        self.last_hand_sent = 0  # the agent has been sent every finished hand up to this one
        self.introduced = False

    def _post(self, text: str) -> None:
        raise NotImplementedError

    def _replies(self, deadline: float) -> Iterator[str]:
        raise NotImplementedError

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
        """llm.play hook: chat agents get an intro instead of the API system prompt."""
        return intro_system(view, self.reply_timeout)

    def decide(self, system: str, blocks: list[str]) -> Decision:
        text = self.message(system, blocks)
        self.introduced = True
        self._post(text)
        last = None
        for reply in self._replies(time.monotonic() + self.reply_timeout):
            last = reply
            try:
                action, amount, reason = parse_reply(reply)
            except ProviderError:
                continue  # chatter ("thinking..."): keep waiting for the move
            return Decision(action, amount, reason, {"chars_out": len(text), "chars_in": len(reply)}, reply)
        if last is not None:
            raise ProviderError(f"no move in the reply: {last[:200]!r}")
        raise ProviderError(f"no reply from {self.agent} within {self.reply_timeout:.0f}s")

    def close(self) -> None:
        pass
