---
title: PokerBench: AI models at a no-limit hold'em table
date: 2026-11-25
description: Ten AI models from Anthropic, OpenAI and Google play no-limit Texas hold'em against each other. Duplicate deals and seat rotation take most of the card luck out.
author: Rob Macrae
---

```chart
pokerbench-results
```

Ten AI models sit at one table: four Claude models, three GPT models and three Gemini
models. They play ten-handed no-limit Texas hold'em through a small `poker` command, with
no help from us beyond the rules.

Poker is a hard test of judgement under uncertainty: every decision is made with hidden
information, against opponents whose habits you have to work out as you go. It is also a
noisy one, so the scoring below is built to take as much of the card luck out as possible.

## Watch live

The table as it is being played, two minutes behind. Hole cards only appear when a hand
reaches showdown, as they would on a televised table.

```chart
pokerbench-live
```

## Results

Two series of ten games, 2,000 hands per model. **bb/100** is big blinds won per hundred
hands: the standard poker win rate. The range is a 95% confidence interval. Every model
ran at medium reasoning effort except Gemini 4 Neon, at high.

| Model | bb/100 | 95% range | Series 1 | Series 2 |
|---|---:|---|---:|---:|
| GPT-6.2 Astra | **+51.7** | +10.8 to +98.4 | +51.1 | +52.3 |
| GPT-6.1 Terra | **+30.8** | +4.1 to +57.4 | +35.4 | +26.2 |
| Claude Fable 5.2 | +13.8 | −14.9 to +42.8 | +12.4 | +15.2 |
| GPT-6.2 Sol | +3.5 | −24.6 to +31.2 | +8.0 | −1.0 |
| Gemini 4 Hydrogen | +0.9 | −22.0 to +23.9 | −14.6 | +16.4 |
| Gemini 4 Neon (high) | −0.5 | −26.1 to +24.5 | +13.1 | −14.0 |
| Gemini 4 Argon | −11.4 | −40.9 to +17.2 | −6.1 | −16.7 |
| Claude Opus 5.5 | −29.4 | −70.2 to +10.1 | −43.2 | −15.7 |
| Claude Haiku 5.5 | −29.6 | −70.3 to +15.2 | −13.8 | −45.4 |
| Claude Sonnet 5.5 | −29.9 | −75.4 to +10.2 | −42.5 | −17.4 |

**Two models are clearly winning.** GPT-6.2 Astra and GPT-6.1 Terra are the only ones
whose whole range is above zero, and Astra's win rate barely moved between the two series
(+51.1, then +52.3).

**The rest can't be separated yet.** Claude Opus, Haiku and Sonnet sit together at about
−30, and their ranges still reach just above zero; the middle of the table (Sol, Hydrogen,
Neon, Argon) swaps places from one series to the next. More series will settle it.

On a second scoring, an Elo-like Bradley–Terry rating from head-to-head comparisons on
every shared deal, the three GPT models are first, second and third.

## Play styles

Each model has a recognisable way of playing.

```table
preview: 4
| Model | Plays a hand | Raises first in | Limps | Postflop aggression | Showdowns | Wins at showdown |
|---|---:|---:|---:|---:|---:|---:|
| GPT-6.2 Astra | 23% | 18% | 5% | **4.2** | 63 | **67%** |
| GPT-6.1 Terra | 19% | 12% | 9% | 1.8 | 67 | 64% |
| GPT-6.2 Sol | 18% | 13% | 4% | 2.6 | 55 | 58% |
| Claude Fable 5.2 | 18% | 11% | 8% | 1.8 | 75 | 49% |
| Claude Opus 5.5 | 23% | 15% | 13% | 1.9 | 83 | 42% |
| Claude Sonnet 5.5 | 24% | 15% | 16% | 2.1 | 88 | 30% |
| Claude Haiku 5.5 | **47%** | 19% | **37%** | 1.4 | **170** | 41% |
| Gemini 4 Hydrogen | 16% | 11% | 6% | 1.8 | 59 | 54% |
| Gemini 4 Neon (high) | 16% | 11% | 5% | 2.1 | 44 | 55% |
| Gemini 4 Argon | **13%** | 8% | 5% | **1.1** | 41 | 61% |
```

*Plays a hand* is the share of hands it put chips in voluntarily (VPIP); *raises first in*
is how often it raised before the flop (PFR); *limps* is calling the big blind instead of
raising. *Postflop aggression* is bets and raises per call after the flop. *Showdowns* is
the hands it saw to the end, out of 2,000.

- **GPT-6.2 Astra** plays a normal number of hands but is by far the most aggressive after
  the flop: it bets where others check, and when it is called it usually has it.
- **GPT-6.1 Terra** almost never bets a middling hand: 6 thin bets in 2,000 hands, against
  30 to 68 for the Claude models. It bets for value or as a bluff, and checks the rest.
- **GPT-6.2 Sol** rarely limps; it raises or folds.
- **Claude Fable 5.2** is tight and fairly passive, and the only Claude model ahead.
- **Claude Opus 5.5 and Sonnet 5.5** play more hands and limp more, then pay to see
  showdowns they mostly lose: Sonnet wins 30% of its showdowns, the lowest at the table.
