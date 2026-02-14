// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary
// REVISION: asr-v6-deepgram-token

const MODULE_REVISION = "asr-v6-deepgram-token";
console.log(`[useASR] REVISION: ${MODULE_REVISION} loaded at ${new Date().toISOString()}`);

import { useCallback, useRef, useState, useEffect } from "react";
import { useASRSettingsStore, ASR_PROVIDERS, type ASRProvider } from "@/stores/asr-settings-store";
import { getAssemblyAIToken, getDeepgramToken, transcribeDeepgram, transcribeOpenAI } from "@/lib/api/cloudflare/asr";

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
  const isKeyConfigured = useASRSettingsStore((s) => s.isKeyConfigured);
  const ensureKeyStatus = useASRSettingsStore((s) => s.ensureKeyStatus);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const webSocketRef = useRef<WebSocket | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const isSupported = typeof window !== "undefined" && (
    provider === "web-speech"
      ? !!(window.SpeechRecognition || window.webkitSpeechRecognition)
      : !!(navigator.mediaDevices?.getUserMedia)
  );

  // Stop the microphone and audio processing but keep the WebSocket alive
  // so remaining transcripts can arrive.
  const stopAudio = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }
    if (webSocketRef.current) {
      webSocketRef.current.close();
      webSocketRef.current = null;
    }
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
    }
    stopAudio();
    audioChunksRef.current = [];
  }, [stopAudio]);

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
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    // Get temporary token from control plane (real key never reaches the browser)
    const { token } = await getAssemblyAIToken();

    const ws = new WebSocket(`wss://api.assemblyai.com/v2/realtime/ws?sample_rate=16000&token=${token}`);
    webSocketRef.current = ws;

    ws.onopen = () => {
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
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
      cleanup();
      setIsListening(false);
    };

    setIsListening(true);
  }, [onTranscript, onError, cleanup]);

  const startDeepgramStreaming = useCallback((stream: MediaStream, token: string): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const deepgramUrl = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true`;
      const ws = new WebSocket(deepgramUrl, ["token", token]);
      webSocketRef.current = ws;
      let connected = false;

      ws.onopen = () => {
        connected = true;
        const audioContext = new AudioContext({ sampleRate: 16000 });
        audioContextRef.current = audioContext;
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

        resolve();
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        if (transcript) {
          onTranscript(transcript, data.is_final);
        }
      };

      ws.onerror = () => {
        if (!connected) {
          // Handshake failed — let startDeepgram fall back to chunked
          webSocketRef.current = null;
          reject(new Error("Deepgram WebSocket handshake failed"));
        } else {
          // Runtime error after successful connection
          const errorMsg = "Deepgram WebSocket error";
          setError(errorMsg);
          onError?.(errorMsg);
          cleanup();
          setIsListening(false);
        }
      };

      ws.onclose = () => {
        if (!connected) {
          webSocketRef.current = null;
          reject(new Error("Deepgram WebSocket closed before connecting"));
        } else {
          cleanup();
          setIsListening(false);
        }
      };
    });
  }, [onTranscript, onError, cleanup]);

  const startDeepgramChunked = useCallback(async (stream: MediaStream) => {
    // Fallback: chunk-based transcription via REST API (like OpenAI Whisper)
    const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorderRef.current = mediaRecorder;
    audioChunksRef.current = [];

    let stoppingRef = false;

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);
        if (stoppingRef) return;

        const audioSoFar = new Blob(audioChunksRef.current, { type: "audio/webm" });
        try {
          const text = await transcribeDeepgram(audioSoFar);
          if (text) {
            onTranscript(text, false);
          }
        } catch (err) {
          console.error("Deepgram transcription error:", err);
        }
      }
    };

    mediaRecorder.onstop = async () => {
      if (audioChunksRef.current.length > 0) {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        try {
          const text = await transcribeDeepgram(audioBlob);
          if (text) {
            onTranscript(text, true);
          }
        } catch (err) {
          const errorMsg = "Deepgram transcription failed";
          setError(errorMsg);
          onError?.(errorMsg);
        }
      }
      cleanup();
      setIsListening(false);
    };

    const origStop = mediaRecorder.stop.bind(mediaRecorder);
    mediaRecorder.stop = () => {
      stoppingRef = true;
      origStop();
    };

    mediaRecorder.start(3000);
  }, [onTranscript, onError, cleanup]);

  const startDeepgram = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    // Try token-based streaming first (requires Member scope key)
    try {
      const { token } = await getDeepgramToken();
      await startDeepgramStreaming(stream, token);
    } catch {
      // Token vending failed (insufficient permissions) — fall back to chunk-based REST
      console.log("[useASR] Deepgram token vending failed, falling back to chunk-based REST");
      await startDeepgramChunked(stream);
    }

    setIsListening(true);
  }, [startDeepgramStreaming, startDeepgramChunked]);

  const startOpenAI = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;

    // OpenAI Whisper doesn't support streaming, so we record chunks
    const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorderRef.current = mediaRecorder;
    audioChunksRef.current = [];

    let stoppingRef = false;

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);

        // Skip interim transcription for the final fragment — onstop handles the
        // definitive send. Individual chunks aren't valid standalone WebM files
        // (only the first contains the container header), so we always send all
        // accumulated chunks.
        if (stoppingRef) return;

        const audioSoFar = new Blob(audioChunksRef.current, { type: "audio/webm" });
        try {
          const text = await transcribeOpenAI(audioSoFar);
          if (text) {
            onTranscript(text, false);
          }
        } catch (err) {
          console.error("OpenAI transcription error:", err);
        }
      }
    };

    mediaRecorder.onstop = async () => {
      if (audioChunksRef.current.length > 0) {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });

        try {
          const text = await transcribeOpenAI(audioBlob);
          if (text) {
            onTranscript(text, true);
          }
        } catch (err) {
          const errorMsg = "OpenAI transcription failed";
          setError(errorMsg);
          onError?.(errorMsg);
        }
      }
      // Clean up mic stream and resources after final transcription
      cleanup();
      setIsListening(false);
    };

    // Expose stoppingRef so ondataavailable skips the last fragment
    const origStop = mediaRecorder.stop.bind(mediaRecorder);
    mediaRecorder.stop = () => {
      stoppingRef = true;
      origStop();
    };

    // Record in 3-second chunks for partial results
    mediaRecorder.start(3000);
    setIsListening(true);
  }, [onTranscript, onError, cleanup]);

  const start = useCallback(async () => {
    setError(null);
    cleanup();

    try {
      // Ensure key status is fetched before checking (handles fresh page load)
      if (provider !== "web-speech") {
        await ensureKeyStatus();
        if (!isKeyConfigured(provider)) {
          throw new Error("API key not configured. Open settings to add your API key.");
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
      cleanup();
      const errorMsg = err instanceof Error ? err.message : "Failed to start speech recognition";
      setError(errorMsg);
      onError?.(errorMsg);
      setIsListening(false);
    }
  }, [provider, isKeyConfigured, ensureKeyStatus, cleanup, startWebSpeech, startAssemblyAI, startDeepgram, startOpenAI, onError]);

  const stop = useCallback(() => {
    if (provider === "web-speech" && recognitionRef.current) {
      // Web Speech API: .stop() waits for pending results before firing onend
      recognitionRef.current.stop();
    } else if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      // MediaRecorder active (OpenAI or Deepgram chunked fallback)
      // .stop() triggers onstop which sends final transcript then calls cleanup()
      mediaRecorderRef.current.stop();
    } else if (webSocketRef.current && webSocketRef.current.readyState === WebSocket.OPEN) {
      // Streaming WebSocket (AssemblyAI or Deepgram token-based):
      // Stop the mic but keep the WS alive to receive remaining transcripts.
      stopAudio();
      // Tell AssemblyAI to flush pending transcripts
      try {
        webSocketRef.current.send(JSON.stringify({ terminate_session: true }));
      } catch {
        // Not AssemblyAI or send failed — Deepgram will flush when audio stops
      }
      // Safety: close WS after 5s if the server hasn't closed it
      const ws = webSocketRef.current;
      setTimeout(() => {
        if (ws === webSocketRef.current) {
          cleanup();
        }
      }, 5000);
    } else {
      cleanup();
    }
    setIsListening(false);
  }, [provider, cleanup, stopAudio]);

  return {
    isListening,
    isSupported,
    start,
    stop,
    error,
  };
}
