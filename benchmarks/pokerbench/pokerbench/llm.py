# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-llm-v3-broker-base-url
"""Direct model seats: a model plays through its provider's API, with no agent harness.

Each decision is a fresh request (no conversation), but the request carries
everything the seat has observed so far: every finished hand from its seat (its
cards, the board, every action, cards shown at showdown, results, stacks, blinds)
plus its own earlier reasons, then the current hand. That is the same
information an agent in a terminal has seen, so neither is at an information
disadvantage. Each finished hand is its own content block, so the history is a
stable prefix that providers can cache between decisions.

The model answers with structured output: ``{"reason", "action", "amount"}``.
An illegal action is sent back with the engine's error message for another try;
after ``max_retries`` the seat checks if free, else folds, marked ``[auto]`` in
the reason. The engine counts every rejected action as invalid, as it does for
agents.

Providers use their official SDKs, imported lazily (``pip install pokerbench[llm]``):
``anthropic`` (Messages API), ``openai`` (Responses API), ``gemini`` (google-genai).
API keys come from the usual environment variables. In an Orcabot terminal those
hold placeholders and ``*_BASE_URL`` points at the local secrets broker, which adds
the real key: the Anthropic and OpenAI SDKs read their base URL variable
themselves; the Gemini client is given ``GOOGLE_GEMINI_BASE_URL`` explicitly.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from .cli import ApiError, Client, _fmt_action, render, rules_text

LLM_REVISION = "pokerbench-llm-v3-broker-base-url"
log = logging.getLogger("pokerbench.llm")
log.info("[llm] REVISION: %s loaded at %s", LLM_REVISION, time.strftime("%Y-%m-%dT%H:%M:%S%z"))

ACTIONS = ["fold", "check", "call", "bet", "raise", "allin"]
# Reason first: a model that is not thinking separately reasons before it commits.
SCHEMA = {
    "type": "object",
    "properties": {
        "reason": {"type": "string", "description": "One short sentence: why this action."},
        "action": {"type": "string", "enum": ACTIONS},
        "amount": {"type": "integer",
                   "description": "For bet/raise: the street TOTAL to bet or raise to. 0 for every other action."},
    },
    "required": ["reason", "action", "amount"],
    "additionalProperties": False,
}

SYSTEM = """\
You are a poker player in {table}.
Your goal is to win as many chips as possible.

