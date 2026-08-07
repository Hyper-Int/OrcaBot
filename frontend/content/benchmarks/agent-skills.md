---
title: Do Skills Improve Coding Agent Accuracy?
date: 2026-07-31
description: Five public skill collections benchmarked against SWE-bench Pro and SlopCodeBench, re-run monthly to track model drift and plugin updates
author: Rob Macrae
ogImage: /benchmarks/og-do-skills.png
---

Agent skills were originally designed to allow developers to teach a general AI agent a specific process or domain expert’s workflow without bloating the agent's prompt or context window. Before agent skills, managing AI behavior was a messy process of swapping and chaining system prompts.

Almost immediately, developers such as Jesse Vincent [^1] were developing skills to improve Claude Code and other harnesses' ability to handle general engineering tasks. Jesse's Superpowers [^2] claimed to impose a professional methodology automatically; Get Shit Done (now Git Ship Done or simply GSD) [^3] would turn an idea into durable specifications and phases; Oh My ClaudeCode [^4] then promised to provide “zero learning curve” orchestration. Andrej Karpathy's tweets [^5] about his coding workflow got quickly turned into another skill [^6] and Addy Osmani released "Agent Skills" [^7], production-grade engineering skills for AI coding agents.

None of them originally shipped with evidence, other than some demonstrations, that they actually improved end-to-end software-engineering performance. Superpowers came closest, but it tested workflow compliance, not whether the same model solved more coding tasks. And with the AI models and coding harnesses constantly improving, it was an open question whether any gains would survive the next model release.

So I decided to put these skills to the test using similar benchmarks to the ones that the frontier labs use when they release new models: **SWE-bench Pro** [^8] and **SlopCodeBench** [^9].

That last point — whether a result survives the next model release — is why this page is not a one-off. **The same arms are re-run every month.** Skill packs ship updates, models drift underneath them, and a number published once decays quietly. Each run below is a dated snapshot with its own config; the methodology is shared, so the months are directly comparable.

## Run history

Resolve % on SWE-bench Pro, by run. The right-hand column is each arm's month-over-month
change; the bracketed figure is its edge over **that month's own baseline**, which is the
only honest way to compare across runs.

| Arm | June 2026 | July 2026 | Δ month | (edge vs base) |
|-----|----------:|----------:|--------:|---------------:|
| Oh My ClaudeCode | 54.99% | 57.20% | +2.21 | +2.19 → +1.65 |
| Superpowers | 54.17% *(v5)* | 57.06% *(v6)* | +2.89 | +1.37 → +1.51 |
| Karpathy Skills | 53.08% | 56.52% | +3.44 | +0.27 → +0.96 |
| **baseline** | **52.80%** | **55.56%** | **+2.76** | — |
| Git Ship Done | 54.45% | 55.42% | +0.97 | +1.64 → **−0.14** |
| Agent Skills | — | 54.46% | — | — → **−1.10** |

The single most important number on this page is the **baseline's +2.76** — achieved with
the same harness version and the same model string. The model got better at these tasks in
one month by more than any skill pack's advantage over it in either run. Skill effects here
are small quantities riding on a much larger moving one, which is the entire argument for
re-running rather than citing a number from a blog post.

Only two rows are clean drift measurements. **Baseline** runs no skill at all, and
**Karpathy Skills** is the one pack that shipped nothing between the runs (same commit,
`2c60614`). Git Ship Done, Oh My ClaudeCode and Superpowers all moved commits, so their
month-over-month figures mix model drift with a pack update and cannot be read as either
one alone.

### What actually changed in the model

SlopCodeBench separates two things SWE-bench Pro blends together: how many checkpoints an
arm solves outright (**Strict**), and how much previously-working code it breaks as the
codebase accretes (**Erosion**, lower is better). Comparing both across the two runs
characterises the drift far more precisely than a single resolve rate.

| Arm | Pack | Strict Jun | Strict Jul | Δ | Erosion Jun | Erosion Jul | Δ | Verbosity Jul |
|-----|------|-----------:|-----------:|--:|------------:|------------:|--:|--------------:|
| **baseline** | *none* | 12.2 | 13.9 | **+1.7** | 0.58 | 0.59 | +0.01 | 0.827 |
| **Karpathy Skills** | *unchanged* | 11.1 | 12.9 | **+1.8** | 0.58 | 0.58 | 0.00 | 0.915 |
| Superpowers | v5→v6 | 11.4 | 14.5 | +3.1 | 0.46 | 0.46 | 0.00 | 0.897 |
| Git Ship Done | updated | 11.9 | 13.1 | +1.2 | 0.54 | 0.53 | −0.01 | 0.895 |
| Oh My ClaudeCode | updated | 11.6 | 12.1 | +0.5 | 0.52 | 0.54 | +0.02 | 0.908 |

