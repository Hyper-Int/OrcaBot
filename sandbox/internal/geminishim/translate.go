// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: gemini-shim-v1-openrouter-bridge

package geminishim

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

// ---- Gemini wire types (request subset) ----

type genReq struct {
	Contents          []genContent  `json:"contents"`
	SystemInstruction *genContent   `json:"systemInstruction,omitempty"`
	Tools             []genTool     `json:"tools,omitempty"`
	GenerationConfig  *genGenConfig `json:"generationConfig,omitempty"`
}

type genContent struct {
	Role  string    `json:"role,omitempty"`
	Parts []genPart `json:"parts,omitempty"`
}

type genPart struct {
	Text             string               `json:"text,omitempty"`
	FunctionCall     *genFunctionCall     `json:"functionCall,omitempty"`
	FunctionResponse *genFunctionResponse `json:"functionResponse,omitempty"`
}

type genFunctionCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args,omitempty"`
}

type genFunctionResponse struct {
	Name     string         `json:"name"`
	Response map[string]any `json:"response,omitempty"`
}

type genTool struct {
	FunctionDeclarations []genFuncDecl `json:"functionDeclarations,omitempty"`
}

type genFuncDecl struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type genGenConfig struct {
	Temperature      *float64 `json:"temperature,omitempty"`
	TopP             *float64 `json:"topP,omitempty"`
	MaxOutputTokens  *int     `json:"maxOutputTokens,omitempty"`
	StopSequences    []string `json:"stopSequences,omitempty"`
	ResponseMimeType string   `json:"responseMimeType,omitempty"`
}

// ---- Gemini wire types (response subset) ----

type geminiResp struct {
	Candidates    []geminiCandidate `json:"candidates"`
	UsageMetadata *geminiUsage      `json:"usageMetadata,omitempty"`
}

type geminiCandidate struct {
	Content      geminiContent `json:"content"`
	FinishReason string        `json:"finishReason,omitempty"`
	Index        int           `json:"index"`
}

type geminiContent struct {
	Role  string       `json:"role"`
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text         string           `json:"text,omitempty"`
	FunctionCall *genFunctionCall `json:"functionCall,omitempty"`
}

type geminiUsage struct {
	PromptTokenCount     int `json:"promptTokenCount"`
	CandidatesTokenCount int `json:"candidatesTokenCount"`
	TotalTokenCount      int `json:"totalTokenCount"`
}

// ---- OpenAI wire types ----

type oaiReq struct {
	Model          string         `json:"model"`
	Messages       []oaiMsg       `json:"messages"`
	Tools          []oaiTool      `json:"tools,omitempty"`
	Temperature    *float64       `json:"temperature,omitempty"`
	TopP           *float64       `json:"top_p,omitempty"`
	MaxTokens      *int           `json:"max_tokens,omitempty"`
	Stop           []string       `json:"stop,omitempty"`
	Stream         bool           `json:"stream,omitempty"`
	ResponseFormat map[string]any `json:"response_format,omitempty"`
}

type oaiMsg struct {
	Role       string        `json:"role"`
	Content    string        `json:"content,omitempty"`
	ToolCalls  []oaiToolCall `json:"tool_calls,omitempty"`
	ToolCallID string        `json:"tool_call_id,omitempty"`
}

type oaiToolCall struct {
	Index    int         `json:"index,omitempty"`
	ID       string      `json:"id,omitempty"`
	Type     string      `json:"type,omitempty"`
	Function oaiFuncCall `json:"function"`
}

type oaiFuncCall struct {
	Name      string `json:"name,omitempty"`
	Arguments string `json:"arguments,omitempty"` // JSON-encoded string
}

type oaiTool struct {
	Type     string     `json:"type"`
	Function oaiFuncDef `json:"function"`
}

type oaiFuncDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

type oaiError struct {
	Message string `json:"message"`
	Type    string `json:"type,omitempty"`
	Code    any    `json:"code,omitempty"`
}

func (e *oaiError) String() string {
	if e == nil {
		return ""
	}
	if e.Type != "" {
		return fmt.Sprintf("%s: %s", e.Type, e.Message)
	}
	return e.Message
}

