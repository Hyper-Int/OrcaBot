---
title: Which Open-Weight TTS Engine Should You Actually Run?
date: 2026-08-14
description: Every open-weight TTS engine that runs faster than real time (or thereabouts), tested for WER using Whisper.
author: Rob Macrae
---

Here are all the available TTS open weight models that can likely run in real-time - or close to real-time, on consumer hardware.

We tested them against the same corpus, using Whisper medium to transcribe back to text.

Every row below can be played, so the fastest way to calibrate what a word error rate means
is to listen to **Piper** at 4% and **SpeechT5** at 24%.

## Results

Sorted by compute per phrase, fastest first. Click any column to re-sort.

```chart
tts-results
```

```chart
tts-preference
```

## What the numbers say

**Nothing in twenty-seven configurations is both more accurate and cheaper than Piper.**
Nothing has a lower word error than its 4%, and nothing speaks a phrase in less compute
than its 0.12s, at 0.04x real time. It is not the smallest: BananaMind TTS is 38 MB against
Piper's 60 MB of weights, and pays for it with 14% word error. Piper is a 2023 feed-forward
model with no cloning, no emotion, no prompt conditioning and no torch in the dependency
tree at all, and for reading text aloud it remains the answer.

**The LM-backed engines do not win on intelligibility, and they are not sold on it.**
**Qwen3-TTS** reaches 6%, matching the small feed-forward models while costing roughly 20×
the compute per phrase. **Chatterbox Turbo** is the notable arrival: 4% word error at 0.98x
real time, which is the first LM-backed engine here to reach Piper's accuracy and still
keep up with its own speech. What that compute buys is voice cloning and emotional range,
neither of which a word error rate can see. Judge them by ear.

**Quantization is what makes the LM-backed engines viable at all.** The NeuTTS-2E band
shows it directly: both fp32 builds sit at 2.42x and 2.44x, and quantizing the same weights
to Q4 takes them to 0.63x on CPU and 0.48x on Metal, a four-fold speed-up. Chatterbox tells
the same story across one family, from 4.19x for the full build to 2.22x at q8, 2.03x at
Q4, and 0.98x for Turbo, which is faster and more accurate than any of them. That trade is
invisible on any published model card.

**Four engines are not really in the running.** **Bark** at 55% word error invents lead-in
words that were never in the phrase; **Parler-TTS** at 39% could not finish the corpus in
the time allowed; **VibeVoice 1.5B** manages 37% while being larger and markedly worse than
the 1.02B build above it, and posts the lowest perceptual quality measured here at 1.60;
and **SpeechT5** at 24% sits below the threshold where output is reliably usable. Eight
configurations now score under 3 on PESQ, so that is no longer the outlier it was when only
the real-time set was listed.

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

**Nothing is filtered out.** Every configuration measured is listed, including the nine
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
cannot swamp the mean. PESQ is scored on **trimmed** audio: scoring untrimmed rewards
models that pad with silence, by up to 0.78, because silence pulls the estimate toward the
ceiling and only mediocre audio has room to rise.

**Passes.** Autoregressive engines are averaged over two passes, feed-forward over one.
Differences under roughly two points are not resolvable at this sample size.

**Device builds are listed separately.** The shaded band is one backbone, NeuTTS-2E,
crossed with both precisions and both devices. They are shown rather than pooled because
the point of the band is the comparison: the device changes the speed by a factor of four
while the word error moves by around two points, which is the scale at which this corpus
stops resolving differences at all.

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
