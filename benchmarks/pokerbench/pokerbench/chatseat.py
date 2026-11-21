# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-chatseat-v6-present-check-in
"""Chat seats: an outside agent (one with its own computer and its own memory, such
as Grok Bot, Muse or Dots) plays a seat by being messaged.

Each turn is one message: an intro the first time (the rules and how to answer),
then the hands that finished since its last turn (as its seat saw them), then the
current hand. The agent keeps the chat, so unlike a direct model seat it isn't
re-sent its whole history.

These agents answer messages when they get round to them, and a table of players waits
on each turn, so the intro says plainly that this is a live, timed game. Turns are
numbered and the answer names its turn: a late answer to an earlier turn is ignored
rather than played on the next one. Between its turns, while it is in a hand, the agent
gets a short update as players act, with how soon its turn comes (no reply needed), so
it can check its messages more often when its turn is close. It answers with one line of JSON ``{"reason", "action",
"amount"}`` found anywhere in its reply, or an ``ACTION: raise 900`` line; chatter
before the move ("thinking...") is skipped, and an unusable or illegal move goes back
with the reason through the same loop as direct model seats (``llm.play``).

Before the game starts, the seat asks its agent to reply "ready" (``check_in``), and only
takes its place at the table once it has: until then the table page shows that it's
waiting for the agent, then that the agent isn't answering, and a game started without
an answer leaves the seat out. An agent that misses turns in a row is sat out on a short
clock by the engine; anything it says afterwards (even a late answer, which still isn't
played) tells the engine it's back (``present``), so its next turn gets the full time.

How the message travels is the subclass's job: ``agentlink`` (an Orcabot Agent block
connected to the table) or ``siren`` (a standalone MLS client, outside Orcabot).
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator

from .llm import ACTIONS, Decision, NoReply, ProviderError

CHATSEAT_REVISION = "pokerbench-chatseat-v6-present-check-in"

INTRO = """\
[PokerBench] Your owner has seated you at a poker table. This is a LIVE, TIMED game: \
{others} other players are at the table and the whole table waits for you on each of \
your turns, so answer each turn as fast as you can.

You are a poker player in {table}. Your goal is to win as many chips as possible.

{rules}
How it works:
- When it's your turn I send a message starting "[PokerBench] Turn N: your move". Reply \
straight away with exactly one line of JSON and nothing else:
  {{"turn": N, "reason": "one short sentence", "action": "fold|check|call|bet|raise|allin", "amount": 0}}
  amount is only for bet or raise: the street TOTAL (raise 300 = raise to 300); otherwise 0.
- You have {timeout} seconds from when that message is sent. Decide from what it shows: \
don't research, browse or run tools. A late answer doesn't count (it is ignored): your \
hand is checked or folded for you.
- Between your turns, while you're in a hand, I send short updates as players act, with \
how soon your turn comes. They need no reply; don't answer them. When your turn is close, \
check your messages often so you see your turn as soon as it arrives.
"""

CHECK_IN = """\
[PokerBench] Your owner has seated you at a poker table that starts soon. Reply "ready" \
now (just that word) so the table knows you're here. The rules come with your first turn."""

# How long before the table page says the agent isn't answering (it can still answer).
NOT_ANSWERING_AFTER_S = 180.0
# Between turns, look for late answers at most this often (each look is a request).
DRAIN_EVERY_S = 15.0

HAND_NO = re.compile(r"Hand (\d+)\b")
TURN_FIELD = re.compile(r'"turn"\s*:\s*"?(\d+)')
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
    return INTRO.format(table=table, rules=rules_text(view["match"], for_cli=False), timeout=int(timeout),
                        others=n - 1)