type oaiResp struct {
	Choices []struct {
		Message struct {
			Content   string        `json:"content"`
			ToolCalls []oaiToolCall `json:"tool_calls"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *oaiUsage `json:"usage"`
	Error *oaiError `json:"error,omitempty"`
}

type oaiUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type oaiStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content   string        `json:"content"`
			ToolCalls []oaiToolCall `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *oaiUsage `json:"usage"`
	Error *oaiError `json:"error,omitempty"`
}

// geminiToOpenAI converts a Gemini generate request into an OpenAI Chat
// Completions request for the given OpenRouter model.
func geminiToOpenAI(g genReq, model string, stream bool) oaiReq {
	out := oaiReq{Model: model, Stream: stream}

	if g.SystemInstruction != nil {
		if sys := joinTextParts(g.SystemInstruction.Parts); sys != "" {
			out.Messages = append(out.Messages, oaiMsg{Role: "system", Content: sys})
		}
	}

	// Tracks the last synthesized tool-call id per function name so a later
	// functionResponse can reference it. Best-effort — Gemini doesn't carry ids.
	lastCallID := map[string]string{}
	callSeq := 0

	for _, c := range g.Contents {
		text := joinTextParts(c.Parts)
		switch c.Role {
		case "model":
			msg := oaiMsg{Role: "assistant", Content: text}
			for _, p := range c.Parts {
				if p.FunctionCall == nil {
					continue
				}
				callSeq++
				id := fmt.Sprintf("call_%d", callSeq)
				lastCallID[p.FunctionCall.Name] = id
				args, _ := json.Marshal(p.FunctionCall.Args)
				msg.ToolCalls = append(msg.ToolCalls, oaiToolCall{
					ID:       id,
					Type:     "function",
					Function: oaiFuncCall{Name: p.FunctionCall.Name, Arguments: string(args)},
				})
			}
			out.Messages = append(out.Messages, msg)
		default: // "user" / "function" / unset
			var emittedToolResult bool
			for _, p := range c.Parts {
				if p.FunctionResponse == nil {
					continue
				}
				emittedToolResult = true
				resp, _ := json.Marshal(p.FunctionResponse.Response)
				out.Messages = append(out.Messages, oaiMsg{
					Role:       "tool",
					ToolCallID: lastCallID[p.FunctionResponse.Name],
					Content:    string(resp),
				})
			}
			if text != "" || !emittedToolResult {
				out.Messages = append(out.Messages, oaiMsg{Role: "user", Content: text})
			}
		}
	}

	for _, t := range g.Tools {
		for _, fd := range t.FunctionDeclarations {
			out.Tools = append(out.Tools, oaiTool{
				Type: "function",
				Function: oaiFuncDef{
					Name:        fd.Name,
					Description: fd.Description,
					// Gemini schemas use uppercase type enums ("OBJECT","STRING")
					// and a few Gemini-only keys; OpenAI/OpenRouter expect JSON
					// Schema (lowercase types). Normalize before forwarding.
					Parameters: sanitizeSchema(fd.Parameters),
				},
			})
		}
	}

	if cfg := g.GenerationConfig; cfg != nil {
		out.Temperature = cfg.Temperature
		out.TopP = cfg.TopP
		out.MaxTokens = cfg.MaxOutputTokens
		out.Stop = cfg.StopSequences
		// The Gemini CLI requests JSON for internal checks (e.g. the next-speaker
		// decision). Map to OpenAI response_format so the model returns valid JSON
		// instead of prose, which the CLI would fail to parse.
		if strings.EqualFold(cfg.ResponseMimeType, "application/json") {
			out.ResponseFormat = map[string]any{"type": "json_object"}
		}
	}

	return out
}

// openAIToGemini converts a non-streaming OpenAI response into a Gemini response.
func openAIToGemini(o oaiResp) geminiResp {
	out := geminiResp{}
	if len(o.Choices) == 0 {
		out.Candidates = []geminiCandidate{{
			Content:      geminiContent{Role: "model", Parts: []geminiPart{{Text: ""}}},
			FinishReason: "STOP",
		}}
		return out
	}
	choice := o.Choices[0]
	var parts []geminiPart
	if choice.Message.Content != "" {
		parts = append(parts, geminiPart{Text: choice.Message.Content})
	}
	for _, tc := range choice.Message.ToolCalls {
		parts = append(parts, toolCallToPart(tc))
	}
	if len(parts) == 0 {
		parts = []geminiPart{{Text: ""}}
	}
	out.Candidates = []geminiCandidate{{
		Content:      geminiContent{Role: "model", Parts: parts},
		FinishReason: mapFinishReason(choice.FinishReason),
		Index:        0,
	}}
	if o.Usage != nil {
		out.UsageMetadata = &geminiUsage{
			PromptTokenCount:     o.Usage.PromptTokens,
			CandidatesTokenCount: o.Usage.CompletionTokens,
			TotalTokenCount:      o.Usage.TotalTokens,
		}
	}
	return out
}

// geminiTextChunk builds a streaming Gemini chunk carrying a text delta.
func geminiTextChunk(text string) geminiResp {
	return geminiResp{Candidates: []geminiCandidate{{
		Content: geminiContent{Role: "model", Parts: []geminiPart{{Text: text}}},
		Index:   0,
	}}}
}

// toolCallsToParts converts accumulated streaming tool calls (keyed by index)
// into Gemini functionCall parts, ordered by index.
func toolCallsToParts(acc map[int]*oaiToolCall) []geminiPart {
	if len(acc) == 0 {
		return nil
	}
	idxs := make([]int, 0, len(acc))
	for i := range acc {
		idxs = append(idxs, i)
	}
	sort.Ints(idxs)
	parts := make([]geminiPart, 0, len(idxs))
	for _, i := range idxs {
		parts = append(parts, toolCallToPart(*acc[i]))
	}
	return parts
}

func toolCallToPart(tc oaiToolCall) geminiPart {
	args := map[string]any{}
	if tc.Function.Arguments != "" {
		_ = json.Unmarshal([]byte(tc.Function.Arguments), &args)
	}
	return geminiPart{FunctionCall: &genFunctionCall{Name: tc.Function.Name, Args: args}}
}

// mapFinishReason maps OpenAI finish reasons to Gemini's enum.
func mapFinishReason(r string) string {
	switch r {
	case "stop", "":
		return "STOP"
	case "length":
		return "MAX_TOKENS"
	case "content_filter":
		return "SAFETY"
	case "tool_calls", "function_call":
		return "STOP"
	default:
		return "STOP"
	}
}

// sanitizeSchema converts a Gemini parameter schema into JSON Schema that
// OpenAI-compatible APIs accept: lowercases "type" enum values (OBJECT→object),
// drops Gemini-only keys that OpenAI rejects, and recurses into nested schemas.
func sanitizeSchema(v map[string]any) map[string]any {
	if v == nil {
		return nil
	}
	out := make(map[string]any, len(v))
	for k, val := range v {
		switch k {
		// Gemini-only fields that OpenAI's stricter validators reject.
		case "nullable", "example", "title":
			continue
		case "type":
			if s, ok := val.(string); ok {
				out[k] = strings.ToLower(s)
			} else {
				out[k] = val
			}
		case "properties":
			if props, ok := val.(map[string]any); ok {
				np := make(map[string]any, len(props))
				for pk, pv := range props {
					np[pk] = sanitizeAny(pv)
				}
				out[k] = np
			} else {
				out[k] = val
			}
		case "items":
			out[k] = sanitizeAny(val)
		default:
			out[k] = sanitizeAny(val)
		}
	}
	return out
}

// sanitizeAny applies sanitizeSchema to nested maps and slices of maps.
func sanitizeAny(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return sanitizeSchema(t)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = sanitizeAny(e)
		}
		return out
	default:
		return v
	}
}

func joinTextParts(parts []genPart) string {
	var b strings.Builder
	for _, p := range parts {
		if p.Text != "" {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// writeGeminiError writes an error in the Gemini API's error envelope.
func writeGeminiError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"code":    code,
			"message": message,
			"status":  http.StatusText(code),
		},
	})
}
