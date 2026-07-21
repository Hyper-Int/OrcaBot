---
title: Do Skills Improve Coding Agent Accuracy?
date: 2026-07-21
description: We ran five public skill collections with Codex 5.5 against SWE benchmarks
author: Rob Macrae
---

Agent skills were originally designed to allow developers to teach a general AI agent on a specific process or domain expert’s workflow without bloating the agent's prompt or context window. Before agent skills, managing AI behavior was a messy process of swapping and chaining system prompts.

Almost immediately, developers such as Jesse Vincent[^1] were developing skills to improve Claude Code and other harnesses' ability to handle general engineering tasks. Jesse's Superpowers[^2] claimed to impose a professional methodology automatically; Get Shit Done (now Git Ship Done or simply GSD)[^3] would turn an idea into durable specifications and phases; Oh My ClaudeCode[^4] then promised to provide “zero learning curve” orchestration. Andrej Karpathy's tweets[^5] about his coding workflow got quickly turned into another skill[^6] and Addy Osmani released "Agent Skills"[^7], production-grade engineering skills for AI coding agents.

None of them originally shipped with evidence, other than some demonstrations, that they actually improved end-to-end software-engineering performance. Superpowers came closest, but it tested workflow compliance, not whether the same model solved more coding tasks. And with the AI models and coding harnesses constantly improving, it was an open question whether any gains would survive the next model release.

So I decided to put these skills to the test using similar benchmarks to the ones that the frontier labs use when they release new models.

Note: While these benchmarks were running, Jesse Vincent released Superpowers v6. I will post an updated version of this benchmark soon."

## Results

SWE-bench Pro[^8] 731 problems, all complete, single run, model: Codex5.5

| # | Arm | Resolve % | Partial % | Tokens/prob | $/prob | Δ vs base |
|---|-----|----------:|----------:|------------:|-------:|----------:|
| 1 | Oh My ClaudeCode | 54.99% | 76.1% | 2.09M | $0.54 | +2.19 |
| 2 | Git Ship Done | 54.45% | 75.3% | 2.46M | $0.60 | +1.64 |
| 3 | Agent Skills | 54.45% | 75.8% | 2.06M | $0.51 | +1.64 |
| 4 | Superpowers-v5 | 54.17% | 75.8% | 1.72M | $0.48 | +1.37 |
| 5 | Karpathy Skills | 53.08% | 74.7% | 1.23M | $0.37 | +0.27 |
| 6 | baseline Codex 5.5 | 52.80% | 72.9% | 1.29M | $0.38 | — |

SWE-bench Pro contains long-horizon issues drawn from 11 actively maintained open-source repositories; a task may require substantial coordinated changes across several files, but the agent generally gets one issue and one final evaluation