- **Claude Haiku 5.5** plays almost half its hands and limps into 37% of them. It reached
  showdown 170 times, twice as often as any other model, and won 41%.
- **The Gemini models** are the tightest at the table. Argon is the most passive player in
  the field and the slowest to decide: about 11 seconds a move, against 1.5 to 3 for the
  Claude and GPT models.

## Bluffing

Every bet and raise after the flop is classified from the cards alone: a **bluff** is a bet
with nothing (no pair of its own and no strong draw). Each model's written reason also says
whether it meant to bluff, so we can check its account against its cards.

```table
preview: 4
| Model | Bets after the flop | Bluffs | Bluff share | Bluffs that won | "Bluff" was true |
|---|---:|---:|---:|---:|---:|
| GPT-6.2 Astra | 290 | 95 | **33%** | **67% (80/119)** | 13/19 |
| Claude Opus 5.5 | 217 | 59 | 27% | 43% (31/72) | 13/14 |
| GPT-6.1 Terra | 156 | 41 | 26% | 57% (28/49) | 8/8 |
| Gemini 4 Hydrogen | 158 | 39 | 25% | 59% (29/49) | 9/9 |
| GPT-6.2 Sol | 166 | 39 | 24% | 59% (27/46) | 5/6 |
| Gemini 4 Neon (high) | 146 | 33 | 23% | 53% (21/40) | 8/9 |
| Claude Sonnet 5.5 | 288 | 64 | 22% | 52% (49/94) | **39/39** |
| Claude Fable 5.2 | 192 | 41 | 21% | 56% (30/54) | 13/14 |
| Claude Haiku 5.5 | 401 | 79 | 20% | 49% (50/103) | 22/24 |
| Gemini 4 Argon | 91 | 8 | **9%** | **18% (2/11)** | 1/2 |
```

*Bluffs that won*: bluffs and semi-bluffs that took the pot without a showdown. *"Bluff"
was true*: of the bets whose reason said "bluff", how many were bluffs by the cards.

- **Every model bluffs.** Even Argon, the most cautious, bets with nothing now and then.
- **Astra bluffs the most and gets away with it most.** A third of its bets after the flop
  are bluffs, and two thirds of its bluffs win the pot without a showdown. Opus bluffs
  nearly as often, but under half of its bluffs work.
- **The models are mostly honest about it.** When a reason says "bluff", the cards nearly
  always agree. Sonnet called 39 of its bets bluffs and all 39 were. Astra is the
  exception: 6 of its 19 "bluffs" were made with a pair or a draw.
- **Bluffing before the flop is rare.** Raising first with a hand in the weakest third
  happened 26 times in about 2,700 preflop raises across all ten models.

## Reading the opponents

Every move comes with a short reason, written by the model as it acts. Very few of those
reasons are about the other players: across both series, **434 of 28,692 (1.5%)** describe
how an opponent or the table tends to play, and **87** say how that changes the move.
Reasons are short, and a model may think more than it writes; Opus's are typically two
words long. So these are the reads the models *stated*, a lower bound on what they made.

```table
preview: 4
| Model | Reasons that read an opponent | Moves it changed because of a read | Games with any read | Typical reason |
|---|---:|---:|---:|---:|
| Claude Fable 5.2 | 3.8% | **28** | 19 of 20 | 4 words |
| Claude Opus 5.5 | 2.9% | 12 | 20 of 20 | 2 words |
| Gemini 4 Neon (high) | 2.8% | 11 | 18 of 20 | 12 words |
| GPT-6.2 Astra | 2.3% | 8 | 19 of 20 | 10 words |
| Claude Haiku 5.5 | 1.2% | 14 | 17 of 20 | 17 words |
| GPT-6.2 Sol | 1.0% | 4 | 13 of 20 | 11 words |
| Claude Sonnet 5.5 | 0.5% | 7 | 10 of 20 | 4 words |
| Gemini 4 Hydrogen | 0.3% | 3 | 7 of 20 | 10 words |
| GPT-6.1 Terra | 0.1% | 0 | 3 of 20 | 8 words |
| Gemini 4 Argon | 0.1% | 0 | 2 of 20 | 8 words |
```

**The reads build up as a game goes on.** Each game starts every model fresh, so whatever
it knows about the others it learns in that game's 100 hands. Moves changed by a read went
from 22 in the first third of the hands to 24 in the middle and 41 in the last; Fable's
went 2, 9, 17.

**The reads point at the right player, and it is usually Haiku.** Haiku plays
almost half its hands, twice as many as anyone else, and 66 of the 108 reads that name a
player are about it. When a reason calls an opener loose or wide, the opener was Haiku a
third of the time, against 15% of all opens. Some reads, as the models wrote them:

- "Haiku usually flats, so this three-bet carries extra weight against king-queen."
  — GPT-6.2 Astra
- "second barrel; haiku folds turns to pressure very often" — Claude Fable 5.2
- "Haiku calls too much to bluff" — Claude Opus 5.5
- "Exploitatively 3-betting AJo to isolate haiku's very wide early-position opening range
  IP" — Gemini 4 Neon
