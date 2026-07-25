// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: model-gateway-v1-anthropic
//
// Anthropic Messages (Claude) ↔ OpenAI Chat Completions translation, sharing the
// same broker-forwarding core (forwardChat) and OpenAI types as the Gemini path.
// This is the second front-side format for the generalized model gateway
// (PLAN-custom-endpoints.md): it lets Claude Code target any OpenAI-compatible
// endpoint (OpenRouter today; custom/self-hosted next).
//
// Request URL shape (the harness's ANTHROPIC_BASE_URL points here; the SDK appends
// /v1/messages):
//
//	http://127.0.0.1:<port>/av1/{sessionID}/{provider}/{base64url(model)}
//
// PROTOTYPE SCOPE: text + tool-calling, streaming and non-streaming. count_tokens
// returns a char/4 estimate. The model id comes from the URL (the custom endpoint's
// model), overriding whatever the harness put in the body.

package geminishim

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
)

// ---- Anthropic wire types (request subset) ----

type anthReq struct {
	Model         string          `json:"model"`
	Messages      []anthMessage   `json:"messages"`
	System        json.RawMessage `json:"system,omitempty"` // string | []{type:"text",text}
	Tools         []anthTool      `json:"tools,omitempty"`
	MaxTokens     int             `json:"max_tokens,omitempty"`
	Temperature   *float64        `json:"temperature,omitempty"`
	TopP          *float64        `json:"top_p,omitempty"`
	StopSequences []string        `json:"stop_sequences,omitempty"`
	Stream        bool            `json:"stream,omitempty"`
}

type anthMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"` // string | []anthBlock
}

type anthBlock struct {
	Type string `json:"type"`
	// text
	Text string `json:"text,omitempty"`
	// tool_use
	ID    string         `json:"id,omitempty"`
	Name  string         `json:"name,omitempty"`
	Input map[string]any `json:"input,omitempty"`
	// tool_result
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"` // string | []block
}

type anthTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	InputSchema map[string]any `json:"input_schema,omitempty"`
}

// ---- Anthropic wire types (non-streaming response) ----

type anthResp struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"` // "message"
	Role       string         `json:"role"` // "assistant"
	Model      string         `json:"model"`
	Content    []anthOutBlock `json:"content"`
	StopReason string         `json:"stop_reason"`
	StopSeq    *string        `json:"stop_sequence"`
	Usage      anthUsage      `json:"usage"`
}

type anthOutBlock struct {
	Type  string         `json:"type"` // "text" | "tool_use"
	Text  string         `json:"text,omitempty"`
	ID    string         `json:"id,omitempty"`
	Name  string         `json:"name,omitempty"`
	Input map[string]any `json:"input,omitempty"`
}

type anthUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// parseAnthPath extracts sessionID, broker provider, and the decoded model from a
// path of the form /av1/{sessionID}/{provider}/{modelB64}/v1/messages[...].
func parseAnthPath(path string) (sessionID, provider, model string, ok bool) {
	rest := strings.TrimPrefix(path, "/av1/")
	if rest == path {
		return "", "", "", false
	}
	parts := strings.SplitN(rest, "/", 4)
	if len(parts) < 4 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", "", "", false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(decoded) == 0 {
		return "", "", "", false
	}
	return parts[0], parts[1], string(decoded), true
}

