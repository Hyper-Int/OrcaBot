// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";

import * as React from "react";
import type { AudioEvent } from "@/types/terminal";
import { API } from "@/config/env";

interface UseTerminalAudioOptions {
  sessionId: string;
  enabled?: boolean;
}

/**
 * Hook for handling terminal audio playback (TTS from talkito, etc.)
 */
export function useTerminalAudio(options: UseTerminalAudioOptions) {
  const { sessionId, enabled = true } = options;
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const audioContextRef = React.useRef<AudioContext | null>(null);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, []);

  /**
   * Play audio from a file path in the sandbox workspace
   */
  const playFromFile = React.useCallback(
    async (path: string) => {
      if (!enabled) return;

      try {
        // Fetch the audio file from the sandbox via control plane
        const url = API.cloudflare.sessionFile(sessionId, path);
        const response = await fetch(url, {
          credentials: "include",
        });

        if (!response.ok) {
          console.error(`Failed to fetch audio file: ${response.status}`);
          return;
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);

        // Stop any currently playing audio
        if (audioRef.current) {
          audioRef.current.pause();
          URL.revokeObjectURL(audioRef.current.src);
        }

        // Create and play audio
        const audio = new Audio(objectUrl);
        audioRef.current = audio;

        audio.onended = () => {
          URL.revokeObjectURL(objectUrl);
        };

        audio.onerror = (e) => {
          console.error("Audio playback error:", e);
          URL.revokeObjectURL(objectUrl);
        };

        await audio.play();
      } catch (error) {
        console.error("Failed to play audio from file:", error);
      }
    },
    [sessionId, enabled]
  );

  /**
   * Play audio from base64-encoded data
   */
  const playFromBase64 = React.useCallback(
    async (data: string, format?: string) => {
      if (!enabled) return;

      try {
        // Decode base64 to binary
        const binaryString = atob(data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // Determine MIME type
        const mimeType =
          format === "wav"
            ? "audio/wav"
            : format === "ogg"
              ? "audio/ogg"
              : "audio/mpeg"; // Default to mp3

        const blob = new Blob([bytes], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);

        // Stop any currently playing audio
        if (audioRef.current) {
          audioRef.current.pause();
          URL.revokeObjectURL(audioRef.current.src);
        }

        // Create and play audio
        const audio = new Audio(objectUrl);
        audioRef.current = audio;

        audio.onended = () => {
          URL.revokeObjectURL(objectUrl);
        };

        audio.onerror = (e) => {
          console.error("Audio playback error:", e);
          URL.revokeObjectURL(objectUrl);
        };

        await audio.play();
      } catch (error) {
        console.error("Failed to play audio from base64:", error);
      }
    },
    [enabled]
  );

  /**
   * Stop any currently playing audio
   */
  const stop = React.useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, []);

  /**
   * Handle an AudioEvent from the WebSocket
   */
  const handleAudioEvent = React.useCallback(
    (event: AudioEvent) => {
      if (event.action === "stop") {
        stop();
        return;
      }

      if (event.action === "play") {
        if (event.data) {
          // Base64 inline audio
          playFromBase64(event.data, event.format);
        } else if (event.path) {
          // File-based audio
          playFromFile(event.path);
        }
      }
    },
    [playFromBase64, playFromFile, stop]
  );

  return {
    handleAudioEvent,
    playFromFile,
    playFromBase64,
    stop,
  };
}