**Capability moved; discipline did not.** Every arm's Strict rate rose (+0.5 to +3.1)
while every arm's Erosion moved by at most ±0.02. The model got materially better at
solving new checkpoints and no better at all at not breaking what it had already written.

That is pointed for skill packs specifically, because regression discipline is exactly
what most of them claim to add — and it is the axis the model did not move on. Erosion
also stays stubbornly arm-specific across both months (Superpowers ~0.46, Karpathy ~0.58),
suggesting it is a property of the workflow rather than the model.

**Karpathy is an accidental control arm**, and a useful one. It ran on identical code in
both months — not because we pinned an old commit, but because
[the repo has not changed since April](#skills-real-not-distilled). Its movement should
therefore equal the baseline's if nothing but the model changed, and it does, almost
exactly: **+1.8 against baseline's +1.7** here, and +3.44 against +2.76 on SWE-bench Pro.
Two independent arms agreeing on the size of the drift is the strongest evidence on this
page that the June→July shift is real and not an artefact of one measurement.

Take that agreement as the yardstick and the pack updates can be scored against it:

- **Superpowers v6 genuinely improved.** +3.1 Strict against a ~+1.75 drift baseline is
  roughly double what the model alone delivered.
- **Git Ship Done (+1.2) and Oh My ClaudeCode (+0.5) came in *under* drift**, on both
  benchmarks — GSD managed only +0.97 on SWE-bench Pro where standing still was worth
  ~+2.8. Their July updates look net negative: they gave back some of what the model
  handed them.

Stated carefully, because the noise is real: SWE-bench Pro is single-seed with sub-1pp
gaps, and SlopCodeBench spreads run ±0.5–2.3. These are directional readings, not
settled ones — which is the argument for the next run rather than a conclusion from this
one.

Verbosity is July-only, so it cannot be tracked across months yet; it is recorded here as
the baseline for future runs. Every pack is wordier than baseline (0.83 vs 0.90–0.92).

## July 2026

This run exists to answer two questions the June run couldn't: how much of the June
result was **skill quality** versus **model drift** in the underlying model, and whether
the packs' own updates — notably Superpowers v6 — change the ranking.

Both answers turned out to be uncomfortable ones.

### SWE-bench Pro

729 instances common to every arm, single seed per arm.

| # | Arm | Resolve % | Partial % | Tokens/prob | $/prob | Δ vs base |
|---|-----|----------:|----------:|------------:|-------:|----------:|
| 1 | Oh My ClaudeCode | 57.20% | 77.4% | 2.19M | $0.53 | +1.65 |
| 2 | Superpowers-v6 | 57.06% | 77.1% | 1.83M | $0.46 | +1.51 |
| 3 | Karpathy Skills | 56.52% | 76.9% | 1.37M | $0.37 | +0.96 |
| 4 | baseline | 55.56% | 76.1% | 1.37M | $0.37 | — |
| 5 | Git Ship Done | 55.42% | 76.3% | 2.70M | $0.61 | −0.14 |
| 6 | Agent Skills | 54.46% | 75.7% | 2.07M | $0.52 | −1.10 |

Every gap here is under two points on a single seed, so treat the ordering as
indicative rather than settled — the sign of each delta is the interesting part.

**June's headline result did not survive.** In June every skill collection beat baseline;
in July two are *below* it. Git Ship Done went from +1.64 to −0.14 without getting worse
in absolute terms — it scored *higher* than in June (54.45% → 55.42%) and still lost its
edge, because the baseline improved faster underneath it. Its pack also shipped an update
between the runs, so the loss is either drift outrunning it or a regression in the update;
neither reading flatters the pack. Agent Skills, new to the cohort this month, lands
at −1.10.

Karpathy Skills is now the efficiency standout: it matches the baseline's token spend and
cost per problem *exactly* (1.37M, $0.37) while resolving ~1 point more. Every other pack
buys its edge with 1.5–2× the tokens, and the two most expensive arms are the two that
now lose to baseline.

### SlopCodeBench

All 36 problems, n ≤ 3 seeds per arm.

| # | Arm | Strict | Iso | Core | Partial | Erosion | Verbosity | $/ckpt |
|---|-----|-------:|----:|-----:|--------:|--------:|----------:|-------:|
| 1 | Superpowers-v6 | 14.5 ± 2.3 | 26.5 | 62.6 | 40.7 | 0.46 | 0.897 | 1.71 |
| 2 | baseline | 13.9 ± 0.5 | 27.3 | 67.1 | 46.3 | 0.59 | 0.827 | 1.26 |
| 3 | Git Ship Done | 13.1 ± 0.5 | 25.9 | 67.5 | 41.7 | 0.53 | 0.895 | 2.02 |
| 4 | Karpathy Skills | 12.9 ± 1.7 | 25.2 | 67.9 | 43.5 | 0.58 | 0.915 | 1.25 |
| 5 | Oh My ClaudeCode | 12.1 ± 1.0 | 25.9 | 65.8 | 44.4 | 0.54 | 0.908 | 1.87 |
| 6 | Agent Skills | 11.7 ± 1.5 | 24.8 | 65.1 | 38.9 | 0.47 | 0.900 | 2.00 |

Superpowers v6 is the **first skill pack in either run to beat baseline on Strict**
(14.5 vs 13.9), reversing June's clean sweep in the other direction. Treat it gently: its
±2.3 spread is wider than its 0.6-point margin, so this is suggestive, not established —
and the win is narrow in a second sense, since v6 simultaneously posts the *worst* Core
(62.6) and Partial (40.7) of any arm. It solves more checkpoints outright while breaking
more of what it had already built.

The baseline moved here too — Strict 12.2 → 13.9 — so the same drift story applies, and
baseline still leads on Iso, Core and Partial.

Every pack is also more verbose than baseline (0.83 vs 0.90–0.92), which is the cost
story restated: the packs spend more words to land in roughly the same place. Karpathy is
the exception that proves the rule — the only arm cheaper than baseline per checkpoint
($1.25 vs $1.26) while still finishing above the two most expensive packs.

### Verdict

Measured against a **contemporaneous** baseline, the public workflow skills mostly wash.
Which one "wins" depends on the benchmark and the metric more than on the skill.

- **Superpowers-v6** — the only pack positive on *both* (Pro +1.51, SlopCodeBench Strict
  leader). Caveat above: that Strict lead comes with the worst Core and Partial, on wide
  noise.
- **Oh My ClaudeCode** — Pro leader (+1.65) but 1.8 below baseline on SlopCodeBench
  Strict. Benchmark-dependent.
- **Karpathy Skills** — a cheap positive on Pro (+0.96 at baseline cost), negative on
  SlopCodeBench.
- **Git Ship Done** — neutral-to-negative on both, at the highest token spend on Pro.
- **Agent Skills** — negative on both.

The June answer to the title question was "sometimes, and it depends on the task." One
month later the same experiment says something sharper: **it depends on the task, the
metric, and the month.**

### What changed since June

- **The model, under a fixed version string.** Same harness (Codex CLI `v0.136.0`), same
  model name (`gpt-5.5`, high reasoning). The baseline arm runs no skill at all and still
  rose 52.80% → 55.56% on Pro and 12.2 → 13.9 Strict on SlopCodeBench. That is silent
  server-side drift, and it is the cleanest measurement on this page.
- **Three of the five packs also shipped updates** — Git Ship Done (`de73ad92` →
  `4fc89497`), Oh My ClaudeCode (`a1720433` → `41a4c0f7`) and Superpowers (v5.1.0 → v6).
  Their month-over-month numbers therefore conflate drift with a pack change.
- **Karpathy Skills did not** (`2c60614` in both runs), which is what makes it a usable
  control against the baseline.
- **Agent Skills joined** the cohort this month, so it has no June comparison.
- **Set size:** 729 instances common to all arms, against June's 731.
- **New SlopCodeBench metrics** (Verbosity, cost/checkpoint detail), which is why the June
  table has no Verbosity column.

## June 2026

731 problems on SWE-bench Pro (single run) and 36 problems / 196 checkpoints on
SlopCodeBench (mean of 3 runs). Model: Codex 5.5.

### SWE-bench Pro

| # | Arm | Resolve % | Partial % | Tokens/prob | $/prob | Δ vs base |
|---|-----|----------:|----------:|------------:|-------:|----------:|
| 1 | Oh My ClaudeCode | 54.99% | 76.1% | 2.09M | $0.54 | +2.19 |
| 2 | Git Ship Done | 54.45% | 75.3% | 2.46M | $0.60 | +1.64 |
| 3 | Superpowers-v5 | 54.17% | 75.8% | 1.72M | $0.48 | +1.37 |
| 4 | Karpathy Skills | 53.08% | 74.7% | 1.23M | $0.37 | +0.27 |
| 5 | baseline Codex 5.5 | 52.80% | 72.9% | 1.29M | $0.38 | — |

Agent Skills is absent here: it entered the study with the July cohort, so it has no
June measurement.

SWE-bench Pro contains long-horizon issues drawn from 11 actively maintained open-source repositories; a task may require substantial coordinated changes across several files, but the agent generally gets one issue and one final evaluation.

*Note: While these benchmarks were running, Jesse Vincent released Superpowers v6 — it is covered in the July run above.*

![SWE-bench Pro accuracy versus cost: all five skill arms sit above the baseline resolve rate, but spending more per problem doesn't buy more accuracy — Karpathy Skills is the cheapest yet beats the baseline, and Git Ship Done is the most expensive without being the most accurate.](/benchmarks/swebench-cost-accuracy.svg)

### SlopCodeBench

| # | Arm | Strict | Iso | Core | Partial | Erosion | Verbosity | $/ckpt |
|---|-----|-------:|----:|-----:|--------:|--------:|----------:|-------:|
| 1 | baseline Codex 5.5 | 12.2 ± 0.4 | 25.7 | 68.4 | 41.7 | 0.58 | — | 1.32 |
| 2 | Git Ship Done | 11.9 ± 0.2 | 26.0 | 69.0 | 39.8 | 0.54 | — | 2.04 |
| 3 | Oh My ClaudeCode | 11.6 ± 2.3 | 25.9 | 63.6 | 42.6 | 0.52 | — | 1.87 |
| 4 | Superpowers-v5 | 11.4 ± 2.3 | 27.4 | 65.0 | 36.1 | 0.46 | — | 1.67 |
| 5 | Karpathy Skills | 11.1 ± 0.9 | 24.8 | 66.2 | 41.7 | 0.58 | — | 1.32 |

Verbosity was not recorded in the June run.

SlopCodeBench contains 36 synthetic, language-agnostic problems divided into 196 sequential checkpoints. The agent receives only an observable CLI or API contract, chooses its own architecture, and must keep modifying the code it previously wrote.

![SlopCodeBench core solve rate by checkpoint: every arm erodes from ~75–82% at checkpoint 1 to ~44–50% by checkpoint 8, and the five skill arms track the baseline the whole way down — none pulls ahead. The problem count shrinks from 36 to 6, so the later checkpoints are noisier.](/benchmarks/slopcodebench-checkpoint-dropoff.svg)

### Verdict

**For SWE-bench Pro, all the skills provide an improvement over baseline.** This effect disappears with SlopCodeBench with all strict scores worse than baseline (although GSD gets higher Iso and Core pass rates).

With the exception of Karpathy Skills, each collection of skills **costs more to run** than baseline.

On the evidence: **sometimes, and it depends on the task.**

- On SWE-bench Pro, yes — uniformly. Every skill collection helped.
- On SlopCodeBench, no — every skill collection actively hurt.

A caveat worth stating plainly: SlopCodeBench ran at n=3 seeds and the spread on several arms (±2.3) is wider than the gaps between them.

### Potential explanations

Many of these frameworks contain procedures intended for navigating and modifying established codebases. Those procedures have limited value during the initial greenfield checkpoint of SlopCodeBench and may impose a context or orchestration cost. SWE-bench Pro's hard part is finding the right 20 lines in a 500k-line unfamiliar repo and making a surgical edit whereas on SCBench the agent wrote the code itself so it will usually already be in context. Additionally all these instructions, routing decisions and procedural constraints add to the context. On a difficult repository task, that additional structure can focus the model. On a small task, it can compete with the actual specification for attention.

In SWE-bench Pro, the repository normally provides existing tests, related test patterns and observable regressions. A TDD or systematic-debugging workflow can use that evidence to localize the issue and protect surrounding functionality.
SlopCodeBench keeps its evaluator tests hidden. Agents can write tests only from the current external contract and examples. Skills push *"reproduce the failure, write a failing test, then fix."* but on SCBench there's no bug to reproduce.

## Methodology

The methodology below is shared by every run above. When it changes, the change is
noted in that month's section and the affected months are marked as not directly
comparable.

### Try it yourself in OrcaBot

There is a template for running SlopCodeBench within OrcaBot which acts as the benchmark orchestrator for you with a live browser showing the progress and results.

### Model and harness
All runs used OpenAI **Codex 5.5** (`gpt-5.5`, reasoning effort `high`) via the Codex
CLI (v0.136.0) on a ChatGPT subscription. The agent runs **inside each task's Docker
container**: the harness starts the container, `docker exec`s Codex into it with the
skill mounted, and extracts the resulting git diff. No agent logic runs on the host.

- **SlopCodeBench** — [robdmac/slop-code-bench @ `reproduce-public-skills`](https://github.com/robdmac/slop-code-bench/tree/reproduce-public-skills)
- **SWE-bench Pro** — [robdmac/SWE-bench_Pro-os @ `reproduce-public-skills`](https://github.com/robdmac/SWE-bench_Pro-os/tree/reproduce-public-skills)

### Skills: real, not distilled
Each skill's **actual upstream repository** was mounted read-only into the container at
a fixed commit (below); the trigger prompt instructs the agent to read the repo's own
entry file (e.g. OMC's `AGENTS.md`) and follow it. We did **not** paraphrase any skill
into the prompt — trajectories confirm the agent read the real skill files (e.g. 730/731
OMC runs opened `oh-my-claudecode/AGENTS.md` and its rule files). Because Codex is a
single agent, multi-agent frameworks (OMC, Superpowers) were applied as a **single-agent
sequential pass** rather than orchestrated sub-agents; this is a faithful adaptation but
may *understate* skills designed around native multi-agent tooling.

Pinned commits per run. Every pack except Karpathy shipped changes between the two runs,
which is exactly why the baseline and Karpathy arms matter as controls (see
[What actually changed in the model](#what-actually-changed-in-the-model)).

| Skill | Repo | June run | July run |
|---|---|---|---|
| Git Ship Done | get-shit-done-redux | `de73ad92` (05-25) | `4fc89497` (07-22) |
| Oh My ClaudeCode | oh-my-claudecode | `a1720433` (05-25) | `41a4c0f7` (07-23) |
| Superpowers | superpowers | `f2cbfbe` (v5.1.0, 05-04) | `d884ae0` (v6, 07-02) |
| Karpathy Skills | andrej-karpathy-skills | `2c60614` (04-20) | `2c60614` (04-20) — **same** |
| Agent Skills | agent-skills | — *(no June run)* | `70b7506` (07-06) |
| Baseline | — *(no skill, just-solve)* | — | — |

**On the Karpathy pin.** Both runs use the same commit not because we froze it, but
because the repository has not changed: `2c60614` (2026-04-20) is still the latest commit
upstream, with zero commits since. That is a property of the pack, not a choice we made,
and it is what makes the arm a fair control rather than an artificially stale one — the
pack was tested at its current state in both runs.

The contrast is stark. Checked on 2026-08-07, three of the other four packs have already
moved past the commit used in the July run: Git Ship Done to `a731a45` (that same day),
Agent Skills to `d2478bf`, Superpowers to `44c9b2d`. Only Oh My ClaudeCode still sits at
its July commit. Any conclusion below about a *pack* — as opposed to the model — has a
shelf life measured in weeks, which is the other half of the argument for re-running.

### SWE-bench Pro Configuration
- **Set:** the public split, 11 repositories — 731 instances in June, and the 729
  instances common to every arm in July.
- **Generation:** one attempt per instance (**n = 1 seed**), 30-minute cap.
- **Evaluation:** the official Docker-based evaluator, run locally. We patched one bug:
  the Docker SDK's 60-second client read-timeout silently drops output for test suites
  that run longer than 60s (common in Go/JS repos), mis-scoring them as failures; we set
  the client timeout to 3600s. Tests were scored serially.
- **Resolve %** = fraction of instances where **all** required tests pass
  (`FAIL_TO_PASS ∪ PASS_TO_PASS`). **Partial %** = mean fraction of required tests passing
  per instance (partial credit).

### SlopCodeBench Configuration
- **Set:** 36 problems / 196 checkpoints. Each problem is greenfield at checkpoint 1,
  then iteratively refined; regression tests from prior checkpoints accumulate.
- **Generation:** **n = 3 seeds** per problem; results are the mean over seeds, ± the
  run-to-run population standard deviation of the whole-benchmark rate.
- **Evaluation:** serial (`SCBENCH_PYTEST_WORKERS=1`) to avoid xdist-order flakiness on
  parallel-sensitive problems.
- **Strict** = checkpoint solved iff every required test passes; **Iso** = solved ignoring
  prior-checkpoint regressions; **Core** = core tests only; **Partial** = % of problems
  with ≥1 strict checkpoint; **Erosion** = degradation of earlier checkpoints as code
  accretes (lower is better).

## References

[^1]: https://blog.fsck.com/2025/10/09/superpowers/
[^2]: https://github.com/obra/superpowers
[^3]: https://github.com/open-gsd/gsd-core
[^4]: https://ohmyclaudecode.com
[^5]: https://x.com/karpathy/status/2015883857489522876
[^6]: https://github.com/multica-ai/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md
[^7]: https://github.com/addyosmani/agent-skills
[^8]: https://labs.scale.com/leaderboard/swe_bench_pro_public
[^9]: https://www.scbench.ai
