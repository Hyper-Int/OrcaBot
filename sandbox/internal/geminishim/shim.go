// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: gemini-shim-v1-openrouter-bridge
//
// Package geminishim is a localhost translation proxy that lets the *official*
// Google Gemini CLI talk to OpenRouter.
//
// The Gemini CLI's GATEWAY auth mode (triggered by GOOGLE_GEMINI_BASE_URL) speaks
// the Gemini `:generateContent` / `:streamGenerateContent` wire format via the
// @google/genai SDK. OpenRouter only exposes OpenAI- and Anthropic-compatible
// surfaces, so a direct hookup fails on protocol. This shim accepts the Gemini
// wire format, translates to OpenAI Chat Completions, forwards through the local
// secrets broker (so the real OPENROUTER_API_KEY is injected server-side and never
// reaches the CLI), and translates the response back to the Gemini format.
//
// Request URL shape (set by applyOpenRouterEnv as GOOGLE_GEMINI_BASE_URL):
//
//	http://127.0.0.1:{port}/gv1/{sessionID}/{base64url(openrouterModel)}
//
// The SDK appends `/{apiVersion}/models/{cliModel}:{method}` — the shim ignores
// the CLI's model name and uses the OpenRouter id baked into the base URL.
//
// PROTOTYPE SCOPE: text and tool/function calling (best-effort id mapping) for
// both streaming and non-streaming. countTokens returns a char/4 estimate.
// embedContent and image/thinking parts are not supported.
package geminishim

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

// debugEnabled gates verbose per-request body logging.
func debugEnabled() bool { return os.Getenv("ORCABOT_DEBUG_GEMINI_SHIM") == "1" }

// truncate keeps log lines bounded.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…(" + fmt.Sprintf("%d", len(s)) + "b)"
}

const shimRevision = "gemini-shim-v1-openrouter-bridge"

func init() {
	log.Printf("[gemini-shim] REVISION: %s loaded at %s", shimRevision, time.Now().Format(time.RFC3339))
}

// Shim is the localhost Gemini→OpenRouter translation server.
type Shim struct {
	port       int
	brokerPort int
	server     *http.Server
	client     *http.Client
}

// New creates a shim that forwards translated requests to the secrets broker's
// "openrouter" (OpenAI-compatible) provider on brokerPort.
func New(port, brokerPort int) *Shim {
	return &Shim{
		port:       port,
		brokerPort: brokerPort,
		// No client timeout: streaming responses are long-lived. The broker
		// itself enforces a 120s upstream timeout.
		client: &http.Client{},
	}
}

// Port returns the port the shim listens on.
func (s *Shim) Port() int { return s.port }

// Start begins listening on localhost.
func (s *Shim) Start() error {
	s.server = &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", s.port),
		Handler: s,
	}
	log.Printf("[gemini-shim] starting on localhost:%d (broker=%d)", s.port, s.brokerPort)
	return s.server.ListenAndServe()
}

// Stop gracefully shuts down the shim.
func (s *Shim) Stop() error {
	if s.server == nil {
		return nil
	}
	return s.server.Close()
}

// ServeHTTP routes a harness-format request to the chat-completions translation.
// Gemini requests use the `/gv1/` prefix; Anthropic (Claude) requests use `/av1/`.
func (s *Shim) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/av1/") {
		s.serveAnthropic(w, r)
		return
	}

	sessionID, provider, model, method, ok := parsePath(r.URL.Path)
	if !ok {
		writeGeminiError(w, http.StatusBadRequest, "invalid shim path; expected /gv1/{session}/{provider}/{model}/v1.../models/{m}:{method}")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeGeminiError(w, http.StatusBadRequest, "failed to read request body")
		return
	}

	switch method {
	case "generateContent":
		s.handleGenerate(w, sessionID, provider, model, body, false)
	case "streamGenerateContent":
		s.handleGenerate(w, sessionID, provider, model, body, true)
	case "countTokens":
		handleCountTokens(w, body)
	case "embedContent", "batchEmbedContents":
		writeGeminiError(w, http.StatusNotImplemented, "embeddings are not supported by the OpenRouter bridge")
	default:
		writeGeminiError(w, http.StatusNotFound, "unsupported method: "+method)
	}
}

