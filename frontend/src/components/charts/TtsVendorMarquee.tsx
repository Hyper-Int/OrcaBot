// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-vendor-marquee-v1
// The organisations whose models are in the table, as a scrolling strip of
// linked chips - the same shape as the "A growing ecosystem" marquee on the
// splash page. That CSS is scoped to .splash-page, so the styling is restated
// here rather than shared; it is twenty lines and coupling two unrelated pages
// through a stylesheet would cost more than it saves.
//
// The logos are each organisation's own avatar, taken from their GitHub
// organisation page. That is deliberate over pulling logo files off marketing
// sites: it is one consistent source, it is the image the organisation itself
// publishes to identify its account, and it stays a fair, factual reference to
// whose model is being measured.
//
// Two things this does not do. It does not animate under
// prefers-reduced-motion, where an endless horizontal crawl is exactly the kind
// of motion that setting exists to stop - it becomes a static wrapped list. And
// it does not claim endorsement: these are the authors of the models tested,
// not partners.

import * as React from "react";

const MODULE_REVISION = "tts-vendor-marquee-v1";
if (typeof window !== "undefined") {
  console.log(`[tts-vendor-marquee] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

interface Vendor { name: string; icon: string; url: string }

/** Ordered roughly by how much of the table each accounts for. */
const VENDORS: Vendor[] = [
  { name: "Resemble AI", icon: "resemble-ai.png", url: "https://github.com/resemble-ai/chatterbox" },
  { name: "Neuphonic", icon: "neuphonic.png", url: "https://huggingface.co/neuphonic/neutts-2e" },
  { name: "Microsoft", icon: "microsoft.png", url: "https://github.com/microsoft/VibeVoice" },
  { name: "Qwen", icon: "QwenLM.png", url: "https://github.com/QwenLM/Qwen3-TTS" },
  { name: "Hume AI", icon: "HumeAI.png", url: "https://huggingface.co/HumeAI/tada-3b-ml" },
  { name: "Rhasspy", icon: "rhasspy.png", url: "https://github.com/rhasspy/piper" },
  { name: "hexgrad", icon: "hexgrad.png", url: "https://huggingface.co/hexgrad/Kokoro-82M" },
  { name: "Suno", icon: "suno-ai.jpg", url: "https://github.com/suno-ai/bark" },
  { name: "Meta", icon: "facebookresearch.png", url: "https://huggingface.co/facebook/mms-tts" },
  { name: "Hugging Face", icon: "huggingface.png", url: "https://github.com/huggingface/parler-tts" },
  { name: "Coqui", icon: "coqui-ai.png", url: "https://huggingface.co/coqui/XTTS-v2" },
  { name: "MyShell", icon: "myshell-ai.png", url: "https://github.com/myshell-ai/MeloTTS" },
  { name: "KittenML", icon: "KittenML.png", url: "https://huggingface.co/KittenML/kitten-tts-nano-0.1" },
  { name: "Sesame", icon: "SesameAILabs.png", url: "https://github.com/SesameAILabs/csm" },
  { name: "Zyphra", icon: "Zyphra.png", url: "https://github.com/Zyphra/Zonos" },
  { name: "NVIDIA", icon: "NVIDIA.png", url: "https://github.com/NVIDIA-NeMo/Speech" },
  { name: "dots.tts", icon: "studio-dots-ai.png", url: "https://github.com/rednote-hilab/dots.tts" },
  { name: "SWivid", icon: "SWivid.jpg", url: "https://github.com/SWivid/F5-TTS" },
];

const ICON_BASE = "/icons/tts/";

const CSS = `
.tts-marquee { overflow: hidden; position: relative; margin: 0; }
.tts-marquee-fade { position: absolute; top: 0; bottom: 0; width: 64px; z-index: 2; pointer-events: none; }
.tts-marquee-fade.l { left: 0; background: linear-gradient(to right, var(--background), transparent); }
.tts-marquee-fade.r { right: 0; background: linear-gradient(to left, var(--background), transparent); }
.tts-marquee-track { display: flex; gap: 10px; width: max-content; animation: tts-marquee 46s linear infinite; }
.tts-marquee-track:hover, .tts-marquee-track:focus-within { animation-play-state: paused; }
@keyframes tts-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
/* Selectors are deliberately over-specific. This renders inside .legal-content,
   whose "a" rule paints every link accent blue and underlines it, and whose
   "img" rule sets display:block with 1.75rem of vertical margin - which alone
   inflated these chips from 36px tall to 92px. Both need beating on
   specificity, not politeness. */
.tts-marquee a.tts-vendor-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 14px; border: 1px solid var(--border, #2a4570); border-radius: 40px;
  font-size: 0.82rem; font-weight: 500; line-height: 1;
  color: var(--foreground, #e8edf5);
  text-decoration: none; white-space: nowrap; background: var(--background-elevated, #0d1526);
}
.tts-marquee a.tts-vendor-chip:hover,
.tts-marquee a.tts-vendor-chip:focus-visible { border-color: #d95926; opacity: 1; }
.tts-marquee a.tts-vendor-chip img {
  width: 18px; height: 18px; margin: 0; display: inline-block;
  object-fit: contain; border-radius: 4px; flex-shrink: 0;
}
@media (prefers-reduced-motion: reduce) {
  /* An endless crawl is the motion this setting exists to stop, and a paused
     marquee would hide half the list off-screen - so it becomes a plain list. */
  .tts-marquee-track { animation: none; width: auto; flex-wrap: wrap; }
  .tts-marquee-fade { display: none; }
  .tts-marquee-track .tts-dupe { display: none; }
}
`;

export function TtsVendorMarquee() {
  return (
    <figure className="tts-marquee-figure" style={{ margin: "2rem 0" }}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <figcaption style={{ marginBottom: "0.6rem", fontSize: "0.8rem", color: "#94a3c0" }}>
        Every model measured here is somebody&apos;s published work. These are the teams behind
        them.
      </figcaption>
      <div className="tts-marquee">
        <div className="tts-marquee-fade l" />
        <div className="tts-marquee-fade r" />
        <div className="tts-marquee-track">
          {/* Doubled so the loop is seamless; the copy is hidden from assistive
              tech and from reduced-motion readers, who get the list once. */}
          {[...VENDORS, ...VENDORS].map((v, i) => {
            const dupe = i >= VENDORS.length;
            return (
              <a
                key={`${v.name}-${i}`}
                className={`tts-vendor-chip${dupe ? " tts-dupe" : ""}`}
                href={v.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-hidden={dupe || undefined}
                tabIndex={dupe ? -1 : undefined}
              >
                {/* Eagerly loaded on purpose. These are 18px avatars, ~100KB for the
                    whole strip, and lazy loading never fires for the later chips:
                    they sit outside the viewport and the marquee moves by
                    transform, not by scrolling, so nothing brings them into view. */}
                <img src={ICON_BASE + v.icon} alt="" width={18} height={18} />
                {v.name}
              </a>
            );
          })}
        </div>
      </div>
    </figure>
  );
}
