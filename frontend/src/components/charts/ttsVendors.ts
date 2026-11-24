// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// The organisations whose models appear in the TTS benchmark, and the mapping
// from a row's own model link back to one of them.
//
// This lives apart from the chip list because two components need it: the chip
// row under the intro, and the logo column in the results table. Keeping one
// list means a vendor cannot be added to the chips and forgotten in the table,
// which is exactly how the chips fell out of step with the rows before.
//
// The logos are each organisation's own avatar, taken from their GitHub
// organisation page. That is deliberate over pulling logo files off marketing
// sites: it is one consistent source, it is the image the organisation itself
// publishes to identify its account, and it stays a fair, factual reference to
// whose model is being measured. It implies no endorsement; these are the
// authors of the models tested, not partners.

// REVISION: tts-vendors-v2-openmoss
const MODULE_REVISION = "tts-vendors-v2-openmoss";
if (typeof window !== "undefined") {
  console.log(`[tts-vendors] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);
}

export interface Vendor {
  name: string;
  icon: string;
  url: string;
}

/** Alphabetical, sorted at load rather than by hand so a new entry cannot be
 *  dropped in the wrong place. localeCompare so case does not split the list -
 *  "dots.tts" and "hexgrad" belong among the capitalised names, not after them. */
export const VENDORS: Vendor[] = [
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
  { name: "Canopy Labs", icon: "canopyai.png", url: "https://github.com/canopyai/Orpheus-TTS" },
  { name: "Kyutai", icon: "kyutai-labs.png", url: "https://github.com/kyutai-labs/pocket-tts" },
  { name: "OpenBMB", icon: "OpenBMB.png", url: "https://github.com/OpenBMB/VoxCPM" },
  { name: "IndexTeam", icon: "index-tts.png", url: "https://github.com/index-tts/index-tts" },
  { name: "Fish Audio", icon: "fishaudio.png", url: "https://github.com/fishaudio/fish-speech" },
  { name: "nineninesix", icon: "nineninesix-ai.png", url: "https://github.com/nineninesix-ai/kani-tts" },
  { name: "OpenMOSS", icon: "OpenMOSS.png", url: "https://github.com/OpenMOSS/MOSS-TTS-Nano" },
  // StyleTTS2 is one author rather than an organisation, and was missing from
  // this list long before the three above it - the chips were never checked
  // against the table's own rows until now.
  { name: "yl4579", icon: "yl4579.png", url: "https://github.com/yl4579/StyleTTS2" },
].sort((a, b) => a.name.localeCompare(b.name, "en"));

export const ICON_BASE = "/icons/tts/";

const ORG_RE = /^https:\/\/(?:github\.com|huggingface\.co)\/([^/]+)/;

const orgOf = (url: string | undefined): string | undefined =>
  url?.match(ORG_RE)?.[1]?.toLowerCase();

/** Accounts a vendor publishes under that are not the one its chip links to.
 *  Qwen ships the TTS models from three orgs and NVIDIA's Magpie rows point at
 *  the model cards under `nvidia` rather than the NeMo repo, so matching on the
 *  chip URL alone would leave nine of the table's rows without a logo. Resolved
 *  by alias rather than by loosening the match, because a prefix or substring
 *  rule would eventually put the wrong logo on a row, which is worse than none. */
const ORG_ALIASES: Record<string, string> = {
  qwen: "qwenlm",
  qwenaudio: "qwenlm",
  nvidia: "nvidia-nemo",
};

const BY_ORG = new Map<string, Vendor>(
  VENDORS.flatMap((v) => {
    const org = orgOf(v.url);
    return org ? ([[org, v]] as [string, Vendor][]) : [];
  })
);

/** The vendor behind a row, found from the model link the row already carries.
 *  Derived rather than kept as a second config-to-vendor table: the link is the
 *  row's own evidence of whose model it is, so the logo cannot drift from it. */
export function vendorForUrl(url: string | undefined): Vendor | undefined {
  const org = orgOf(url);
  if (!org) return undefined;
  return BY_ORG.get(ORG_ALIASES[org] ?? org) ?? BY_ORG.get(org);
}