// parsePath extracts sessionID, the broker provider, the decoded model, and the
// RPC method from a shim request path of the form:
//
//	/gv1/{sessionID}/{provider}/{modelB64}/{apiVersion}/models/{cliModel}:{method}
func parsePath(path string) (sessionID, provider, model, method string, ok bool) {
	rest := strings.TrimPrefix(path, "/gv1/")
	if rest == path {
		return "", "", "", "", false
	}
	parts := strings.SplitN(rest, "/", 4)
	if len(parts) < 4 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", "", "", "", false
	}
	sessionID = parts[0]
	provider = parts[1]
	decoded, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(decoded) == 0 {
		return "", "", "", "", false
	}
	model = string(decoded)

	// The method is the segment after the final ':'.
	colon := strings.LastIndex(path, ":")
	if colon == -1 {
		return "", "", "", "", false
	}
	method = path[colon+1:]
	// Drop any trailing query that LastIndex(path) wouldn't (URL.Path has no query),
	// but guard against accidental slashes.
	if slash := strings.IndexByte(method, '/'); slash != -1 {
		method = method[:slash]
	}
	return sessionID, provider, model, method, method != ""
}

// forwardChat sends an already-translated OpenAI Chat Completions request through
// the broker for the given provider (e.g. "openrouter", or a custom-provider ref)
// and returns the response for the caller to translate. The broker injects the
// real key; the placeholder Authorization satisfies any client-side key guard.
//
// Parameterizing the provider is the foundation for custom/self-hosted endpoints
// (PLAN-custom-endpoints.md): the same translation core forwards to OpenRouter or
// to a user-configured custom-provider broker entry.
func (s *Shim) forwardChat(sessionID, provider string, oreqBody []byte) (*http.Response, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d/broker/%s/%s/chat/completions", s.brokerPort, sessionID, provider)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(oreqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer broker-injected")
	return s.client.Do(req)
}