// serveAnthropic handles an Anthropic Messages request: translate → forward via
// broker → translate back.
func (s *Shim) serveAnthropic(w http.ResponseWriter, r *http.Request) {
	sessionID, provider, model, ok := parseAnthPath(r.URL.Path)
	if !ok {
		writeAnthropicError(w, http.StatusBadRequest, "invalid path; expected /av1/{session}/{provider}/{model}/v1/messages")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "failed to read request body")
		return
	}

	// count_tokens → estimate (no upstream support).
	if strings.Contains(r.URL.Path, "count_tokens") {
		handleAnthCountTokens(w, body)
		return
	}

	var areq anthReq
	if err := json.Unmarshal(body, &areq); err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid Anthropic request: "+err.Error())
		return
	}

	oreq := anthropicToOpenAI(areq, model)
	oreqBody, err := json.Marshal(oreq)
	if err != nil {
		writeAnthropicError(w, http.StatusInternalServerError, "failed to encode upstream request")
		return
	}
	log.Printf("[model-gateway] anthropic -> session=%s provider=%s model=%s stream=%t msgs=%d tools=%d",
		sessionID, provider, model, areq.Stream, len(oreq.Messages), len(oreq.Tools))

	resp, err := s.forwardChat(sessionID, provider, oreqBody)
	if err != nil {
		writeAnthropicError(w, http.StatusBadGateway, "broker request failed: "+err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		errBody, _ := io.ReadAll(resp.Body)
		log.Printf("[model-gateway] anthropic <- upstream HTTP %d session=%s body=%s", resp.StatusCode, sessionID, truncate(string(errBody), 2000))
		writeAnthropicError(w, resp.StatusCode, "upstream error: "+strings.TrimSpace(string(errBody)))
		return
	}

	if areq.Stream {
		streamOpenAIToAnthropic(w, resp.Body, model)
		return
	}

	respBody, _ := io.ReadAll(resp.Body)
	var oresp oaiResp
	if err := json.Unmarshal(respBody, &oresp); err != nil {
		writeAnthropicError(w, http.StatusBadGateway, "failed to parse upstream response")
		return
	}
	if oresp.Error != nil {
		writeAnthropicError(w, http.StatusBadGateway, "upstream error: "+oresp.Error.String())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(openAIToAnthropic(oresp, model))
}

// anthropicToOpenAI converts an Anthropic Messages request to OpenAI Chat Completions.
func anthropicToOpenAI(a anthReq, model string) oaiReq {
	out := oaiReq{Model: model, Stream: a.Stream}

	if sys := joinAnthSystem(a.System); sys != "" {
		out.Messages = append(out.Messages, oaiMsg{Role: "system", Content: sys})
	}

	for _, m := range a.Messages {
		blocks := parseAnthBlocks(m.Content)
		text := joinAnthText(blocks)
		switch m.Role {
		case "assistant":
			msg := oaiMsg{Role: "assistant", Content: text}
			for _, b := range blocks {
				if b.Type != "tool_use" {
					continue
				}
				args, _ := json.Marshal(b.Input)
				msg.ToolCalls = append(msg.ToolCalls, oaiToolCall{
					ID:       b.ID,
					Type:     "function",
					Function: oaiFuncCall{Name: b.Name, Arguments: string(args)},
				})
			}
			out.Messages = append(out.Messages, msg)
		default: // "user"
			var emittedToolResult bool
			for _, b := range blocks {
				if b.Type != "tool_result" {
					continue
				}
				emittedToolResult = true
				out.Messages = append(out.Messages, oaiMsg{
					Role:       "tool",
					ToolCallID: b.ToolUseID,
					Content:    joinAnthText(parseAnthBlocks(b.Content)),
				})
			}
			if text != "" || !emittedToolResult {
				out.Messages = append(out.Messages, oaiMsg{Role: "user", Content: text})
			}
		}
	}

	for _, t := range a.Tools {
		out.Tools = append(out.Tools, oaiTool{
			Type: "function",
			Function: oaiFuncDef{
				Name:        t.Name,
				Description: t.Description,
				Parameters:  sanitizeSchema(t.InputSchema),
			},
		})
	}

	if a.MaxTokens > 0 {
		mt := a.MaxTokens
		out.MaxTokens = &mt
	}
	out.Temperature = a.Temperature
	out.TopP = a.TopP
	out.Stop = a.StopSequences
	return out
}

// openAIToAnthropic converts a non-streaming OpenAI response to an Anthropic message.
func openAIToAnthropic(o oaiResp, model string) anthResp {
	out := anthResp{ID: "msg_orcabot", Type: "message", Role: "assistant", Model: model, StopReason: "end_turn"}
	if len(o.Choices) == 0 {
		out.Content = []anthOutBlock{{Type: "text", Text: ""}}
		return out
	}
	choice := o.Choices[0]
	if choice.Message.Content != "" {
		out.Content = append(out.Content, anthOutBlock{Type: "text", Text: choice.Message.Content})
	}
	for _, tc := range choice.Message.ToolCalls {
		input := map[string]any{}
		if tc.Function.Arguments != "" {
			_ = json.Unmarshal([]byte(tc.Function.Arguments), &input)
		}
		out.Content = append(out.Content, anthOutBlock{Type: "tool_use", ID: tc.ID, Name: tc.Function.Name, Input: input})
	}
	if len(out.Content) == 0 {
		out.Content = []anthOutBlock{{Type: "text", Text: ""}}
	}
	out.StopReason = mapAnthStopReason(choice.FinishReason)
	if o.Usage != nil {
		out.Usage = anthUsage{InputTokens: o.Usage.PromptTokens, OutputTokens: o.Usage.CompletionTokens}
	}
	return out
}

// streamOpenAIToAnthropic reads an OpenAI SSE stream and re-emits it as the
// Anthropic Messages event stream (message_start → content_block_* → message_delta
// → message_stop). Text streams as it arrives; tool calls are accumulated and
// emitted as tool_use blocks at the end.
func streamOpenAIToAnthropic(w http.ResponseWriter, body io.Reader, model string) {
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	emit := func(event string, payload any) {
		data, _ := json.Marshal(payload)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		if flusher != nil {
			flusher.Flush()
		}
	}

	emit("message_start", map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id": "msg_orcabot", "type": "message", "role": "assistant", "model": model,
			"content": []any{}, "stop_reason": nil, "stop_sequence": nil,
			"usage": map[string]int{"input_tokens": 0, "output_tokens": 0},
		},
	})

	reader := bufio.NewReader(body)
	finishReason := "stop"
	textOpen := false
	toolAcc := map[int]*oaiToolCall{}
	var usage *oaiUsage

	for {
		line, err := reader.ReadString('\n')
		if t := strings.TrimSpace(line); strings.HasPrefix(t, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(t, "data:"))
			if payload == "[DONE]" {
				break
			}
			var chunk oaiStreamChunk
			if json.Unmarshal([]byte(payload), &chunk) == nil && len(chunk.Choices) > 0 {
				if chunk.Usage != nil {
					usage = chunk.Usage
				}
				ch := chunk.Choices[0]
				if ch.FinishReason != "" {
					finishReason = ch.FinishReason
				}
				if ch.Delta.Content != "" {
					if !textOpen {
						emit("content_block_start", map[string]any{
							"type": "content_block_start", "index": 0,
							"content_block": map[string]any{"type": "text", "text": ""},
						})
						textOpen = true
					}
					emit("content_block_delta", map[string]any{
						"type": "content_block_delta", "index": 0,
						"delta": map[string]any{"type": "text_delta", "text": ch.Delta.Content},
					})
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
		if err != nil {
			break
		}
	}

	if textOpen {
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
	}
	// Emit accumulated tool calls as tool_use blocks (indices after the text block).
	idx := 1
	for _, tc := range sortedToolCalls(toolAcc) {
		emit("content_block_start", map[string]any{
			"type": "content_block_start", "index": idx,
			"content_block": map[string]any{"type": "tool_use", "id": tc.ID, "name": tc.Function.Name, "input": map[string]any{}},
		})
		emit("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": idx,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": tc.Function.Arguments},
		})
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": idx})
		idx++
	}

	outTokens := 0
	if usage != nil {
		outTokens = usage.CompletionTokens
	}
	emit("message_delta", map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": mapAnthStopReason(finishReason), "stop_sequence": nil},
		"usage": map[string]int{"output_tokens": outTokens},
	})
	emit("message_stop", map[string]any{"type": "message_stop"})
}