![SWE-bench Pro accuracy versus cost: all five skill arms sit above the baseline resolve rate, but spending more per problem doesn't buy more accuracy — karpathy is the cheapest yet beats the baseline, and gsd is the most expensive without being the most accurate.](/labs/swebench-cost-accuracy.svg)

SlopCodeBench[^9] 36 problems / 196 checkpoints, mean of 3 runs, model: Codex5.5

| # | Arm | Strict | Iso | Core | Partial | $/ckpt | Erosion |
|---|-----|-------:|----:|-----:|--------:|-------:|--------:|
| 1 | baseline Codex 5.5 | 12.2 ± 0.4 | 25.7 | 68.4 | 41.7 | 1.32 | 0.58 |
| 2 | Git Ship Done | 11.9 ± 0.2 | 26.0 | 69.0 | 39.8 | 2.04 | 0.54 |
| 3 | Agent Skills | 11.7 ± 1.5 | 24.8 | 65.1 | 38.9 | 2.00 | 0.47 |
| 4 | Oh My ClaudeCode | 11.6 ± 2.3 | 25.9 | 63.6 | 42.6 | 1.87 | 0.52 |
| 5 | Superpowers-v5 | 11.4 ± 2.3 | 27.4 | 65.0 | 36.1 | 1.67 | 0.46 |
| 6 | Karpathy Skills | 11.1 ± 0.9 | 24.8 | 66.2 | 41.7 | 1.32 | 0.58 |

SlopCodeBench contains 36 synthetic, language-agnostic problems divided into 196 sequential checkpoints. The agent receives only an observable CLI or API contract, chooses its own architecture, and must keep modifying the code it previously wrote.

For SWE-bench Pro, all the skills provide an improvement over baseline. This effect disappears with SlopCodeBench with all strict scores worse than baseline (although GSD gets higher Iso and Core pass rates).

## Potential Explanations

Many of these frameworks contain procedures intended for navigating and modifying established codebases. Those procedures have limited value during the initial greenfield checkpoint of SlopCodeBench and may impose a context or orchestration cost. SWE-bench Pro's hard part is finding the right 20 lines in a 500k-line unfamiliar repo and making a surgical edit whereas on SCBench the agent wrote the code itself so it will usually already be in context. Additionally all these instructions, routing decisions and procedural constraints add to the context. On a difficult repository task, that additional structure can focus the model. On a small task, it can compete with the actual specification for attention.

In SWE-bench Pro, the repository normally provides existing tests, related test patterns and observable regressions. A TDD or systematic-debugging workflow can use that evidence to localize the issue and protect surrounding functionality.
SlopCodeBench keeps its evaluator tests hidden. Agents can write tests only from the current external contract and examples. Skills push "reproduce the failure, write a failing test, then fix." but on SCBench there's no bug to reproduce.

## So, do skills improve accuracy?

On the evidence: **sometimes, and it depends on the task.**

- On SWE-bench Pro, yes — uniformly. Every skill collection helped.
- On SlopCodeBench, no — every skill collection actively hurt.

A caveat worth stating plainly: SlopCodeBench ran at n=3 seeds and the spread on several arms (±2.3) is wider than the gaps between them.

## Reproduce it

Both harnesses are forked with a branch set up to run the skill arms:

- **SlopCodeBench** — [robdmac/slop-code-bench @ `reproduce-public-skills`](https://github.com/robdmac/slop-code-bench/tree/reproduce-public-skills)
- **SWE-bench Pro** — [robdmac/SWE-bench_Pro-os @ `reproduce-public-skills`](https://github.com/robdmac/SWE-bench_Pro-os/tree/reproduce-public-skills)

## Methodology

### Model and harness
All runs used OpenAI **Codex 5.5** (`gpt-5.5`, reasoning effort `high`) via the Codex
CLI (v0.136.0) on a ChatGPT subscription. The agent runs **inside each task's Docker
container**: the harness starts the container, `docker exec`s Codex into it with the
skill mounted, and extracts the resulting git diff. No agent logic runs on the host.

### Skills: real, not distilled
Each skill's **actual upstream repository** was mounted read-only into the container at
a fixed commit (below); the trigger prompt instructs the agent to read the repo's own
entry file (e.g. OMC's `AGENTS.md`) and follow it. We did **not** paraphrase any skill
into the prompt — trajectories confirm the agent read the real skill files (e.g. 730/731
OMC runs opened `oh-my-claudecode/AGENTS.md` and its rule files). Because Codex is a
single agent, multi-agent frameworks (OMC, Superpowers) were applied as a **single-agent
sequential pass** rather than orchestrated sub-agents; this is a faithful adaptation but
may *understate* skills designed around native multi-agent tooling.

| Skill | Repo | Commit |
|---|---|---|
| Get Ship Done | open-gsd/get-shit-done-redux | de73ad9 |
| Oh My ClaudeCode | Yeachan-Heo/oh-my-claudecode | a172043 |
| Superpowers v5 | obra/superpowers (v5.1.0) | f2cbfbe |
| Karpathy Skills | multica-ai/andrej-karpathy-skills | 2c60614 |
| Agent Skills | addyosmani/agent-skills | 70b7506 |
| Baseline | — (no skill) | — |

### SWE-bench Pro
- **Set:** the 731-instance public split, 11 repositories.
- **Generation:** one attempt per instance (**n = 1 seed**), 30-minute cap.
- **Evaluation:** the official Docker-based evaluator, run locally. We patched one bug:
  the Docker SDK's 60-second client read-timeout silently drops output for test suites
  that run longer than 60s (common in Go/JS repos), mis-scoring them as failures; we set
  the client timeout to 3600s. Tests were scored serially.
- **Resolve %** = fraction of instances where **all** required tests pass
  (`FAIL_TO_PASS ∪ PASS_TO_PASS`). **Partial %** = mean fraction of required tests passing
  per instance (partial credit).

### SlopCodeBench
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

### Cost
`$/problem` and `$/checkpoint` are **imputed from token counts at public API prices**
($1.25 / $0.125 / $10 per 1M input / cached-input / output tokens). Actual incremental
cost on the ChatGPT subscription was $0; treat cost as a relative token-efficiency proxy.

### Limitations and confounds
- **Asymmetric seeding:** SWE-bench Pro is single-seed (no variance estimate); the
  smaller deltas (≤~1pp) should be read as suggestive, not significant. SlopCodeBench is
  n=3 and several arms overlap within their ±.
- **Cohort timing:** skill and baseline cohorts were generated in different `gpt-5.5`
  server windows; a mid-study server-side model update shifted style metrics (notably
  verbosity), so we report only solve metrics and erosion, and caution that even erosion
  may carry a cohort effect.
- **Known evaluator issue:** SWE-bench Pro's jest parser drops per-test results from
  suites Jest marks as failed (upstream issue #19), affecting some `element-web`
  instances uniformly across arms; a spot check found these are mostly genuine failures.
- **Single-agent adaptation** of multi-agent skills, as noted above.
- **Benchmark affiliation:** [state your relationship to SlopCodeBench here].

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
