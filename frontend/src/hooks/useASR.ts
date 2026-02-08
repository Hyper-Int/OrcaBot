// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

import { useCallback, useRef, useState, useEffect } from "react";
import { useASRSettingsStore, ASR_PROVIDERS, type ASRProvider } from "@/stores/asr-settings-store";

interface UseASROptions {
  onTranscript: (text: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
}

interface UseASRReturn {
  isListening: boolean;
  isSupported: boolean;
  start: () => Promise<void>;
  stop: () => void;
  error: string | null;
}

// Web Speech API types
interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

export function useASR({ onTranscript, onError }: UseASROptions): UseASRReturn {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = useASRSettingsStore((s) => s.provider);
  const getApiKey = useASRSettingsStore((s) => s.getApiKey);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const webSocketRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const isSupported = typeof window !== "undefined" && (
    provider === "web-speech"
      ? !!(window.SpeechRecognition || window.webkitSpeechRecognition)
      : !!(navigator.mediaDevices?.getUserMedia)
  );

  const cleanup = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    if (webSocketRef.current) {
      webSocketRef.current.close();
      webSocketRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    audioChunksRef.current = [];
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const startWebSpeech = useCallback(async () => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
      throw new Error("Web Speech API not supported in this browser");
    }

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimTranscript = "";
      let finalTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      if (finalTranscript) {
        onTranscript(finalTranscript, true);
      } else if (interimTranscript) {
        onTranscript(interimTranscript, false);
      }
    };

    recognition.onerror = (event: { error: string }) => {
      const errorMsg = `Speech recognition error: ${event.error}`;
      setError(errorMsg);
      onError?.(errorMsg);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [onTranscript, onError]);

  const startAssemblyAI = useCallback(async () => {
    const apiKey = getApiKey("ASSEMBLYAI_API_KEY");
    if (!apiKey) {
      throw new Error("AssemblyAI API key not configured");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    // Get temporary token for real-time streaming
    const tokenResponse = await fetch("https://api.assemblyai.com/v2/realtime/token", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expires_in: 3600 }),
    });

    if (!tokenResponse.ok) {
      throw new Error("Failed to get AssemblyAI token");
    }

    const { token } = await tokenResponse.json();

    const ws = new WebSocket(`wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${token}`);
    webSocketRef.current = ws;

    ws.onopen = () => {
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
          }
          ws.send(pcm16.buffer);
        }
      };
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.message_type === "PartialTranscript" && data.text) {
        onTranscript(data.text, false);
      } else if (data.message_type === "FinalTranscript" && data.text) {
        onTranscript(data.text, true);
      }
    };

    ws.onerror = () => {
      const errorMsg = "AssemblyAI WebSocket error";
      setError(errorMsg);
      onError?.(errorMsg);
      cleanup();
      setIsListening(false);
    };

    ws.onclose = () => {
      setIsListening(false);
    };

    setIsListening(true);
  }, [getApiKey, onTranscript, onError, cleanup]);

  const startDeepgram = useCallback(async () => {
    const apiKey = getApiKey("DEEPGRAM_API_KEY");
    if (!apiKey) {
      throw new Error("Deepgram API key not configured");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true`,
      ["token", apiKey]
    );
    webSocketRef.current = ws;

    ws.onopen = () => {
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const inputData = e.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
          }
          ws.send(pcm16.buffer);
        }
      };
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      if (transcript) {
        onTranscript(transcript, data.is_final);
      }
    };

    ws.onerror = () => {
      const errorMsg = "Deepgram WebSocket error";
      setError(errorMsg);
      onError?.(errorMsg);
      cleanup();
      setIsListening(false);
    };

    ws.onclose = () => {
      setIsListening(false);
    };

    setIsListening(true);
  }, [getApiKey, onTranscript, onError, cleanup]);

  const startOpenAI = useCallback(async () => {
    const apiKey = getApiKey("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OpenAI API key not configured");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    // OpenAI Whisper doesn't support streaming, so we record chunks
    const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorderRef.current = mediaRecorder;
    audioChunksRef.current = [];

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);

        // Send chunk to Whisper
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("file", audioBlob, "audio.webm");
        formData.append("model", "whisper-1");
        formData.append("response_format", "json");

        try {
          const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: formData,
          });

          if (response.ok) {
            const data = await response.json();
            if (data.text) {
              onTranscript(data.text, false);
            }
          }
        } catch (err) {
          console.error("OpenAI transcription error:", err);
        }
      }
    };

    mediaRecorder.onstop = async () => {
      if (audioChunksRef.current.length > 0) {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("file", audioBlob, "audio.webm");
        formData.append("model", "whisper-1");
        formData.append("response_format", "json");

        try {
          const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            body: formData,
          });

          if (response.ok) {
            const data = await response.json();
            if (data.text) {
              onTranscript(data.text, true);
            }
          }
        } catch (err) {
          const errorMsg = "OpenAI transcription failed";
          setError(errorMsg);
          onError?.(errorMsg);
        }
      }
      setIsListening(false);
    };

    // Record in 3-second chunks for partial results
    mediaRecorder.start(3000);
    setIsListening(true);
  }, [getApiKey, onTranscript, onError]);

  const start = useCallback(async () => {
    setError(null);
    cleanup();

    try {
      const providerConfig = ASR_PROVIDERS[provider];

      // Check if required keys are configured
      for (const keyConfig of providerConfig.requiredKeys) {
        if (!getApiKey(keyConfig.key)) {
          throw new Error(`${keyConfig.label} not configured. Open settings to add your API key.`);
        }
      }

      switch (provider) {
        case "web-speech":
          await startWebSpeech();
          break;
        case "assemblyai":
          await startAssemblyAI();
          break;
        case "deepgram":
          await startDeepgram();
          break;
        case "openai":
          await startOpenAI();
          break;
        default:
          throw new Error(`Unsupported ASR provider: ${provider}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to start speech recognition";
      setError(errorMsg);
      onError?.(errorMsg);
      setIsListening(false);
    }
  }, [provider, getApiKey, cleanup, startWebSpeech, startAssemblyAI, startDeepgram, startOpenAI, onError]);

  const stop = useCallback(() => {
    if (provider === "web-speech" && recognitionRef.current) {
      recognitionRef.current.stop();
    } else if (provider === "openai" && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
    } else {
      cleanup();
    }
    setIsListening(false);
  }, [provider, cleanup]);

  return {
    isListening,
    isSupported,
    start,
    stop,
    error,
  };
}