func handleAnthCountTokens(w http.ResponseWriter, body []byte) {
	var areq anthReq
	_ = json.Unmarshal(body, &areq)
	chars := len(joinAnthSystem(areq.System))
	for _, m := range areq.Messages {
		chars += len(joinAnthText(parseAnthBlocks(m.Content)))
	}
	est := chars / 4
	if est < 1 && chars > 0 {
		est = 1
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{"input_tokens": est})
}

// ---- helpers ----

func parseAnthBlocks(raw json.RawMessage) []anthBlock {
	if len(raw) == 0 {
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return []anthBlock{{Type: "text", Text: s}}
	}
	var blocks []anthBlock
	_ = json.Unmarshal(raw, &blocks)
	return blocks
}

func joinAnthText(blocks []anthBlock) string {
	var b strings.Builder
	for _, blk := range blocks {
		if blk.Type == "text" && blk.Text != "" {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(blk.Text)
		}
	}
	return b.String()
}

// joinAnthSystem handles the system field, which is a string or an array of text blocks.
func joinAnthSystem(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return joinAnthText(parseAnthBlocks(raw))
}

// sortedToolCalls returns accumulated streaming tool calls ordered by index.
func sortedToolCalls(acc map[int]*oaiToolCall) []oaiToolCall {
	idxs := make([]int, 0, len(acc))
	for i := range acc {
		idxs = append(idxs, i)
	}
	sort.Ints(idxs)
	out := make([]oaiToolCall, 0, len(idxs))
	for _, i := range idxs {
		out = append(out, *acc[i])
	}
	return out
}

func mapAnthStopReason(r string) string {
	switch r {
	case "length":
		return "max_tokens"
	case "tool_calls", "function_call":
		return "tool_use"
	case "stop", "":
		return "end_turn"
	default:
		return "end_turn"
	}
}

func writeAnthropicError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":  "error",
		"error": map[string]any{"type": "api_error", "message": message},
	})
}
