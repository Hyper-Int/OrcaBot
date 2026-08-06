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
| Agent Skills | 54.45% | 54.46% | +0.01 | +1.64 → **−1.10** |

The single most important number on this page is the **baseline's +2.76**. The model got
better at these tasks in one month by more than any skill pack's advantage over it, in
either run. Skill effects here are small quantities riding on a much larger moving one —
which is the entire argument for re-running rather than citing a number from a blog post.

The Superpowers row compares v5 to v6, so its +2.89 mixes drift with a genuine pack
update. Every other row holds the pack constant.

## July 2026

This run exists to answer two questions the June run couldn't: how much of the June
result was **skill quality** versus **model drift** in the underlying model, and whether
the packs' own updates — notably Superpowers v6 — change the ranking.

Both answers turned out to be uncomfortable ones.

### SWE-bench Pro

| # | Arm | Resolve % | Partial % | Tokens/prob | $/prob | Δ vs base |
|---|-----|----------:|----------:|------------:|-------:|----------:|
| 1 | Oh My ClaudeCode | 57.20% | 77.4% | 2.19M | $0.53 | +1.65 |
| 2 | Superpowers-v6 | 57.06% | 77.1% | 1.83M | $0.46 | +1.51 |
| 3 | Karpathy Skills | 56.52% | 76.9% | 1.37M | $0.37 | +0.96 |
| 4 | baseline | 55.56% | 76.1% | 1.37M | $0.37 | — |
| 5 | Git Ship Done | 55.42% | 76.3% | 2.70M | $0.61 | −0.14 |
| 6 | Agent Skills | 54.46% | 75.7% | 2.07M | $0.52 | −1.10 |

**June's headline result did not survive.** In June every skill collection beat baseline;
in July two of them are *below* it. Git Ship Done went from +1.64 to −0.14 and Agent
Skills from +1.64 to −1.10 — neither pack got worse in absolute terms (both scored
roughly the same or better than in June), they simply failed to keep up with a baseline
that improved underneath them.

Karpathy Skills is now the efficiency standout: it matches the baseline's token spend and
cost per problem *exactly* (1.37M, $0.37) while resolving ~1 point more. Every other pack
buys its edge with 1.5–2× the tokens, and the two most expensive arms are the two that
now lose to baseline.

### SlopCodeBench

| # | Arm | Strict | Iso | Core | Partial | Erosion | Verbosity | $/ckpt |
|---|-----|-------:|----:|-----:|--------:|--------:|----------:|-------:|
| 1 | Superpowers-v6 | 14.5 ± 2.3 | 26.5 | 62.6 | 40.7 | 0.46 | 0.897 | 1.71 |
| 2 | baseline | 13.9 ± 0.5 | 27.3 | 67.1 | 46.3 | 0.59 | 0.827 | 1.26 |
| 3 | Git Ship Done | 13.1 ± 0.5 | 25.9 | 67.5 | 41.7 | 0.53 | 0.895 | 2.02 |
| 4 | Karpathy Skills | 12.9 ± 1.7 | 25.2 | 67.9 | 43.5 | 0.58 | — | — |
| 5 | Oh My ClaudeCode | 12.1 ± 1.0 | 25.9 | 65.8 | 44.4 | 0.54 | — | — |
| 6 | Agent Skills | 11.7 ± 1.5 | 24.8 | 65.1 | 38.9 | 0.47 | — | — |

Superpowers v6 is the **first skill pack in either run to beat baseline on Strict**
(14.5 vs 13.9), reversing June's clean sweep in the other direction. Treat it gently: its
±2.3 spread is wider than its 0.6-point margin, so this is suggestive, not established.

The baseline moved here too — Strict 12.2 → 13.9 — so the same drift story applies. Note
also that baseline still leads on Iso, Core and Partial, meaning v6's Strict win comes
with worse regression behaviour on prior checkpoints, not better code overall.

### What changed since June

- **The model.** Baseline resolve rose 52.80% → 55.56% on SWE-bench Pro and 12.2 → 13.9
  Strict on SlopCodeBench, with no change on our side.
- **Superpowers v5 → v6**, the only pack version bump in this run.
- **A new Verbosity metric** on SlopCodeBench, which is why June has no column for it.

## June 2026

731 problems on SWE-bench Pro (single run) and 36 problems / 196 checkpoints on
SlopCodeBench (mean of 3 runs). Model: Codex 5.5.

### SWE-bench Pro

| # | Arm | Resolve % | Partial % | Tokens/prob | $/prob | Δ vs base |
|---|-----|----------:|----------:|------------:|-------:|----------:|
| 1 | Oh My ClaudeCode | 54.99% | 76.1% | 2.09M | $0.54 | +2.19 |
| 2 | Git Ship Done | 54.45% | 75.3% | 2.46M | $0.60 | +1.64 |
| 3 | Agent Skills | 54.45% | 75.8% | 2.06M | $0.51 | +1.64 |
| 4 | Superpowers-v5 | 54.17% | 75.8% | 1.72M | $0.48 | +1.37 |
| 5 | Karpathy Skills | 53.08% | 74.7% | 1.23M | $0.37 | +0.27 |
| 6 | baseline Codex 5.5 | 52.80% | 72.9% | 1.29M | $0.38 | — |

SWE-bench Pro contains long-horizon issues drawn from 11 actively maintained open-source repositories; a task may require substantial coordinated changes across several files, but the agent generally gets one issue and one final evaluation.

*Note: While these benchmarks were running, Jesse Vincent released Superpowers v6 — it is covered in the July run above.*

![SWE-bench Pro accuracy versus cost: all five skill arms sit above the baseline resolve rate, but spending more per problem doesn't buy more accuracy — Karpathy Skills is the cheapest yet beats the baseline, and Git Ship Done is the most expensive without being the most accurate.](/benchmarks/swebench-cost-accuracy.svg)

### SlopCodeBench

| # | Arm | Strict | Iso | Core | Partial | Erosion | Verbosity | $/ckpt |
|---|-----|-------:|----:|-----:|--------:|--------:|----------:|-------:|
| 1 | baseline Codex 5.5 | 12.2 ± 0.4 | 25.7 | 68.4 | 41.7 | 0.58 | — | 1.32 |
| 2 | Git Ship Done | 11.9 ± 0.2 | 26.0 | 69.0 | 39.8 | 0.54 | — | 2.04 |
| 3 | Agent Skills | 11.7 ± 1.5 | 24.8 | 65.1 | 38.9 | 0.47 | — | 2.00 |
| 4 | Oh My ClaudeCode | 11.6 ± 2.3 | 25.9 | 63.6 | 42.6 | 0.52 | — | 1.87 |
| 5 | Superpowers-v5 | 11.4 ± 2.3 | 27.4 | 65.0 | 36.1 | 0.46 | — | 1.67 |
| 6 | Karpathy Skills | 11.1 ± 0.9 | 24.8 | 66.2 | 41.7 | 0.58 | — | 1.32 |

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

Pinned commits, June 2026 run:

| Skill | Repo | Commit |
|---|---|---|
| Git Ship Done | open-gsd/get-shit-done-redux | de73ad9 |
| Oh My ClaudeCode | Yeachan-Heo/oh-my-claudecode | a172043 |
| Superpowers v5 | obra/superpowers (v5.1.0) | f2cbfbe |
| Karpathy Skills | multica-ai/andrej-karpathy-skills | 2c60614 |
| Agent Skills | addyosmani/agent-skills | 70b7506 |
| Baseline | — (no skill) | — |

### SWE-bench Pro Configuration
- **Set:** the 731-instance public split, 11 repositories.
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