{rules}
Each request shows every hand played so far, as you saw it from your seat (with
your own earlier reasons), then the current situation. Decide your action for
this turn and answer with JSON:
- reason: one short sentence;
- action: fold, check, call, bet, raise or allin;
- amount: for bet or raise, the street TOTAL (raise 300 = raise to 300); otherwise 0.
"""

DEFAULT_MODELS = {"anthropic": "claude-opus-5-5"}


@dataclass
class Decision:
    action: str
    amount: int | None
    reason: str
    usage: dict = field(default_factory=dict)
    raw: str = ""


class ProviderError(Exception):
    """The model did not produce a usable decision (refusal, truncation, bad JSON)."""


def _parse(text: str) -> tuple[str, int | None, str]:
    try:
        data = json.loads(text)
        action = str(data["action"]).lower()
        amount = int(data.get("amount") or 0)
        reason = str(data.get("reason") or "").strip()
    except (ValueError, KeyError, TypeError) as e:
        raise ProviderError(f"unparseable output: {text[:200]!r}") from e
    if action not in ACTIONS:
        raise ProviderError(f"unknown action {action!r}")
    return action, (amount if action in ("bet", "raise") else None), reason


# -- providers ------------------------------------------------------------------
class AnthropicProvider:
    name = "anthropic"

    def __init__(self, model: str, effort: str | None, max_tokens: int):
        import anthropic

        self.anthropic = anthropic
        self.client = anthropic.Anthropic()
        self.model, self.effort, self.max_tokens = model, effort, max_tokens

    def decide(self, system: str, blocks: list[str]) -> Decision:
        content = [{"type": "text", "text": b} for b in blocks]
        if len(content) > 1:
            # Cache through the last finished hand: the history only ever grows.
            content[-2]["cache_control"] = {"type": "ephemeral"}
        output_config: dict = {"format": {"type": "json_schema", "schema": SCHEMA}}
        if self.effort:
            output_config["effort"] = self.effort
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": content}],
            output_config=output_config,
        )
        u = resp.usage
        usage = {"input": u.input_tokens, "output": u.output_tokens,
                 "cache_read": u.cache_read_input_tokens or 0, "cache_write": u.cache_creation_input_tokens or 0,
                 "model": resp.model, "request_id": resp._request_id}
        if resp.stop_reason in ("refusal", "max_tokens"):
            raise ProviderError(f"stop_reason={resp.stop_reason}")
        text = next((b.text for b in resp.content if b.type == "text"), "")
        action, amount, reason = _parse(text)
        return Decision(action, amount, reason, usage, text)


class OpenAIProvider:
    name = "openai"

    def __init__(self, model: str, effort: str | None, max_tokens: int):
        from openai import OpenAI

        self.client = OpenAI()
        self.model, self.effort, self.max_tokens = model, effort, max_tokens

    def decide(self, system: str, blocks: list[str]) -> Decision:
        kwargs: dict = {}
        if self.effort:
            kwargs["reasoning"] = {"effort": self.effort}
        resp = self.client.responses.create(
            model=self.model,
            instructions=system,
            input=[{"role": "user", "content": [{"type": "input_text", "text": b} for b in blocks]}],
            text={"format": {"type": "json_schema", "name": "poker_action", "schema": SCHEMA, "strict": True}},
            max_output_tokens=self.max_tokens,
            **kwargs,
        )
        u = resp.usage
        details = getattr(u, "input_tokens_details", None)
        usage = {"input": u.input_tokens, "output": u.output_tokens,
                 "cache_read": getattr(details, "cached_tokens", 0) or 0, "model": resp.model, "request_id": resp.id}
        if resp.status != "completed":
            raise ProviderError(f"status={resp.status} {getattr(resp, 'incomplete_details', None)}")
        action, amount, reason = _parse(resp.output_text)
        return Decision(action, amount, reason, usage, resp.output_text)


class GeminiProvider:
    name = "gemini"

    def __init__(self, model: str, effort: str | None, max_tokens: int):
        from google import genai
        from google.genai import types

        self.types = types
        # Orcabot's broker: GEMINI_API_KEY is a placeholder and GOOGLE_GEMINI_BASE_URL the
        # broker URL that adds the real key. Pass both so neither GOOGLE_API_KEY nor the
        # default endpoint wins over them.
        base = os.environ.get("GOOGLE_GEMINI_BASE_URL")
        if base and os.environ.get("GEMINI_API_KEY"):
            self.client = genai.Client(api_key=os.environ["GEMINI_API_KEY"],
                                       http_options=types.HttpOptions(base_url=base))
        else:
            self.client = genai.Client()
        self.model, self.effort, self.max_tokens = model, effort, max_tokens

    def decide(self, system: str, blocks: list[str]) -> Decision:
        t = self.types
        cfg: dict = {"system_instruction": system, "response_mime_type": "application/json",
                     "response_json_schema": SCHEMA, "max_output_tokens": self.max_tokens}
        if self.effort:
            cfg["thinking_config"] = t.ThinkingConfig(thinking_level=self.effort)
        resp = self.client.models.generate_content(
            model=self.model,
            contents=[t.Content(role="user", parts=[t.Part(text=b) for b in blocks])],
            config=t.GenerateContentConfig(**cfg),
        )
        m = resp.usage_metadata
        usage = {"input": m.prompt_token_count, "output": (m.candidates_token_count or 0) + (m.thoughts_token_count or 0),
                 "cache_read": m.cached_content_token_count or 0, "model": resp.model_version,
                 "request_id": resp.response_id}
        if not resp.text:
            reason = resp.candidates[0].finish_reason if resp.candidates else "no candidates"
            raise ProviderError(f"empty response ({reason})")
        action, amount, reason = _parse(resp.text)
        return Decision(action, amount, reason, usage, resp.text)


PROVIDERS = {"anthropic": AnthropicProvider, "openai": OpenAIProvider, "gemini": GeminiProvider}


def make_provider(name: str, model: str | None, effort: str | None, max_tokens: int = 16000):
    model = model or DEFAULT_MODELS.get(name)
    if not model:
        raise SystemExit(f"--model is required for provider {name}")
    return PROVIDERS[name](model, effort, max_tokens)


# -- what the seat has observed ---------------------------------------------------
def describe_hand(h: dict, me: str, notes: list[dict]) -> str:
    """One finished hand as this seat saw it, with its own reasons."""
    head = f"Hand {h['hand']}"
    if h.get("blinds"):
        head += f" (level {h.get('level', 1)}, blinds {h['blinds'][0]}/{h['blinds'][1]})"
    lines = [head]
    stacks = h.get("start_stacks")
    pos = h["positions"]
    if me not in h["players"]:  # played after we were eliminated
        lines.append("  (you were out) Result: " + ", ".join(f"{s} {n:+d}" for s, n in h["net"].items() if n))
        return "\n".join(lines)
    others = [s for s in h["players"] if s != me]
    seats = [f"you {pos[me]}" + (f" {stacks[me]}" if stacks else "")] + \
            [f"{s} {pos[s]}" + (f" {stacks[s]}" if stacks else "") for s in others]
    lines.append("  Seats (position, chips): " + "; ".join(seats))
    lines.append(f"  Your cards: {' '.join(h['hole'].get(me) or [])}.  Board: {' '.join(h['board']) or '-'}")
    if h["actions"]:
        lines.append("  Actions: " + "; ".join(f"[{a['street']}] {_fmt_action(a, me)}" for a in h["actions"]))
    for o in others:
        if h["hole"].get(o):
            lines.append(f"  {o} showed: {' '.join(h['hole'][o])}")
    net = h["net"][me]
    lines.append(f"  Result: you {'won' if net > 0 else 'lost' if net < 0 else 'broke even'} {abs(net)}"
                 + ("; others: " + ", ".join(f"{s} {h['net'][s]:+d}" for s in others if h["net"][s])
                    if len(others) > 1 else "")
                 + (f"; your stack after: {h['end_stacks'][me]}" if h.get("end_stacks") else ""))
    for n in notes:
        lines.append(f"  Your reason ({n['street']} {n['action']}): {n['reason']}")
    return "\n".join(lines)


def describe_now(view: dict, notes: list[dict]) -> str:
    v = {k: val for k, val in view.items() if k != "previous_hand"}  # already in the history
    lines = [ln for ln in render(v).splitlines() if not ln.startswith("Act with:")]
    for n in notes:
        lines.append(f"Your reason earlier this hand ({n['street']} {n['action']}): {n['reason']}")
    return "CURRENT HAND\n" + "\n".join(lines)


def build_request(view: dict, history: list[dict], notes: dict[int, list[dict]]) -> tuple[str, list[str]]:
    me = view["you"]["seat"]
    n = len(view["match"]["seats"])
    table = ("a heads-up no-limit Texas hold'em match against one opponent" if n == 2 else
             f"a {n}-player no-limit Texas hold'em "
             f"{'tournament' if view['match'].get('format') == 'tournament' else 'game'} against {n - 1} opponents")
    system = SYSTEM.format(table=table, rules=rules_text(view["match"], for_cli=False))
    blocks = [describe_hand(h, me, notes.get(h["hand"], [])) for h in history]
    if not blocks:
        blocks = ["No hands have finished yet."]
    blocks.append(describe_now(view, notes.get(view["match"]["hand"], [])))
    return system, blocks


# -- the seat loop ------------------------------------------------------------------
def play(client: Client, provider, max_retries: int = 2, log_path: Path | None = None,
         max_wait: float = 100.0) -> dict:
    """Play until the match is over. Returns the final view."""
    notes: dict[int, list[dict]] = {}
    logf = open(log_path, "a", encoding="utf-8") if log_path else None

    def record(entry: dict) -> None:
        if logf:
            logf.write(json.dumps(entry, sort_keys=True) + "\n")
            logf.flush()

    try:
        while True:
            view = client.wait_for_turn(max_wait)
            if view["match"]["status"] == "finished":
                return view
            if not view.get("to_act"):
                continue
            hand = view["match"]["hand"]
            history = client.history(200)["hands"]
            system, blocks = build_request(view, history, notes)
            error = None
            acted = False
            for attempt in range(max_retries + 1):
                req_blocks = blocks + ([f"Your previous answer was rejected: {error}. Choose again."] if error else [])
                started = time.monotonic()
                entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "hand": hand,
                         "street": view.get("street"), "attempt": attempt, "provider": provider.name,
                         "model": provider.model, "effort": provider.effort,
                         "prompt_chars": len(system) + sum(map(len, req_blocks))}
                try:
                    d = provider.decide(system, req_blocks)
                except ProviderError as e:
                    entry.update(error=str(e), latency_s=round(time.monotonic() - started, 3))
                    record(entry)
                    error = str(e)
                    continue
                except Exception as e:  # SDK errors after its own retries: give up on this attempt
                    entry.update(error=f"{type(e).__name__}: {e}"[:500], latency_s=round(time.monotonic() - started, 3))
                    record(entry)
                    error = None
                    time.sleep(2)
                    continue
                entry.update(latency_s=round(time.monotonic() - started, 3), usage=d.usage,
                             action=d.action, amount=d.amount, reason=d.reason)
                try:
                    client.act(d.action, d.amount, d.reason)
                except ApiError as e:
                    entry["rejected"] = e.body.get("error")
                    record(entry)
                    if e.body.get("error") in ("not_your_turn", "not_running"):
                        acted = True  # the turn timed out meanwhile; nothing to do
                        break
                    error = f"{e.body.get('message')} Legal right now: {json.dumps(e.body.get('legal'))}"
                    continue
                record(entry)
                notes.setdefault(hand, []).append({"street": view.get("street"), "action": d.action,
                                                   "reason": d.reason})
                acted = True
                break
            if not acted:
                legal = view.get("legal") or {}
                action = "check" if "check" in legal else "fold"
                try:
                    client.act(action, None, f"[auto] no valid model decision after {max_retries + 1} tries")
                except ApiError:
                    pass
                record({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "hand": hand,
                        "street": view.get("street"), "auto_action": action, "last_error": error})
    finally:
        if logf:
            logf.close()
