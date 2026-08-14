---
title: Which Open-Weight TTS Engine Should You Actually Run?
date: 2026-08-14
description: Every open-weight TTS engine that runs faster than real time, speaking the same corpus and transcribed back by Whisper, with the samples to listen to
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

**Only engines that can keep pace with real time are listed.** Anything above 2.1x real
time is excluded, because a model that cannot keep up with its own speech is not a
candidate for reading anything aloud as it happens. That drops six configurations,
including Chatterbox at 4.41x and Bark at 4.26x.

Every row below can be played, so the fastest way to calibrate what a word error rate means
is to listen to **Piper** at 4% and **SpeechT5** at 24%.

## Results

Sorted as published, by word error rate. Click any column to re-sort.

```chart
tts-results
```

## What the numbers say

**Nothing beats Piper on all three axes at once.** 4% word error, 0.04× real time, 60 MB
on disk, and no torch in the dependency tree at all. It is a 2023 feed-forward model with
no cloning, no emotion and no prompt conditioning, and for reading text aloud it remains
the answer.

**The LM-backed engines do not win on intelligibility, and they are not sold on it.**
**Qwen3-TTS** reaches 6%, matching the small feed-forward models while costing roughly 20×
the compute per phrase. **Chatterbox Turbo** is the notable arrival: 4% word error at 0.98x
real time, which is the first LM-backed engine here to reach Piper's accuracy and still
keep up with its own speech. What that compute buys is voice cloning and emotional range,
neither of which a word error rate can see. Judge them by ear.

**Quantization is what makes the LM-backed engines viable at all.** Every NeuTTS-2E
configuration that survives the real-time filter is quantized: the fp32 builds run at 2.35x
and 2.39x and are excluded outright. Chatterbox tells the same story across a single
family: the full build is 4.41x and out, Q4 scrapes in at 2.03x, and Turbo reaches 0.98x
while improving on both. That trade is invisible on any
published model card.

**One engine is only nominally in the running.** **SpeechT5** at 24% is below the threshold
where output is reliably usable, and its PESQ of 1.67 is the only score under 3 in the
table.

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

**Real-time filter.** Configurations above 2.1x RTF are excluded. Six are dropped by it:
Chatterbox and its q8 build, both NeuTTS-2E fp32 builds, CSM and Bark. Their measurements
remain in the raw export.

The cutoff sits just above 2.0 so Chatterbox Q4 stays in at 2.03x. Worth knowing when
reading it: RTF counts silence, and against speech alone that configuration is 2.59x, so it
is the one row here that is only nominally real time.

**Corpus.** 84 phrases, spoken identically by every configuration, spanning core, edge and
long-form categories.

**Scoring.** Round-trip word error rate, capped at 1.0 per phrase so a single runaway
cannot swamp the mean. PESQ is scored on **trimmed** audio: scoring untrimmed rewards
models that pad with silence, by up to 0.78, because silence pulls the estimate toward the
ceiling and only mediocre audio has room to rise.

**Passes.** Autoregressive engines are averaged over two passes, feed-forward over one.
Differences under roughly two points are not resolvable at this sample size.

**Device builds are pooled.** NeuTTS-2E Q4 was measured on both CPU and Metal. The device
changes how fast the same weights run, not how well they speak, so the two are pooled and
listed once: word error is the mean of both builds over 336 samples, and the speed, size
and memory figures are the Metal build. The evidence for treating the difference as noise
is that the stronger transcriber puts them 0.09 points apart (8.78% against 8.87%), while
only the weaker one separates them. PESQ and lead-in stay unpooled because both are scored
on the single playable clip.

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
