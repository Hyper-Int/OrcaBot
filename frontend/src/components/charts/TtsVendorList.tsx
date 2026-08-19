// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

// REVISION: tts-vendor-list-v4-supertone
// The organisations whose models are in the table, as linked chips.
//
// This was a scrolling marquee, matching the splash page. It is now static
// rows, which is strictly better here: every vendor is readable at once instead
// of a third of them being mid-transit, nothing has to be chased with the
// pointer to click it, and the set no longer has to be duplicated to fake a
// seamless loop - so there is no hidden copy to keep out of the accessibility
// tree, and no motion to suppress for readers who have asked for less of it.
//
// The logos are each organisation's own avatar, taken from their GitHub
// organisation page. That is deliberate over pulling logo files off marketing
// sites: it is one consistent source, it is the image the organisation itself
// publishes to identify its account, and it stays a fair, factual reference to
// whose model is being measured. It implies no endorsement; these are the
// authors of the models tested, not partners.

import * as React from "react";

const MODULE_REVISION = "tts-vendor-list-v4-supertone";
if (typeof window !== "undefined") {
  console.log(`[tts-vendor-list] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

interface Vendor { name: string; icon: string; url: string }

/** Alphabetical, sorted at load rather than by hand so a new entry cannot be
 *  dropped in the wrong place. localeCompare so case does not split the list -
 *  "dots.tts" and "hexgrad" belong among the capitalised names, not after them. */
const VENDORS: Vendor[] = [
  { name: "Resemble AI", icon: "resemble-ai.png", url: "https://github.com/resemble-ai/chatterbox" },
  { name: "Neuphonic", icon: "neuphonic.png", url: "https://huggingface.co/neuphonic/neutts-2e" },
  { name: "Microsoft", icon: "microsoft.png", url: "https://github.com/microsoft/VibeVoice" },
  { name: "Qwen", icon: "QwenLM.png", url: "https://github.com/QwenLM/Qwen3-TTS" },
  { name: "Hume AI", icon: "HumeAI.png", url: "https://huggingface.co/HumeAI/tada-3b-ml" },
  { name: "k2-fsa", icon: "k2-fsa.png", url: "https://github.com/k2-fsa/OmniVoice" },
  { name: "Rhasspy", icon: "rhasspy.png", url: "https://github.com/rhasspy/piper" },
  { name: "hexgrad", icon: "hexgrad.png", url: "https://huggingface.co/hexgrad/Kokoro-82M" },
  { name: "Suno", icon: "suno-ai.jpg", url: "https://github.com/suno-ai/bark" },
  { name: "Meta", icon: "facebookresearch.png", url: "https://huggingface.co/facebook/mms-tts" },
  { name: "Banaxi-Tech", icon: "Banaxi-Tech.png", url: "https://huggingface.co/Banaxi-Tech/BananaMind-TTS-V2" },
  { name: "Coqui", icon: "coqui-ai.png", url: "https://huggingface.co/coqui/XTTS-v2" },
  { name: "MyShell", icon: "myshell-ai.png", url: "https://github.com/myshell-ai/MeloTTS" },
  { name: "KittenML", icon: "KittenML.png", url: "https://github.com/KittenML/KittenTTS" },
  { name: "Sesame", icon: "SesameAILabs.png", url: "https://github.com/SesameAILabs/csm" },
  { name: "Zyphra", icon: "Zyphra.png", url: "https://github.com/Zyphra/Zonos" },
  { name: "NVIDIA", icon: "NVIDIA.png", url: "https://github.com/NVIDIA-NeMo/Speech" },
  { name: "dots.tts", icon: "studio-dots-ai.png", url: "https://github.com/studio-dots-ai/dots.tts" },
  { name: "SWivid", icon: "SWivid.jpg", url: "https://github.com/SWivid/F5-TTS" },
  { name: "Supertone", icon: "supertone-inc.png", url: "https://github.com/supertone-inc/supertonic" },
].sort((a, b) => a.name.localeCompare(b.name, "en"));

const ICON_BASE = "/icons/tts/";

// Selectors are deliberately over-specific. This renders inside .legal-content,
// whose "a" rule paints every link accent blue and underlines it, and whose
// "img" rule sets display:block with 1.75rem of vertical margin - which alone
// inflated these chips from 36px tall to 92px. Both need beating on specificity.
const CSS = `
.tts-vendors-figure ul.tts-vendors {
  display: flex; flex-wrap: wrap; gap: 6px;
  margin: 0; padding: 0; list-style: none;
}
.tts-vendors-figure ul.tts-vendors > li { margin: 0; padding: 0; list-style: none; }
.tts-vendors a.tts-vendor-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 7px 11px; border: 1px solid var(--border, #2a4570); border-radius: 40px;
  font-size: 0.8rem; font-weight: 500; line-height: 1;
  color: var(--foreground, #e8edf5);
  text-decoration: none; white-space: nowrap; background: var(--background-elevated, #0d1526);
}
.tts-vendors a.tts-vendor-chip:hover,
.tts-vendors a.tts-vendor-chip:focus-visible { border-color: #d95926; opacity: 1; }
.tts-vendors a.tts-vendor-chip img {
  width: 16px; height: 16px; margin: 0; display: inline-block;
  object-fit: contain; border-radius: 4px; flex-shrink: 0;
}
`;

export function TtsVendorList() {
  return (
    <figure className="tts-vendors-figure" style={{ margin: "2rem 0" }}>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <figcaption style={{ marginBottom: "0.6rem", fontSize: "0.8rem", color: "#94a3c0" }}>
        Every model measured here is somebody&apos;s published work. These are the teams behind
        them.
      </figcaption>
      {/* A list, because that is what it is: a set of related links with no
          order that matters to the reader. */}
      <ul className="tts-vendors">
        {VENDORS.map((v) => (
          <li key={v.name}>
            <a className="tts-vendor-chip" href={v.url} target="_blank" rel="noopener noreferrer">
              <img src={ICON_BASE + v.icon} alt="" width={18} height={18} />
              {v.name}
            </a>
          </li>
        ))}
      </ul>
    </figure>
  );
}