// handleGenerate translates a Gemini generate request to OpenAI Chat Completions,
// forwards it through the broker, and translates the response back.
func (s *Shim) handleGenerate(w http.ResponseWriter, sessionID, provider, model string, body []byte, stream bool) {
	var greq genReq
	if err := json.Unmarshal(body, &greq); err != nil {
		writeGeminiError(w, http.StatusBadRequest, "invalid Gemini request: "+err.Error())
		return
	}

	oreq := geminiToOpenAI(greq, model, stream)
	oreqBody, err := json.Marshal(oreq)
	if err != nil {
		writeGeminiError(w, http.StatusInternalServerError, "failed to encode upstream request")
		return
	}

	log.Printf("[gemini-shim] -> session=%s model=%s stream=%t msgs=%d tools=%d",
		sessionID, model, stream, len(oreq.Messages), len(oreq.Tools))
	if debugEnabled() {
		log.Printf("[gemini-shim] openai request: %s", truncate(string(oreqBody), 4000))
	}

	resp, err := s.forwardChat(sessionID, provider, oreqBody)
	if err != nil {
		writeGeminiError(w, http.StatusBadGateway, "broker request failed: "+err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		log.Printf("[gemini-shim] <- upstream HTTP %d session=%s model=%s body=%s",
			resp.StatusCode, sessionID, model, truncate(string(errBody), 2000))
		writeGeminiError(w, resp.StatusCode, "openrouter error: "+strings.TrimSpace(string(errBody)))
		return
	}

	if stream {
		streamOpenAIToGemini(w, resp.Body)
		return
	}

	var oresp oaiResp
	respBody, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(respBody, &oresp); err != nil {
		log.Printf("[gemini-shim] <- unparseable response session=%s body=%s", sessionID, truncate(string(respBody), 2000))
		writeGeminiError(w, http.StatusBadGateway, "failed to parse openrouter response")
		return
	}
	// OpenRouter can return 200 with an error envelope (e.g. provider error).
	if oresp.Error != nil {
		log.Printf("[gemini-shim] <- upstream error envelope session=%s model=%s err=%s", sessionID, model, oresp.Error.String())
		writeGeminiError(w, http.StatusBadGateway, "openrouter error: "+oresp.Error.String())
		return
	}
	if debugEnabled() {
		log.Printf("[gemini-shim] openai response: %s", truncate(string(respBody), 4000))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(openAIToGemini(oresp))
}

// handleCountTokens returns a rough estimate (chars/4) so the CLI's context
// management has a number to work with. OpenRouter has no countTokens endpoint.
func handleCountTokens(w http.ResponseWriter, body []byte) {
	var greq genReq
	_ = json.Unmarshal(body, &greq)
	chars := 0
	for _, c := range greq.Contents {
		for _, p := range c.Parts {
			chars += len(p.Text)
		}
	}
	if greq.SystemInstruction != nil {
		for _, p := range greq.SystemInstruction.Parts {
			chars += len(p.Text)
		}
	}
	est := chars / 4
	if est < 1 && chars > 0 {
		est = 1
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"totalTokens": est})
}

// streamOpenAIToGemini reads an OpenAI SSE stream and re-emits it as a Gemini SSE
// stream. Text deltas are forwarded as they arrive; tool-call deltas are
// accumulated and emitted as functionCall parts in a final chunk.
func streamOpenAIToGemini(w http.ResponseWriter, body io.Reader) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	reader := bufio.NewReader(body)
	finishReason := "stop"
	toolAcc := map[int]*oaiToolCall{} // index -> accumulating tool call
	var usage *oaiUsage

	emit := func(resp geminiResp) {
		data, _ := json.Marshal(resp)
		fmt.Fprintf(w, "data: %s\n\n", data)
		if flusher != nil {
			flusher.Flush()
		}
	}

	for {
		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "data:") {
				payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
				if payload == "[DONE]" {
					break
				}
				var chunk oaiStreamChunk
				if json.Unmarshal([]byte(payload), &chunk) == nil {
					if chunk.Error != nil {
						// OpenRouter can stream an error envelope mid-stream.
						log.Printf("[gemini-shim] <- stream error envelope: %s", chunk.Error.String())
						emit(geminiResp{Candidates: []geminiCandidate{{
							Content:      geminiContent{Role: "model", Parts: []geminiPart{{Text: "[shim] upstream error: " + chunk.Error.String()}}},
							FinishReason: "STOP",
							Index:        0,
						}}})
						return
					}
					if chunk.Usage != nil {
						usage = chunk.Usage
					}
					if len(chunk.Choices) > 0 {
						ch := chunk.Choices[0]
						if ch.FinishReason != "" {
							finishReason = ch.FinishReason
						}
						if ch.Delta.Content != "" {
							emit(geminiTextChunk(ch.Delta.Content))
						}
						for _, tc := range ch.Delta.ToolCalls {
							acc := toolAcc[tc.Index]
							if acc == nil {
								acc = &oaiToolCall{}
								toolAcc[tc.Index] = acc
							}
							if tc.ID != "" {
								acc.ID = tc.ID
							}
							if tc.Function.Name != "" {
								acc.Function.Name = tc.Function.Name
							}
							acc.Function.Arguments += tc.Function.Arguments
						}
					}
				}
			}
		}
		if err != nil {
			break
		}
	}

	// Final chunk: finishReason, any accumulated tool calls, and usage.
	// Parts MUST be a non-nil array — a `"parts":null` candidate makes the
	// @google/genai SDK throw "An unknown error occurred" *after* it has already
	// rendered the streamed text (the symptom for plain-text turns).
	finalParts := toolCallsToParts(toolAcc)
	if finalParts == nil {
		finalParts = []geminiPart{}
	}
	final := geminiResp{
		Candidates: []geminiCandidate{{
			Content:      geminiContent{Role: "model", Parts: finalParts},
			FinishReason: mapFinishReason(finishReason),
			Index:        0,
		}},
	}
	if usage != nil {
		final.UsageMetadata = &geminiUsage{
			PromptTokenCount:     usage.PromptTokens,
			CandidatesTokenCount: usage.CompletionTokens,
			TotalTokenCount:      usage.TotalTokens,
		}
	}
	emit(final)
}
