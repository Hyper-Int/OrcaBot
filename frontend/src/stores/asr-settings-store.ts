// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ASRProvider = "web-speech" | "assemblyai" | "openai" | "deepgram";

export interface ASRProviderConfig {
  name: string;
  requiredKeys: { key: string; label: string; placeholder: string }[];
  supportsStreaming: boolean;
}

export const ASR_PROVIDERS: Record<ASRProvider, ASRProviderConfig> = {
  "web-speech": {
    name: "Google Speech Recognition (Free)",
    requiredKeys: [],
    supportsStreaming: true,
  },
  assemblyai: {
    name: "AssemblyAI",
    requiredKeys: [
      { key: "ASSEMBLYAI_API_KEY", label: "API Key", placeholder: "Enter your AssemblyAI API key" },
    ],
    supportsStreaming: true,
  },
  openai: {
    name: "OpenAI Whisper",
    requiredKeys: [
      { key: "OPENAI_API_KEY", label: "API Key", placeholder: "Enter your OpenAI API key" },
    ],
    supportsStreaming: false,
  },
  deepgram: {
    name: "Deepgram",
    requiredKeys: [
      { key: "DEEPGRAM_API_KEY", label: "API Key", placeholder: "Enter your Deepgram API key" },
    ],
    supportsStreaming: true,
  },
};

interface ASRSettingsState {
  provider: ASRProvider;
  apiKeys: Record<string, string>;
  setProvider: (provider: ASRProvider) => void;
  setApiKey: (key: string, value: string) => void;
  getApiKey: (key: string) => string;
  clearApiKeys: () => void;
}

export const useASRSettingsStore = create<ASRSettingsState>()(
  persist(
    (set, get) => ({
      provider: "web-speech",
      apiKeys: {},
      setProvider: (provider) => {
        set({ provider });
      },
      setApiKey: (key, value) => {
        set((state) => ({
          apiKeys: { ...state.apiKeys, [key]: value },
        }));
      },
      getApiKey: (key) => {
        return get().apiKeys[key] || "";
      },
      clearApiKeys: () => {
        set({ apiKeys: {} });
      },
    }),
    {
      name: "orcabot-asr-settings",
    }
  )
);
