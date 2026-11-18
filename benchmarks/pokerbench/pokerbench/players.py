# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-players-v1-linked-seats
"""What plays in a seat.

In Orcabot every player is a component linked to the engine terminal: a seat terminal
(any terminal running the seat script, bin/seat) or an Agent block. A seat terminal can
play any of the kinds below; which one is chosen on the table page before the start
(the terminal's PLAYER= is only its default). An Agent block is always "agent".

A player is a small dict: {"kind": ..., plus "model" (agents and API models),
"provider" and "effort" (API models), "strategy" (the house bot)}.
"""

from __future__ import annotations

import re

PLAYERS_REVISION = "pokerbench-players-v1-linked-seats"

KINDS = {
    "claude-code": "Claude Code",
    "codex": "Codex",
    "gemini-cli": "Gemini CLI",
    "api": "Model via API",
    "house": "House bot",
    "agent": "Agent block",
}
# What the table page can choose for a seat terminal. "agent" is an Agent block's only kind.
TERMINAL_KINDS = ("claude-code", "codex", "gemini-cli", "api", "house")
PROVIDERS = ("anthropic", "openai", "gemini")
STRATEGIES = ("tight", "random", "call")
DEFAULT_API_MODEL = {"anthropic": "claude-opus-5-5"}  # the others need a model named
MODEL_ID = re.compile(r"[A-Za-z0-9._:/@+-]{0,100}")
EFFORT = re.compile(r"[a-z]{0,16}")


class PlayerError(ValueError):
    pass


def normalize(player: dict, *, allow_agent: bool = False) -> dict:
    """A valid player dict with only the fields its kind uses, or PlayerError."""
    if not isinstance(player, dict):
        raise PlayerError("A player must be a JSON object.")
    kind = player.get("kind")
    kinds = TERMINAL_KINDS + (("agent",) if allow_agent else ())
    if kind not in kinds:
        raise PlayerError(f"kind must be one of {', '.join(kinds)}.")
    out: dict = {"kind": kind}
    model = player.get("model") or ""
    if not isinstance(model, str) or not MODEL_ID.fullmatch(model):
        raise PlayerError("model: letters, digits and . _ : / @ + - only (up to 100).")
    if kind in ("claude-code", "codex", "gemini-cli"):
        if model:
            out["model"] = model
    elif kind == "api":
        provider = player.get("provider") or "anthropic"
        if provider not in PROVIDERS:
            raise PlayerError(f"provider must be one of {', '.join(PROVIDERS)}.")
        model = model or DEFAULT_API_MODEL.get(provider, "")
        if not model:
            raise PlayerError(f"Name the {provider} model to play.")
        effort = player.get("effort") or ""
        if not isinstance(effort, str) or not EFFORT.fullmatch(effort):
            raise PlayerError("effort: a word like low, medium or high (or blank).")
        out.update(provider=provider, model=model, **({"effort": effort} if effort else {}))
    elif kind == "house":
        strategy = player.get("strategy") or "tight"
        if strategy not in STRATEGIES:
            raise PlayerError(f"strategy must be one of {', '.join(STRATEGIES)}.")
        out["strategy"] = strategy
    elif kind == "agent":
        name = player.get("name") or ""
        if isinstance(name, str) and name:
            out["name"] = name[:80]
    return out


def label(player: dict | None) -> str:
    """How the table shows a player: "Claude Code (opus)", "anthropic/claude-opus-5-5 (API)"."""
    if not player:
        return ""
    kind = player.get("kind")
    if kind == "api":
        return f"{player.get('provider')}/{player.get('model')} (API)"
    if kind == "house":
        return f"House bot ({player.get('strategy', 'tight')})"
    if kind == "agent":
        return f"{player.get('name') or 'agent'} (Agent block)"
    base = KINDS.get(kind, kind or "")
    return f"{base} ({player['model']})" if player.get("model") else base


def seat_name(terminal_name: str, taken: set[str]) -> str:
    """A seat name from a canvas name: "Seat: Claude Code" -> "claude-code", unique in taken."""
    name = re.sub(r"^\s*(seat|player)\s*[:\-]\s*", "", terminal_name or "", flags=re.I)
    base = re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-._")[:28] or "player"
    if not re.match(r"[a-z0-9]", base):
        base = "p" + base
    seat, n = base, 2
    while seat in taken:
        seat, n = f"{base}-{n}", n + 1
    return seat
