# FrontierCode (Diamond) — not runnable as an Orcabot template

**Verdict: no runner template is possible.** FrontierCode is real and
well-identified, but it is **closed / submission-only**. There is nothing to
`pip install`, no dataset to download, and no public harness to drive — so an
Orcabot "runner" would be a fiction. This note exists so the gap is documented
rather than papered over with a fake template.

## What it is

- **FrontierCode** — a coding benchmark from **Cognition AI** (the Devin team),
  announced June 2026: <https://cognition.ai/blog/frontier-code>
- Premise: goes *beyond correctness*. Instead of "do the tests pass" (SWE-bench
  style) it asks **"would an open-source maintainer actually merge this PR?"** —
  judging regression safety, test quality, scope discipline, and repo
  conventions. Built with 20+ maintainers across 36 OSS repos.
- **Diamond** is the hardest nested subset (your GPQA-Diamond analogy is right):
  Diamond = 50 hardest tasks ⊂ Main = 100 ⊂ Extended = 150. Scores are brutal
  (Claude Opus 4.8 ≈ 13.4% on Diamond).

## Why it can't be run locally

- **Tasks are deliberately held out** — Cognition states they don't plan to
  release tasks publicly, to avoid contamination.
- **No public repo, no HuggingFace dataset, no harness, no download.**
- **Access is submission-only:** model creators request that Cognition runs the
  eval. Grading (unit tests + reverse-classical tests + adaptive LLM grading +
  rubric review + scope checks) happens entirely on Cognition's side.
- Scores are reported as **model + agent-harness** combinations (Claude Code,
  Codex, Gemini CLI, mini-swe-agent, Devin) — so it's agentic, but you still
  can't reproduce it without the held-out tasks and private graders.

## The only partial path (and why it's not a real score)

You *could* point an Orcabot agent harness (Claude Code, mini-swe-agent, …) at
public OSS repos and grade "mergeability" with your own rubric — but that
produces a *different* benchmark, not a FrontierCode score, since neither the
tasks nor the graders match. Not worth a template.

## If/when this changes

If Cognition later publishes tasks or a submission API, the natural Orcabot fit
would be an **inference-only** template (run the agent harness against the
provided repos, emit submissions in their format) — mirroring the SWE-bench
inference phase. Until then: **not runnable.**

_Sources: [Cognition blog](https://cognition.ai/blog/frontier-code) ·
[HN discussion](https://news.ycombinator.com/item?id=48451723). Not to be
confused with Epoch AI's **FrontierMath** (a math benchmark with a similar
hardest-tier structure)._
