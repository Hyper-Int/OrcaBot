# SWE-bench Pro runner for Orcabot

Run [Scale AI's SWE-bench Pro](https://labs.scale.com/leaderboard/swe_bench_pro_public)
**public** set (731 tasks) from Orcabot. Harder, contamination-resistant
successor to SWE-bench — top models score ~23% vs ~70% on SWE-bench Verified.

## Runnable? Yes — the public set self-scores

The eval harness and golden tests are **open source**, so you score the public
731 locally without submitting to Scale:

- Harness: <https://github.com/scaleapi/SWE-bench_Pro-os> (MIT)
- Dataset: `ScaleAI/SWE-bench_Pro` on HuggingFace, `test` split, 731 rows
- Prebuilt per-task images: `jefzda/sweap-images:<dockerhub_tag>`

(The private/held-out splits — 276 + 858 tasks — are Scale-internal only.)

## Task + format

Same shape as SWE-bench: repo + issue → patch → hidden `fail_to_pass` /
`pass_to_pass` tests. Each dataset row carries a `dockerhub_tag` naming its
image.

## Two phases

**1. Inference (host, model keys, no Docker).** Drive an agent (the bundled
SWE-agent submodule, or Claude Code/Codex) over each instance's
`problem_statement` to produce per-instance `.pred` files, then gather:
```
python helper_code/gather_patches.py \
    --directory swe_bench_pro_results/sample1 \
    --prefix sample1 \
    --output sample1_patches.json
```
Predictions format (array): `[{"instance_id":"…","patch":"diff --git …","prefix":"sample1"}]`

**2. Evaluation (Docker-per-task, no model keys).**
```
python swe_bench_pro_eval.py \
    --raw_sample_path=swe_bench_pro_full.csv \
    --patch_path=sample1_patches.json \
    --output_dir=<out> \
    --scripts_dir=run_scripts \
    --num_workers=<N> \
    --dockerhub_username=jefzda
```

## Backends for eval

- **`--use_local_docker`** (beta): run `jefzda/sweap-images:*` on a local Docker
  daemon — needs a **Docker-capable benchmark sandbox** (x86 DinD microVM).
- **Modal** (default in the harness): `modal setup` → `~/.modal.toml`; container
  execution runs in Modal's cloud, no local Docker. The harness defaults to
  `--num_workers=100`, i.e. it's built for cloud parallelism.

## Resource reality

Dataset is tiny (~8 MB). The cost is **one prebuilt image per instance** (731
multi-GB images across 41 repos) — tens-to-hundreds of GB if pulled locally.
Strongly prefer **Modal** unless you've provisioned a fat DinD sandbox, and
start with a small instance subset.

## Setup

```
git clone --recurse-submodules https://github.com/scaleapi/SWE-bench_Pro-os
pip install -r requirements.txt
# Docker (for --use_local_docker) OR `modal setup` for the Modal backend
```

## Files

`orchestrator-runbook.md`, `config-wizard.md`, `template.json`.

## Status — prototype, partially validated

**Verified:** commands/flags/formats are from the harness README + dataset card;
`template.json` parses with valid embedded content.

**Not validated from here** (needs Docker/Modal + keys): a real inference run, a
real `swe_bench_pro_eval.py`, image pulls. Note the inference step delegates
exact LLM env-var names to the SWE-agent submodule — confirm them against the
submodule config before finalizing. `--use_local_docker` is upstream-beta.
