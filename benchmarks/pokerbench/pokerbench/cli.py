# Copyright 2026 Rob Macrae. All rights reserved.
# SPDX-License-Identifier: LicenseRef-Proprietary

# REVISION: pokerbench-cli-v9-match-over-stop
"""``poker`` -- the command agents play with.

    poker rules                     how the game works
    poker wait                      block until it is your turn (then shows the table)
    poker state                     show the table now
    poker act check|call|fold       act
    poker act bet|raise <total>     bet or raise TO a street total
    poker act allin
    poker history [n]               your last n hands

Add --reason "..." to ``act`` to record why. Add --json for machine output.
Config: POKER_URL (default http://127.0.0.1:8765); POKER_SEAT (your seat name);
POKER_SEAT_TOKEN or POKER_TOKEN_FILE where a token is used. In Orcabot's PTY
pool the engine identifies you by your OS user and no token is needed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

CLI_REVISION = "pokerbench-cli-v9-match-over-stop"
DEFAULT_URL = "http://127.0.0.1:8765"
WAIT_CHUNK_S = 30.0
# Agents' shell tools usually time out at ~2 minutes; return before that.
DEFAULT_WAIT_S = 100.0

RULES = """\
PokerBench -- heads-up no-limit Texas hold'em, you against one opponent.

- Blinds {sb}/{bb}. Every hand starts with {stack} chips each (stacks reset), so
  each hand is independent. Your score is your total chips won or lost.
- Heads-up order: the button posts the small blind and acts FIRST preflop and
  LAST on the flop, turn and river. Positions alternate.
- Cards are written rank+suit: A K Q J T 9..2 and s h d c. "Td" = ten of diamonds.
- Bet and raise amounts are the TOTAL you want in front of you on this street
  ("raise 300" means raise to 300), not the amount added.
- You have {timeout:.0f} seconds per decision. If time runs out you check if that
  is free, otherwise you fold.
- Each deal is played twice with the seats swapped (duplicate poker), so luck
  mostly cancels out.

Loop: `poker wait` -> decide -> `poker act <action> [amount] --reason "<why>"`
-> `poker wait` again, until the match is over.
"""

TOURNAMENT_RULES = """\
PokerBench -- a heads-up no-limit Texas hold'em TOURNAMENT, you against one opponent.

- You each start with {stack} chips. Stacks carry over from hand to hand.
- The tournament ends when one player has all the chips, or after {limit} hands;
  then the bigger stack wins. Your result is your final chip count.
- The blinds go up every {level_hands} hands:
{levels}
- Heads-up order: the button posts the small blind and acts FIRST preflop and
  LAST on the flop, turn and river. Positions alternate every hand.
- Cards are written rank+suit: A K Q J T 9..2 and s h d c. "Td" = ten of diamonds.
- Bet and raise amounts are the TOTAL you want in front of you on this street
  ("raise 300" means raise to 300), not the amount added.
- You have {timeout:.0f} seconds per decision. If time runs out you check if that
  is free, otherwise you fold.

Loop: `poker wait` -> decide -> `poker act <action> [amount] --reason "<why>"`
-> `poker wait` again, until the tournament is over.
"""


RING_ORDER = """\
- Table order: {seats}. The button moves one seat clockwise every hand
  (to the next player still in). The two players after the button post the
  small and big blinds. Preflop the player after the big blind acts first;
  after the flop the first player still in after the button acts first.
- Positions: small blind, big blind, UTG (first to act preflop), ..., lojack,
  hijack, cutoff, button (last to act after the flop)."""

RING_CASH = """\
PokerBench -- {n}-player no-limit Texas hold'em, you against {others} opponents.

- Blinds {sb}/{bb}. Every hand starts with {stack} chips each (stacks reset), so
  each hand is independent. Your score is your total chips won or lost.
{order}
- Cards are written rank+suit: A K Q J T 9..2 and s h d c. "Td" = ten of diamonds.
- Bet and raise amounts are the TOTAL you want in front of you on this street
  ("raise 300" means raise to 300), not the amount added. Side pots are handled
  automatically when someone is all in.
- You have {timeout:.0f} seconds per decision. If time runs out you check if that
  is free, otherwise you fold.
- Each deal is replayed with the seats rotated so every player holds every hand
  from every position (duplicate poker), so luck mostly cancels out.

Loop: `poker wait` -> decide -> `poker act <action> [amount] --reason "<why>"`
-> `poker wait` again, until the match is over.
"""

RING_TOURNAMENT = """\
PokerBench -- a {n}-player no-limit Texas hold'em TOURNAMENT, you against {others} opponents.

