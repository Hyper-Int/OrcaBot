---
title: Which Open-Weight TTS Engine Should You Actually Run?
date: 2026-08-14
description: Every open-weight TTS engine that runs faster than real time (or thereabouts), tested for WER using Whisper.
author: Rob Macrae
---

Here are all the available TTS open weight models that can likely run in real-time - or close to real-time, on consumer hardware.

We tested them against the same corpus, using Whisper medium to transcribe back to text.

Every row can be played, so you can hear what a word error rate actually sounds like.

## Results

Sorted by compute per phrase, fastest first. Click any column to re-sort.

```chart
tts-results
```

```chart
tts-preference
```

## How to read each column

The measurements are not interchangeable, and two of them actively mislead if taken at
face value.

- **RTF** is compute seconds per second of audio, the conventional measure. It **flatters
  any engine that emits excess silence**, because padding inflates the denominator. Prefer
  **Avg synth**, which is compute per phrase: every engine speaks the same corpus, so it
  compares directly and cannot be gamed by padding.
- **WER** is the round-trip word error rate, scored by Whisper `base.en`. The stronger
  `medium.en` was run too, but it did not finish for fifteen of the thirty-one
  configurations, so `base.en` is the one recogniser that covers the whole table. Being the
  weaker model it hallucinates words onto trailing silence, which understates good engines
  more than bad ones — so the true spread between engines is **wider** than this column
  shows, not narrower.
- **PESQ** is a no-reference perceptual quality estimate from torchaudio's SQUIM, scored on
  the sample in the first column. It is a second axis word error cannot see, because word
  error saturates once speech is merely intelligible. It measures signal quality, not
  naturalness: 2E and Qwen3-TTS sit within 0.01 of each other while sounding clearly
  different.
- **Class** describes the architecture. `det-ff` is a single forward pass with a
  deterministic duration predictor, so timing is identical every run and it cannot
  hallucinate. `stoch-ff` is the same shape with sampling inside, so output length varies.
  `ar-lm` samples audio tokens one at a time: length is emergent, cloning and emotion
  become possible, and real-time factor is floored by sequential decoding regardless of
  quantization.
- **Peak RSS** is dominated by the runtime rather than the model. Engines served by the C++
  binary carry no interpreter; those running in Python carry torch, transformers and their
  dependency trees.

## Methodology

**Machine.** Apple M2, macOS. One machine, one English corpus, one recogniser family.

**Nothing is filtered out.** Every configuration compared is listed, including the eleven
that cannot keep up with their own speech, because "how far off is it" is a real question
and a table that quietly omits the answer cannot be checked. The **Real time only** control
above the table hides anything above 2.1x for readers who only care about what can be
spoken live.

The cutoff sits just above 2.0 so Chatterbox Q4 survives it at 2.03x. Worth knowing when
reading that row: RTF counts silence, and against speech alone the same configuration is
2.59x, so it is the one that is only nominally real time.

**Corpus.** 84 phrases, spoken identically by every configuration, spanning core, edge and
long-form categories.

**Scoring.** Round-trip word error rate, capped at 1.0 per phrase so a single runaway
cannot swamp the mean. Leading silence is worth knowing about here: Whisper transcribes it
as a word ("You", "Thank you.") rather than returning nothing, so an engine that pads the
start of a clip manufactures insertion errors and scores worse than it sounds. PESQ is scored on **trimmed** audio: scoring untrimmed rewards
models that pad with silence, by up to 0.78, because silence pulls the estimate toward the
ceiling and only mediocre audio has room to rise.

**Passes.** Autoregressive engines are averaged over two passes, feed-forward over one.
Differences under roughly two points are not resolvable at this sample size.

**One device per model.** The three NeuTTS-2E rows are one backbone at three precisions,
all measured on the GPU path. The same weights were also run on CPU; those rows are not
shown, so that one model takes one row, and their measurements remain in the raw export.
On speed the device is worth about a third once the model is quantized, and nothing at all
at fp32, against roughly five times for the quantizing itself.

### What is excluded, and why

**macOS system TTS is not reproducible.** macOS resolves a voice to whichever quality tier
a given machine has downloaded, and Compact, Enhanced and Premium are different models
rather than bitrates of one. The row described one laptop, not a system anyone else could
reproduce.

**NeuTTS nano and Air are superseded**, replaced by 2E in July 2026. Ranking a vendor's
older models against everyone else's current ones misrepresents the vendor. Their
measurements and audio are retained in the raw export.

### Limitations

Word error rate measures intelligibility and nothing else. It is blind to naturalness,
expressiveness and speaker similarity, which is precisely what the LM-backed engines exist
to provide, so this benchmark understates them by construction. Treat the table as a
shortlist for "will this be understood, and what will it cost me", and the play buttons as
the part that answers "does it sound any good".

One machine also means the device-level findings generalise no further than Apple silicon.