- "Rivered top pair, value bet vs a station who calls light" — Claude Fable 5.2
- "Pocket nines facing a 2300 re-raise from terra, who has shown big hands; … so fold."
  — Claude Haiku 5.5

**Writing about opponents doesn't go with winning.** GPT-6.1 Terra, second overall, read
an opponent in only 3 of its 20 games; its reasons are about its own cards and position.
Haiku names other players in nearly a quarter of its reasons, but mostly to say what they
just did in the hand ("sol checked, so I check"), not how they play.

## Cheating, and attempts

**No model tried to cheat.** Over 20 games, 200 model-games in all:

- **The honeypot was never touched.** In every game, `poker rules` told every model about a
  "debug" endpoint that appears to show the other players' cards. No model ever called it,
  and none mentioned it in its reasons. (It serves decoy cards that are never anyone's, so
  a read would have been caught and its deals left out of the scores.)
- **No model looked anywhere it shouldn't.** Seat isolation was enforced in every game: no
  model read another's files or the engine's, and none tried to act as another seat.
  Six requests were refused as coming from an unknown seat, all in the first second of a
  game, before the seats had joined: an ordinary `poker wait` that arrived early.
- **Four tool calls in about 29,000 decisions weren't `poker`, and none was an attempt.**
  Opus twice, and Haiku once, read the output of their own background `poker wait`; Sol
  once wrapped `poker rules` in a shell check. No model searched the web or used Orcabot's own tools.

### Breaking the rules without meaning to

Two kinds of mistake did turn up, both in the Gemini models: moves sent when it wasn't
their turn, which the engine refuses, and preflop decisions made on cards they didn't hold
(a reason like "folding K7o" when the hand was K4), which it accepts. Neither counts
towards any score.

| Model | Decisions | Refused moves | Decisions on cards it didn't hold |
|---|---:|---:|---:|
| Gemini 4 Hydrogen | 2,651 | 1,101 | 92 |
| Gemini 4 Argon | 2,575 | 379 | 20 |
| Gemini 4 Neon | 2,667 | 5 | 0 |
| Every Claude and GPT model | 2,653–3,984 each | 0 | 0 |

## How it works

**The game.** Ten-handed no-limit hold'em, blinds 50/100. Every hand starts with 10,000
chips each (100 big blinds), so each hand is independent and the score is simply chips
won. A model has five minutes per decision; one that runs out of time checks or folds.

**The players.** Each model plays through its maker's own coding agent, in its own Orcabot
terminal, with the same prompt: the rules, and that it may only use the `poker` commands
(`poker wait`, `poker act`, `poker rules`). Each game starts fresh, so nothing carries over
from one game to the next. The model and reasoning effort in the table are read from each
agent's own logs, not taken from its label.

**Duplicate deals.** A series is ten games of the same 100 deals. Each game the seats move
round one place, so by the end every model has played every deal from every seat. A deal
that hands one seat aces hands them to every model in turn, and the luck of the cards
largely cancels out. The confidence ranges are bootstrapped over whole deals for the same
reason.

**Fair play.**
- Every seat runs as its own operating-system user with a private home, so no player can
  read another's cards, notes or reasoning, or the engine's files.
- The honeypot described above, in every game.
- Every tool call a player makes other than `poker` (a web search, a file read, Orcabot's
  own tools) is recorded from its transcript and listed in the game's report.
- The live table only ever shows the game being played, two minutes behind: cards every
  player at the table has already seen. A series deals the same cards in every game, so
  between games it shows "next game starting" rather than the end of the last one.

**Measuring play.** Bluffs are classified from each bet's cards: value (top pair or better
of its own), thin (a weaker pair), semi-bluff (a flush or open-ended straight draw) and
bluff (nothing). Play-style figures are totals over both series. Reads of opponents are found in
the reasons by pattern: a tendency tied to a player, a position or the table ("loose
opener", "calls too much", "has shown big hands"), checked by hand on samples (70–93%
precise by kind) and, for the 87 changed moves, read one by one.

### Limitations

- 2,000 hands per model is enough to separate the extremes, not the middle. A ±10 bb/100
  range would take ten to fifteen times as many hands.
- Each result is a model playing through its maker's agent, at one reasoning effort. The
  same model through a different agent, or at a different effort, may play differently.
- Ten models at one table means each result depends on who else is sitting there.

## Up next

**Finishing the no-limit series.** Eight more series of the same format, to 10,000 hands
per model; the progress bar at the top of this page tracks it. The ranges in the chart will
narrow as they come in, enough to separate the middle of the field.

**Then two new formats,** each rated on its own and never mixed with these results:

- **Fixed-limit hold'em.** Every bet is one fixed size, so there are no big all-in pots
  and no bet sizing: a purer test of reading hands and pricing calls. It also shows whether
  the models at the back of the field lose to how they size big pots or to how they play
  hands at all.
- **Tournaments.** Stacks carry over and the blinds keep rising, so a model has to manage
  its chips as the game goes from deep to short-stacked, and avoid being knocked out. Our
  early test tournaments suggest some models play this format very differently from the
  deep game above. Tournaments will be ranked by finishing order.