- You each start with {stack} chips. Stacks carry over from hand to hand. A
  player with no chips left is eliminated; places are decided by the order of
  elimination.
- The tournament ends when one player has all the chips, or after {limit} hands;
  then the remaining players are ranked by chip count. Your result is your
  finishing place, then your final chip count.
- The blinds go up every {level_hands} hands:
{levels}
{order}
- Cards are written rank+suit: A K Q J T 9..2 and s h d c. "Td" = ten of diamonds.
- Bet and raise amounts are the TOTAL you want in front of you on this street
  ("raise 300" means raise to 300), not the amount added. Side pots are handled
  automatically when someone is all in.
- You have {timeout:.0f} seconds per decision. If time runs out you check if that
  is free, otherwise you fold.

Loop: `poker wait` -> decide -> `poker act <action> [amount] --reason "<why>"`
-> `poker wait` again, until the tournament is over.
"""


def rules_text(m: dict, for_cli: bool = True) -> str:
    """The rules for this match. for_cli=False drops the `poker` command loop
    (direct model seats answer one decision at a time, with no shell)."""
    text = _rules_text(m)
    return text if for_cli else text.split("\nLoop:")[0].rstrip() + "\n"


def _rules_text(m: dict) -> str:
    t = m.get("tournament")
    n = len(m.get("seats") or [0, 0])
    if n > 2:
        order = RING_ORDER.format(seats=", ".join(m["seats"]))
        if not t:
            return RING_CASH.format(n=n, others=n - 1, sb=m["blinds"][0], bb=m["blinds"][1],
                                    stack=m["starting_stack"], order=order, timeout=m["turn_timeout_s"])
        k, limit = t["level_hands"], t["hand_limit"]
        levels = "\n".join(f"    Level {i + 1:>2} (hands {i * k + 1}-{min((i + 1) * k, limit)}): {sb}/{bb}"
                           for i, (sb, bb) in enumerate(t["blind_levels"]))
        return RING_TOURNAMENT.format(n=n, others=n - 1, stack=m["starting_stack"], limit=limit, level_hands=k,
                                      levels=levels, order=order, timeout=m["turn_timeout_s"])
    if not t:
        return RULES.format(sb=m["blinds"][0], bb=m["blinds"][1], stack=m["starting_stack"],
                            timeout=m["turn_timeout_s"])
    n, limit = t["level_hands"], t["hand_limit"]
    levels = "\n".join(
        f"    Level {i + 1:>2} (hands {i * n + 1}-{min((i + 1) * n, limit)}): {sb}/{bb}"
        for i, (sb, bb) in enumerate(t["blind_levels"])
    )
    return TOURNAMENT_RULES.format(stack=m["starting_stack"], limit=limit, level_hands=n, levels=levels,
                                   timeout=m["turn_timeout_s"])


def _bb(chips: int, bb: int) -> str:
    return f"{chips / bb:.1f} bb"


class ApiError(Exception):
    def __init__(self, status: int, body: dict):
        super().__init__(body.get("message") or str(body))
        self.status = status
        self.body = body


def _token() -> str | None:
    token = os.environ.get("POKER_SEAT_TOKEN")
    if token:
        return token.strip()
    path = os.environ.get("POKER_TOKEN_FILE")
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                return f.read().strip() or None
        except OSError:  # unreadable by design when seats run as their own OS users
            return None
    return None


def _published() -> dict:
    """In Orcabot, where nothing told this process its seat (an agent started in its own
    terminal before the game): the engine's address from engine.env, and this terminal's
    seat from seats.json (the engine maps each terminal linked to it to a seat), both
    published next to this file."""
    pub = os.environ.get("POKER_PUB") or os.path.dirname(os.path.abspath(__file__))
    out: dict = {}
    try:
        with open(os.path.join(pub, "engine.env"), encoding="utf-8") as f:
            for line in f:
                key, _, value = line.strip().partition("=")
                out[key] = value.strip('"')
    except OSError:
        return out
    try:
        with open(os.path.join(pub, "seats.json"), encoding="utf-8") as f:
            seat = json.load(f).get("by_pty", {}).get(os.environ.get("ORCABOT_PTY_ID", ""))
        if seat:
            out["POKER_SEAT"] = seat
    except (OSError, ValueError):
        pass
    return out


class Client:
    def __init__(self, url: str | None = None, token: str | None = None, timeout: float = 70.0,
                 seat: str | None = None, info: str | None = None):
        found = _published() if not (url or os.environ.get("POKER_URL")) or not (
            seat or os.environ.get("POKER_SEAT")) else {}
        self.url = (url or os.environ.get("POKER_URL") or found.get("POKER_URL") or DEFAULT_URL).rstrip("/")
        self.seat = seat if seat is not None else (os.environ.get("POKER_SEAT") or found.get("POKER_SEAT") or None)
        self.token = token if token is not None else _token()
        if self.token is None and self.seat and found.get("POKER_TOKENS_DIR"):
            try:  # readable where seats share the engine's user (no PTY pool)
                with open(os.path.join(found["POKER_TOKENS_DIR"], f"{self.seat}.token"), encoding="utf-8") as f:
                    self.token = f.read().strip() or None
            except OSError:
                pass
        # Who is playing this seat, e.g. "anthropic/claude-code": self-reported, first one wins.
        self.info = info if info is not None else (os.environ.get("POKER_SEAT_INFO") or None)
        self.timeout = timeout

    def _req(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("User-Agent", f"poker-cli/{CLI_REVISION}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        if self.seat:
            req.add_header("X-Poker-Seat", self.seat)
        if self.info:
            req.add_header("X-Poker-Seat-Info", self.info)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read() or b"{}")
            except ValueError:
                payload = {"error": "http", "message": f"HTTP {e.code}"}
            raise ApiError(e.code, payload) from None

    def state(self) -> dict:
        return self._req("GET", "/api/seat/state")

    def wait(self, timeout: float) -> dict:
        return self._req("GET", f"/api/seat/wait?timeout={timeout:.1f}")

    def act(self, action: str, amount: int | None = None, reason: str | None = None) -> dict:
        body: dict = {"action": action}
        if amount is not None:
            body["amount"] = amount
        if reason:
            body["reason"] = reason
        return self._req("POST", "/api/seat/act", body)

    def history(self, n: int) -> dict:
        return self._req("GET", f"/api/seat/history?n={n}")

    def wait_for_turn(self, total: float) -> dict:
        deadline = time.monotonic() + total
        while True:
            left = deadline - time.monotonic()
            view = self.wait(max(0.0, min(WAIT_CHUNK_S, left)))
            if view.get("to_act") or view["match"]["status"] == "finished" or left <= WAIT_CHUNK_S:
                return view


# -- rendering ----------------------------------------------------------------
def _fmt_action(a: dict, me: str) -> str:
    who = "you" if a["seat"] == me else a["seat"]
    if a["action"] in ("bet", "raise"):
        s = f"{who} {a['action']} to {a['to']}"
        return s + " (all-in)" if a.get("allin") else s
    if a["action"] == "call":
        return f"{who} call {a['amount']}"
    return f"{who} {a['action']}"


def _fmt_result(r: dict, me: str) -> str:
    if me not in r["players"]:  # a hand played after we were eliminated
        winners = ", ".join(f"{s} {n:+d}" for s, n in r["net"].items() if n > 0)
        return f"Hand {r['hand']} result: {winners or 'no winner'}."
    others = [s for s in r["players"] if s != me]
    net = r["net"][me]
    lines = [f"Hand {r['hand']} result: you {'won' if net > 0 else 'lost' if net < 0 else 'broke even'}"
             f" {abs(net)} chips ({r['positions'][me]})."]
    lines.append(f"  Your cards: {' '.join(r['hole'][me] or [])}   Board: {' '.join(r['board']) or '-'}")
    shown = [s for s in others if r["hole"].get(s)]
    for s in shown:
        lines.append(f"  {s} showed: {' '.join(r['hole'][s])}")
    if not r["showdown"]:
        lines.append("  No showdown; " + (f"{others[0]}'s cards stay" if len(others) == 1 else "other cards stay")
                     + " hidden.")
    if len(others) > 1:
        moved = ", ".join(f"{s} {r['net'][s]:+d}" for s in others if r["net"][s])
        if moved:
            lines.append(f"  Others: {moved}")
    if r["actions"]:
        lines.append("  Actions: " + "; ".join(f"[{a['street']}] {_fmt_action(a, me)}" for a in r["actions"]))
    return "\n".join(lines)


# Every MATCH OVER ends with this: the prompt tells an agent to loop until MATCH OVER, and a
# game ended early from the table page must stop it too, not leave it listening.
STOP_LINE = "The game is over: stop playing. Don't run `poker` again; just report your final score."
ENDED = "ended early from the table page"


def match_over_lines(view: dict) -> list[str]:
    final = view.get("final", {})
    reason = final.get("finish_reason")
    played = view["score"]["hands_played"]
    out = []
    tour = final.get("tournament")
    if tour:
        how = {"bust": "a player has all the chips", "hand_limit": "hand limit reached",
               "ended": ENDED}.get(reason, reason)
        who = (f"Leader: {tour['winner'] or 'nobody (tie)'}" if reason == "ended"
               else f"Winner: {tour['winner'] or 'nobody (tie)'}")
        out.append(f"MATCH OVER (tournament) after {played} hands -- {how}. {who}.")
        for row in tour.get("standings") or [{"seat": s, "chips": c, "place": None}
                                             for s, c in sorted(tour["chips"].items(), key=lambda kv: -kv[1])]:
            place = f"{row['place']}. " if row.get("place") else ""
            gone = f" (eliminated hand {row['eliminated_hand']})" if row.get("eliminated_hand") else ""
            out.append(f"  {place}{row['seat']}: {row['chips']} chips{gone}")
    else:
        how = f" -- {ENDED}" if reason == "ended" else ""
        out.append(f"MATCH OVER after {played} hands{how}. Your total: {view['score']['net_chips']:+d} chips.")
        for row in final.get("leaderboard", []):
            out.append(f"  {row['seat']}: {row['net_chips']:+d} chips, {row['bb_per_100']} bb/100")
    if final.get("abandoned_hand"):
        out.append(f"  (Hand {final['abandoned_hand']} was in progress when the game ended; it doesn't count.)")
    return out


def render(view: dict) -> str:
    m = view["match"]
    me = view.get("you", {}).get("seat")
    out = []
    if m["status"] == "waiting_for_players":
        return ("Waiting for players to join: " + ", ".join(view.get("waiting_for", []))
                + ". Run `poker wait` again.")
    if m.get("paused") and m["status"] == "running" and not view.get("to_act"):
        return "The game is paused. Run `poker wait` again; it continues when the game resumes."
    if m["status"] == "finished":
        return "\n".join(match_over_lines(view) + [STOP_LINE])

    if view.get("eliminated"):
        e = view["eliminated"]
        left = (m.get("tournament") or {}).get("players_left")
        return (f"You were eliminated" + (f" in place {e['place']}" if e.get("place") else "")
                + (f" on hand {e['hand']}" if e.get("hand") else "") + ". The tournament continues"
                + (f" with {left} players" if left else "") + "; run `poker wait` to see the final result.")

    prev = view.get("previous_hand")
    # Lead with the last hand's result until we have acted in the new one.
    acted = any(a["seat"] == me for a in view.get("actions", []))
    if prev and me and prev["hand"] == (m["hand"] or 0) - 1 and not acted:
        out.append(_fmt_result(prev, me))
        out.append("")
    you = view["you"]
    players = view.get("players") or [you, view["opponent"]]
    ring = len(players) > 2
    opp = view.get("opponent") or {"seat": view.get("actor") or "the others"}
    tour = m.get("tournament")
    sb, bb = m["blinds"]
    if tour:
        nxt = (f"{tour['next_blinds'][0]}/{tour['next_blinds'][1]} in {tour['hands_left_in_level']} hand(s)"
               if tour["next_blinds"] else "final level")
        out.append(f"Hand {m['hand']}/{m['hands_total']}  ·  Level {tour['level']}: blinds {sb}/{bb} "
                   f"(next {nxt})  ·  {view['street']}  ·  You: {you['position']}")
    else:
        out.append(f"Hand {m['hand']}/{m['hands_total']}  ·  {view['street']}  ·  You: {you['position']}"
                   f"  ·  Score so far: {view['score']['net_chips']:+d} chips")
    out.append(f"Your cards: {' '.join(you['hole'])}")
    out.append(f"Board: {' '.join(view['board']) or '(none yet)'}")
    if ring:
        out.append(f"Pot: {view['pot']} (including the bets in front of players this street)")
        out.append("Table (in seat order):")
        for p in players:
            mark = "you" if p["seat"] == me else p["seat"]
            to_act = "  <- to act" if p["seat"] == view.get("actor") else ""
            out.append(f"  {mark:<14} {p['position']:<12} stack {p['stack']} ({_bb(p['stack'], bb)}), "
                       f"bet {p['bet']}, {p['status']}{to_act}")
    else:
        out.append(f"Pot: {view['pot']} (including bets this street: you {you['bet']}, {opp['seat']} {opp['bet']})")
    if ring:
        pass
    elif tour:
        out.append(f"Stacks behind: you {you['stack']} ({_bb(you['stack'], bb)}), "
                   f"{opp['seat']} {opp['stack']} ({_bb(opp['stack'], bb)})")
    else:
        out.append(f"Stacks: you {you['stack']}, {opp['seat']} {opp['stack']}")
    if view.get("actions"):
        out.append("This hand: " + "; ".join(f"[{a['street']}] {_fmt_action(a, me)}" for a in view["actions"]))
    if view.get("to_act"):
        legal = view["legal"]
        opts = []
        if "check" in legal:
            opts.append("check")
        if "call" in legal:
            opts.append(f"call (costs {legal['call']})")
        for kind in ("bet", "raise"):
            if kind in legal:
                opts.append(f"{kind} <total {legal[kind]['min']}..{legal[kind]['max']}>")
        if "bet" in legal or "raise" in legal:
            opts.append("allin")
        if "fold" in legal:
            opts.append("fold")
        out.append(f"YOUR TURN ({view.get('seconds_left', '?')}s left). Options: " + " | ".join(opts))
        out.append('Act with: poker act <action> [amount] --reason "<why>"')
    else:
        out.append(f"Waiting for {view.get('actor') or opp['seat']}. Run `poker wait`.")
    return "\n".join(out)


def render_act(resp: dict) -> str:
    view = resp["state"]
    # The action that ends the match leaves no "you" block in the view.
    me = view.get("you", {}).get("seat") or view.get("seat") or ""
    out = [f"OK: {_fmt_action(resp['applied'], me)}."]
    if resp.get("hand_result"):
        out.append(_fmt_result(resp["hand_result"], me))
    if view.get("to_act"):
        out.append("")
        out.append(render(view))
    elif view["match"]["status"] == "finished":
        out.append(render(view))
    else:
        out.append("Now run `poker wait` for your next turn.")
    return "\n".join(out)


def render_history(hands: list[dict], me: str) -> str:
    if not hands:
        return "No finished hands yet."
    return "\n\n".join(_fmt_result(h, me) for h in hands)


# -- entry point ----------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="poker", description="Play PokerBench. Start with `poker rules`.")
    p.add_argument("--json", action="store_true", help="print raw JSON")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("rules", help="how the game works")
    sub.add_parser("state", help="show the table now")
    w = sub.add_parser("wait", help="block until it is your turn")
    w.add_argument("--timeout", type=float, default=DEFAULT_WAIT_S, help="max seconds to wait (default 100)")
    a = sub.add_parser("act", help="fold | check | call | bet N | raise N | allin")
    a.add_argument("action", choices=["fold", "check", "call", "bet", "raise", "allin"])
    a.add_argument("amount", nargs="?", type=int, help="street TOTAL for bet/raise")
    a.add_argument("--reason", help="why (recorded with the decision)")
    h = sub.add_parser("history", help="your last N finished hands")
    h.add_argument("n", nargs="?", type=int, default=3)
    args = p.parse_args(argv)

    client = Client()
    if args.cmd != "rules" and not client.token and not client.seat:
        print("No seat: set POKER_SEAT (and POKER_TOKEN_FILE where tokens are used).", file=sys.stderr)
        return 1
    try:
        if args.cmd == "rules":
            view = client.state() if (client.token or client.seat) else None
            m = (view or {}).get("match") or {"blinds": [50, 100], "starting_stack": 10000, "turn_timeout_s": 120}
            print(rules_text(m))
            for notice in m.get("notices") or []:
                print(f"Note: {notice}")
            return 0
        if args.cmd == "state":
            view = client.state()
            print(json.dumps(view, indent=2) if args.json else render(view))
        elif args.cmd == "wait":
            view = client.wait_for_turn(args.timeout)
            print(json.dumps(view, indent=2) if args.json else render(view))
        elif args.cmd == "act":
            resp = client.act(args.action, args.amount, args.reason)
            print(json.dumps(resp, indent=2) if args.json else render_act(resp))
        elif args.cmd == "history":
            resp = client.history(args.n)
            print(json.dumps(resp, indent=2) if args.json else render_history(resp["hands"], resp["seat"]))
        return 0
    except ApiError as e:
        if args.json:
            print(json.dumps(e.body, indent=2))
        else:
            print(f"ERROR ({e.body.get('error')}): {e.body.get('message')}")
            if e.body.get("legal"):
                print("Legal right now: " + json.dumps(e.body["legal"]))
        return 3 if e.body.get("error") == "not_your_turn" else 2
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        print(f"Cannot reach the poker engine at {client.url}: {e}", file=sys.stderr)
        if isinstance(getattr(e, "reason", e), ConnectionRefusedError):
            # The engine exits once a game is over (or ended from the table page).
            print("The engine isn't running, so there is no game now: stop playing and don't run `poker`"
                  " again.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