class ChatSeat:
    """The provider interface llm.play uses, for an agent reached by chat. Subclasses
    implement ``_post(text)`` and ``_replies(deadline)`` (the agent's messages after
    the last post, as they arrive)."""

    name = "chat"
    effort = None

    def __init__(self, agent: str, reply_timeout: float | None = None):
        self.model = agent
        # reply_timeout None: wait as long as the table's turn timeout allows (set from each
        # turn's view, since the table page can change it before the start).
        self.agent, self.reply_timeout = agent, reply_timeout
        self.turn_limit = reply_timeout or 150.0
        self.last_hand_sent = 0  # the agent has been sent every finished hand up to this one
        self.introduced = False
        self.turn = 0  # numbered turns: an answer names its turn
        self.turn_deadline: float | None = None  # set by llm.play: when the engine's clock runs out
        self.engine = None  # the seat's engine client (attach): to say the agent is back
        self.want_back = False  # heard from the agent while sitting out; tell the engine
        self.last_heard: float | None = None
        self._drained_at = 0.0
        self.view: dict = {}
        self.updated: tuple | None = None  # (hand, actions seen) of the last update sent

    def _post(self, text: str) -> None:
        raise NotImplementedError

    def _replies(self, deadline: float) -> Iterator[str]:
        raise NotImplementedError

    def _pending(self) -> list[str]:
        """The agent's messages that arrived since the last look, without waiting
        (subclasses that can look without a turn override this)."""
        return []

    # -- hearing from the agent ------------------------------------------------------
    def attach(self, client) -> None:
        """llm.play hook: the seat's engine client."""
        self.engine = client

    def _heard(self) -> None:
        """The agent said something (an answer, a late answer, chatter): it's there."""
        self.last_heard = time.monotonic()
        if self.view.get("sitting_out"):
            self.want_back = True
        self._maybe_back()

    def _maybe_back(self) -> None:
        """Tell the engine a sitting-out agent is back (tried again at the next look if
        the engine can't be reached)."""
        if not self.want_back or self.engine is None:
            return
        try:
            r = self.engine.present()
        except Exception:  # noqa: BLE001 -- try again at the next look
            return
        self.want_back = False
        if r.get("back") and not r.get("from_next_turn"):
            self.view = {**self.view, "sitting_out": False}

    def drain(self, force: bool = True) -> None:
        """Look for messages that came in since the last look (late answers)."""
        if not force and time.monotonic() - self._drained_at < DRAIN_EVERY_S:
            return
        self._drained_at = time.monotonic()
        try:
            heard = bool(self._pending())
        except Exception:  # noqa: BLE001 -- a look is a courtesy
            heard = False
        if heard:
            self._heard()
        else:
            self._maybe_back()

    def check_in(self, client, say=lambda line: None, poll: float = 10.0) -> bool:
        """Before the game starts: ask the agent to reply "ready" and wait for any answer,
        telling the table page meanwhile. True to play: it answered, or the game is
        already running with this seat (a restarted seat). False: the game started
        without it."""
        view = client.setup()
        if view.get("status") != "waiting_for_players":
            return bool(view.get("in_game"))
        name = self.agent.rsplit(":", 1)[-1]
        while True:  # the message must go out first (the agent may not be linked yet)
            try:
                self._post(CHECK_IN)
                break
            except ProviderError as e:
                say(f"(couldn't message {name}: {e})")
                try:
                    client.report_status("needs", f"Couldn't message {name}: {e}")
                except Exception:  # noqa: BLE001
                    pass
            time.sleep(poll)
            view = client.setup()
            if view.get("status") != "waiting_for_players":
                return bool(view.get("in_game"))
        asked = time.monotonic()
        say(f"asked {name} to reply \"ready\"")
        shown = None
        while True:
            left = asked + NOT_ANSWERING_AFTER_S - time.monotonic()
            status = ("checking", f"Asked {name} to reply \"ready\"; waiting for its answer.") if left > 0 else (
                "needs", f"{name} isn't answering its messages (asked {int((time.monotonic() - asked) // 60)} "
                         f"min ago). Check its Agent block's chat; the game starts without it unless it answers.")
            if status[0] != shown:
                try:
                    client.report_status(*status)
                    shown = status[0]
                except Exception:  # noqa: BLE001 -- the table page just shows less
                    pass
            try:
                for _ in self._replies(time.monotonic() + poll):
                    self.last_heard = time.monotonic()
                    say(f"{name} answered")
                    return True
            except ProviderError as e:
                say(f"(couldn't read {name}'s messages: {e})")
                time.sleep(min(poll, 5.0))
            view = client.setup()
            if view.get("status") != "waiting_for_players":
                return bool(view.get("in_game"))

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
        head = f"[PokerBench] Turn {self.turn}: your move. Answer within {int(seconds)}s" if (
            seconds := self._seconds_left()) else f"[PokerBench] Turn {self.turn}: your move"
        head += f' with {{"turn": {self.turn}, ...}}.'
        if self.view.get("sitting_out"):
            head += (f" You missed your last {self.view.get('missed_turns')} turns, so you only get "
                     f"{self.view.get('your_timeout_s', 30):.0f}s now until you answer one in time.")
        parts.append(head)
        parts += blocks[idx:]
        return "\n\n".join(parts)

    def _seconds_left(self) -> float | None:
        left = [self.turn_limit]
        if self.turn_deadline is not None:
            left.append(self.turn_deadline - time.monotonic())
        return max(1.0, min(left))

    def system_for(self, view: dict, system: str) -> str:
        """llm.play hook, once per turn: chat agents get an intro instead of the API system prompt."""
        self.turn += 1
        self.view = view
        t = view.get("match", {}).get("turn_timeout_s")
        if t:
            table = max(5.0, t - 15 if t > 40 else t - 5)  # leave time to send the move
            self.turn_limit = min(self.reply_timeout, table) if self.reply_timeout else table
        return intro_system(view, self.turn_limit)

    def decide(self, system: str, blocks: list[str]) -> Decision:
        self.drain()  # late answers since the last turn: the agent is there
        text = self.message(system, blocks)
        self.introduced = True
        self._post(text)
        last = None
        for reply in self._replies(time.monotonic() + (self._seconds_left() or self.turn_limit)):
            self._heard()
            named = TURN_FIELD.search(reply or "")
            if named and int(named.group(1)) != self.turn:
                continue  # a late answer to an earlier turn: not played, but it's back
            last = reply
            try:
                action, amount, reason = parse_reply(reply)
            except ProviderError:
                continue  # chatter ("thinking..."): keep waiting for the move
            return Decision(action, amount, reason, {"chars_out": len(text), "chars_in": len(reply)}, reply)
        if last is not None:
            raise ProviderError(f"no move in the reply: {last[:200]!r}")
        raise NoReply(f"no reply from {self.agent} within {self.turn_limit:.0f}s")

    def between_turns(self, view: dict) -> None:
        """llm.play hook while it isn't this seat's turn: when players have acted in a hand
        the agent is still in, a short update with how soon its turn comes. Only after the
        intro (the agent knows the game), and only while a turn is coming on this street."""
        from .cli import _fmt_action, turn_coming

        self.view = view
        if self.introduced:
            self.drain(force=False)  # a late answer: tell the engine the agent is back
        m = view.get("match") or {}
        if (not self.introduced or m.get("status") != "running" or m.get("paused") or view.get("resuming")
                or not view.get("you") or view.get("turn_in") is None):
            return
        hand, actions = m.get("hand"), view.get("actions") or []
        seen = self.updated[1] if self.updated and self.updated[0] == hand else 0
        if self.updated == (hand, len(actions)) or len(actions) <= seen:
            return
        me = view["you"]["seat"]
        news = "; ".join(f"{_fmt_action(a, me)}" for a in actions[seen:])
        self.updated = (hand, len(actions))
        self._post(f"[PokerBench] Update (no reply needed): hand {hand}, {view.get('street')}: {news}. "
                   f"{turn_coming(view)}")

    def game_over(self, view: dict) -> None:
        """Tell an agent that has played that the game is over (finished, or ended early
        from the table page), so it isn't left waiting for its next turn."""
        if not self.introduced:
            return
        from .cli import match_over_lines

        try:
            self._post("[PokerBench] " + "\n".join(match_over_lines(view))
                       + "\nThe game is over: no more turns. You don't need to reply.")
        except Exception:  # noqa: BLE001 -- the game is over either way
            pass

    def close(self) -> None:
        pass
