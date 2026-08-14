---
title: Which Open-Weight TTS Engine Should You Actually Run?
date: 2026-08-14
description: Eighteen text-to-speech configurations speaking the same corpus, transcribed back by Whisper, with every row playable
author: Rob Macrae
---

Text-to-speech leaderboards usually rank engines on mean opinion scores collected from
listening panels, which is expensive, slow, and impossible to reproduce on your own
hardware. This benchmark takes the cheap, mechanical route instead: **every engine speaks
the same 84-phrase corpus, and Whisper transcribes it back.** Word error rate is whatever
survives the round trip.

That measures one thing well and several things not at all. It is a good proxy for
**intelligibility**, which is what you need from a system that reads notifications, and it
is blind to naturalness, expressiveness and speaker similarity, which are the axes the
large LM-backed engines are actually sold on. This benchmark systematically understates
them, and the play buttons exist because that gap is audible.

Every row below can be played. All eighteen speak the same sentence, so the fastest way to
calibrate what a word error rate means is to listen to **Piper** at 4% and **Bark** at 55%.

## Results

Sorted as published, by word error rate. Click any column to re-sort. The shaded band is
NeuTTS-2E: one backbone crossed with every device it can actually run on, which is the
comparison the vendor's own card cannot show you.

```chart
tts-results
```

## What the numbers say

**Nothing beats Piper on all three axes at once.** 4% word error, 0.04× real time, 60 MB
on disk, and no torch in the dependency tree at all. It is a 2023 feed-forward model with
no cloning, no emotion and no prompt conditioning, and for reading text aloud it remains
the answer.

**The LM-backed engines do not win on intelligibility, and they are not sold on it.**
**Qwen3-TTS** and **Chatterbox** both reach 6%, matching the small feed-forward models, while
costing 20× and 100× more compute per phrase respectively. What you buy at that price is
voice cloning and emotional range, neither of which a word error rate can see. Judge them
by ear.

**Quantization is not free, and the device matters more than the bit width.** Across the
NeuTTS band, fp32 on CPU and q4 on CPU both land at 9% word error, but q4 cuts compute per
phrase from 9.28s to 2.49s. Moving q4 to Metal halves it again to 2.09s and costs 2 points
of accuracy. That is a real trade, and it is invisible on any published model card.

**Two engines are only nominally in the running.** **SpeechT5** at 24% and **Bark** at 55% are
below the threshold where output is reliably usable, and Bark spends 17.86s per phrase to
get there.

## How to read each column

The measurements are not interchangeable, and two of them actively mislead if taken at
face value.

- **RTF** is compute seconds per second of audio, the conventional measure. It **flatters
  any engine that emits excess silence**, because padding inflates the denominator. Prefer
  **Avg synth**, which is compute per phrase: every engine speaks the same corpus, so it
  compares directly and cannot be gamed by padding.
- **Lead-in** is silence before the first audible sample. It is not a defect in itself, but
  Whisper transcribes silence as a word ("You", "Thank you.") rather than returning
  nothing, so it manufactures insertion errors and inflates word error. It is measured on
  one clip per configuration, so treat it as indicative rather than a mean.
- **WER base / WER med** are the same audio scored by Whisper `base.en` and `medium.en`.
  They are not interchangeable: the weaker model hallucinates onto trailing silence and
  understates good engines more than bad ones, so the true spread between engines is wider
  than `base.en` suggests.
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

**Corpus.** 84 phrases, spoken identically by every configuration, spanning core, edge and
long-form categories.

**Scoring.** Round-trip word error rate, capped at 1.0 per phrase so a single runaway
cannot swamp the mean. PESQ is scored on **trimmed** audio: scoring untrimmed rewards
models that pad with silence, by up to 0.78, because silence pulls the estimate toward the
ceiling and only mediocre audio has room to rise.

**Passes.** Autoregressive engines are averaged over two passes, feed-forward over one.
Differences under roughly two points are not resolvable at this sample size.

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
