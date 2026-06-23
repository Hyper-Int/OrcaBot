// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package geminishim

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseAnthPath(t *testing.T) {
	b64 := base64.RawURLEncoding.EncodeToString([]byte("anthropic/claude-sonnet-4.6"))
	path := "/av1/sess1/openrouter/" + b64 + "/v1/messages"
	sid, prov, model, ok := parseAnthPath(path)
	if !ok || sid != "sess1" || prov != "openrouter" || model != "anthropic/claude-sonnet-4.6" {
		t.Fatalf("parseAnthPath = %q %q %q ok=%v", sid, prov, model, ok)
	}
}

func TestAnthropicToOpenAI_SystemTextTools(t *testing.T) {
	a := anthReq{
		System:   json.RawMessage(`"be terse"`),
		Messages: []anthMessage{{Role: "user", Content: json.RawMessage(`"hello"`)}},
		Tools: []anthTool{{
			Name: "get_weather", Description: "weather",
			InputSchema: map[string]any{"type": "OBJECT", "properties": map[string]any{"city": map[string]any{"type": "STRING"}}},
		}},
		MaxTokens: 256,
	}
	o := anthropicToOpenAI(a, "x/y")
	if o.Model != "x/y" {
		t.Errorf("model = %q", o.Model)
	}
	if len(o.Messages) != 2 || o.Messages[0].Role != "system" || o.Messages[1].Role != "user" {
		t.Fatalf("messages = %+v", o.Messages)
	}
	if o.Messages[0].Content != "be terse" || o.Messages[1].Content != "hello" {
		t.Errorf("content mapping wrong: %+v", o.Messages)
	}
	if len(o.Tools) != 1 || o.Tools[0].Function.Name != "get_weather" {
		t.Errorf("tools = %+v", o.Tools)
	}
	// Schema types must be lowercased (sanitizeSchema reused).
	props := o.Tools[0].Function.Parameters["properties"].(map[string]any)
	if props["city"].(map[string]any)["type"] != "string" {
		t.Errorf("schema not sanitized: %+v", o.Tools[0].Function.Parameters)
	}
	if o.MaxTokens == nil || *o.MaxTokens != 256 {
		t.Errorf("max_tokens not mapped: %+v", o.MaxTokens)
	}
}

func TestAnthropicToOpenAI_ToolRoundTrip(t *testing.T) {
	a := anthReq{Messages: []anthMessage{
		{Role: "assistant", Content: json.RawMessage(`[{"type":"tool_use","id":"call_1","name":"get_weather","input":{"city":"SF"}}]`)},
		{Role: "user", Content: json.RawMessage(`[{"type":"tool_result","tool_use_id":"call_1","content":"sunny"}]`)},
	}}
	o := anthropicToOpenAI(a, "x/y")
	// assistant tool_call then a tool message with the matching id.
	if len(o.Messages) != 2 {
		t.Fatalf("messages = %+v", o.Messages)
	}
	if o.Messages[0].Role != "assistant" || len(o.Messages[0].ToolCalls) != 1 || o.Messages[0].ToolCalls[0].ID != "call_1" {
		t.Errorf("assistant tool_call wrong: %+v", o.Messages[0])
	}
	if o.Messages[1].Role != "tool" || o.Messages[1].ToolCallID != "call_1" || o.Messages[1].Content != "sunny" {
		t.Errorf("tool result wrong: %+v", o.Messages[1])
	}
}

func TestOpenAIToAnthropic_TextAndUsage(t *testing.T) {
	var o oaiResp
	_ = json.Unmarshal([]byte(`{"choices":[{"message":{"content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`), &o)
	a := openAIToAnthropic(o, "x/y")
	if a.Type != "message" || a.Role != "assistant" || a.Model != "x/y" {
		t.Errorf("envelope wrong: %+v", a)
	}
	if len(a.Content) != 1 || a.Content[0].Type != "text" || a.Content[0].Text != "hi" {
		t.Errorf("content wrong: %+v", a.Content)
	}
	if a.StopReason != "end_turn" || a.Usage.InputTokens != 3 || a.Usage.OutputTokens != 2 {
		t.Errorf("stop/usage wrong: %+v", a)
	}
}

func TestServeAnthropic_NonStreaming(t *testing.T) {
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/broker/sid/openrouter/chat/completions") {
			t.Errorf("bad broker path: %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"hello there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}`)
	}))
	defer broker.Close()

	rec := callAnth(New(0, brokerPortFromURL(t, broker.URL)), "x/y", `{"model":"ignored","messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var a anthResp
	if err := json.Unmarshal(rec.Body.Bytes(), &a); err != nil {
		t.Fatalf("bad anthropic json: %v (%s)", err, rec.Body.String())
	}
	if a.Content[0].Text != "hello there" || a.StopReason != "end_turn" {
		t.Errorf("translated response wrong: %+v", a)
	}
}

func TestServeAnthropic_Streaming(t *testing.T) {
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fl, _ := w.(http.Flusher)
		for _, c := range []string{
			`{"choices":[{"delta":{"content":"Hel"}}]}`,
			`{"choices":[{"delta":{"content":"lo"}}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`,
		} {
			_, _ = io.WriteString(w, "data: "+c+"\n\n")
			if fl != nil {
				fl.Flush()
			}
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer broker.Close()

	rec := callAnth(New(0, brokerPortFromURL(t, broker.URL)), "x/y", `{"stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	body := rec.Body.String()
	for _, want := range []string{
		"event: message_start",
		"text_delta",
		`"text":"Hel"`,
		`"text":"lo"`,
		"event: message_delta",
		"event: message_stop",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("stream missing %q\n%s", want, body)
		}
	}
	if strings.Contains(body, "[DONE]") {
		t.Errorf("must not forward [DONE]: %s", body)
	}
}

func callAnth(s *Shim, model, body string) *httptest.ResponseRecorder {
	b64 := base64.RawURLEncoding.EncodeToString([]byte(model))
	req := httptest.NewRequest(http.MethodPost, "/av1/sid/openrouter/"+b64+"/v1/messages", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}
