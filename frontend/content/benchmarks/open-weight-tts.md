---
title: Testing open-weight Text To Speech models
date: 2026-08-17
description: Every open-weight TTS engine that can run on a consumer laptop, tested for WER using Whisper.
author: Rob Macrae
toc: false
---

We tested all the open weight TTS models against the same corpus, using Whisper medium to transcribe back to text.

Every row can be played, so you can hear what a word error rate actually sounds like.

```chart
tts-vendors
```

## Results

Sorted by compute per phrase, fastest first. Click any column to re-sort.

```chart
tts-results
```

```chart
tts-error-cost
```

```chart
tts-preference
```

## How to read each column

The measurements are not interchangeable, and two of them actively mislead if taken at
face value.

- **RTF** is compute seconds per second of audio, the conventional measure. It **flatters
  any engine that emits excess silence**, because padding inflates the denominator. Prefer
  **x̄ synth**, which is compute per phrase: every engine speaks the same corpus, so it
  compares directly and cannot be gamed by padding.
- **WER** is the round-trip word error rate, scored by Whisper `base.en`. The stronger
  `medium.en` was run too, but it did not finish for nineteen of the thirty-four
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
  hallucinate. `st-ff` is the same shape with sampling inside, so output length varies.
  `ar-lm` samples audio tokens one at a time: length is emergent, cloning and emotion
  become possible, and real-time factor is floored by sequential decoding regardless of
  quantization.
- **RSS** is peak resident memory, and is dominated by the runtime rather than the model. Engines served by the C++
  binary carry no interpreter; those running in Python carry torch, transformers and their
  dependency trees.

## Methodology

**Machine.** Apple M2, macOS. One machine, one English corpus, one recogniser family.

**Nothing is filtered out.** Every configuration compared is listed, including the eleven
that cannot keep up with their own speech, because "how far off is it" is a real question
and a table that quietly omits the answer cannot be checked. The **Real time only** control
above the table hides anything above 2x for readers who only care about what can be spoken
live, and sorting by RTF or compute per phrase draws a line at the cutoff so the two groups
are visible at once.

The line falls at 2x exactly. Nothing sits awkwardly against it: the slowest engine that
keeps up is OmniVoice at 1.51x, and the fastest that does not is Chatterbox Q4 at 2.03x.

**Corpus.** 84 phrases, spoken identically by every configuration, spanning core, edge and
long-form categories.

**Scoring.** Round-trip word error rate, capped at 1.0 per phrase so a single runaway
cannot swamp the mean. Leading silence is worth knowing about here: Whisper transcribes it
as a word ("You", "Thank you.") rather than returning nothing, so an engine that pads the
start of a clip manufactures insertion errors and scores worse than it sounds. PESQ is
scored on **trimmed** audio: scoring untrimmed rewards models that pad with silence, by up
to 0.78, because silence pulls the estimate toward the ceiling and only mediocre audio has
room to rise.

**Passes.** Autoregressive engines are averaged over two passes, feed-forward over one.
Differences under roughly two points are not resolvable at this sample size.

### Limitations

Word error rate measures intelligibility and nothing else. It is blind to naturalness,
expressiveness and speaker similarity, which is precisely what the LM-backed engines exist
to provide, so this benchmark understates them by construction. Treat the table as a
shortlist for "will this be understood, and what will it cost me", and the play buttons as
the part that answers "does it sound any good".

One machine also means the device-level findings generalise no further than Apple silicon.
