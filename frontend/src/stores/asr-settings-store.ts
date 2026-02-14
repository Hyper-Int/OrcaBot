// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: asr-settings-v7-user-scoped-cache

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getASRKeyStatus, type ASRProvider as ASRProviderAPI } from "@/lib/api/cloudflare/asr";
import { useAuthStore } from "@/stores/auth-store";

/** In-flight key status fetch promise — lets concurrent callers coalesce on one request. */
let keyStatusInflight: Promise<void> | null = null;
/** Last fetch error — surfaced by ensureKeyStatus so callers see the real reason. */
let keyStatusLastError: Error | null = null;
/** Generation counter — incremented on reset so stale in-flight responses are discarded. */
let keyStatusGeneration = 0;

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
  /** Server-side key status: which providers have keys configured */
  keyStatus: Record<string, boolean>;
  keyStatusLoading: boolean;
  /** Whether key status has been fetched at least once for the current user */
  keyStatusFetched: boolean;
  /** User ID the current keyStatus belongs to (for invalidation on user switch) */
  keyStatusUserId: string | null;
  setProvider: (provider: ASRProvider) => void;
  /** Check if a provider's key is configured (server-side) */
  isKeyConfigured: (provider: ASRProvider) => boolean;
  /** Refresh key status from the server. Throws on failure so callers can handle it. */
  refreshKeyStatus: () => Promise<void>;
  /** Ensure key status has been fetched at least once (no-op if already done for current user) */
  ensureKeyStatus: () => Promise<void>;
  /** Reset cached key status (called on user switch) */
  resetKeyStatus: () => void;
}

export const useASRSettingsStore = create<ASRSettingsState>()(
  persist(
    (set, get) => ({
      provider: "web-speech",
      keyStatus: {},
      keyStatusLoading: false,
      keyStatusFetched: false,
      keyStatusUserId: null,
      setProvider: (provider) => {
        set({ provider });
      },
      isKeyConfigured: (provider) => {
        if (provider === "web-speech") return true; // No key needed
        return get().keyStatus[provider] ?? false;
      },
      refreshKeyStatus: async () => {
        set({ keyStatusLoading: true });
        keyStatusLastError = null;
        const currentUserId = useAuthStore.getState().user?.id ?? null;
        const gen = keyStatusGeneration;
        const promise = getASRKeyStatus()
          .then((status) => {
            // Discard if a reset happened while this request was in flight
            if (gen !== keyStatusGeneration) return;
            set({
              keyStatus: status as Record<string, boolean>,
              keyStatusLoading: false,
              keyStatusFetched: true,
              keyStatusUserId: currentUserId,
            });
          })
          .catch((err) => {
            if (gen !== keyStatusGeneration) return;
            keyStatusLastError = err instanceof Error ? err : new Error(String(err));
            set({ keyStatusLoading: false });
            throw keyStatusLastError;
          })
          .finally(() => {
            if (gen === keyStatusGeneration) {
              keyStatusInflight = null;
            }
          });
        keyStatusInflight = promise;
        await promise;
      },
      ensureKeyStatus: async () => {
        // Invalidate cache if user changed since last fetch
        const currentUserId = useAuthStore.getState().user?.id ?? null;
        if (get().keyStatusFetched && get().keyStatusUserId === currentUserId) return;
        // User changed or never fetched — reset and re-fetch
        if (get().keyStatusUserId !== currentUserId) {
          get().resetKeyStatus();
        }
        // If a fetch is already in flight, await it instead of returning stale
        if (keyStatusInflight) {
          await keyStatusInflight;
        } else {
          await get().refreshKeyStatus();
        }
        // If the fetch failed, throw so callers see the real error instead of "key not configured"
        if (!get().keyStatusFetched && keyStatusLastError) {
          throw new Error(`Unable to check key status: ${keyStatusLastError.message}`);
        }
      },
      resetKeyStatus: () => {
        keyStatusGeneration++;
        keyStatusInflight = null;
        keyStatusLastError = null;
        set({ keyStatus: {}, keyStatusFetched: false, keyStatusLoading: false, keyStatusUserId: null });
      },
    }),
    {
      name: "orcabot-asr-settings",
      // Only persist the provider preference, not key status
      partialize: (state) => ({ provider: state.provider }),
      onRehydrateStorage: () => () => {
        // After store rehydrates from localStorage, eagerly fetch key status
        // Small delay to avoid racing with auth initialization
        setTimeout(() => {
          useASRSettingsStore.getState().ensureKeyStatus().catch(() => {
            // Swallow here — eager prefetch failure is non-fatal.
            // start() will retry and surface the real error when the user acts.
          });
        }, 500);
      },
    }
  )
);

// Reset ASR key status cache when the authenticated user changes
useAuthStore.subscribe((state, prevState) => {
  if (state.user?.id !== prevState.user?.id) {
    useASRSettingsStore.getState().resetKeyStatus();
  }
});
