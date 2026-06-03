// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package geminishim

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestParsePath(t *testing.T) {
	model := "deepseek/deepseek-chat"
	b64 := base64.RawURLEncoding.EncodeToString([]byte(model))
	path := "/gv1/sess123/" + b64 + "/v1beta/models/gemini-2.5-pro:streamGenerateContent"

	sid, gotModel, method, ok := parsePath(path)
	if !ok {
		t.Fatalf("parsePath failed for %q", path)
	}
	if sid != "sess123" {
		t.Errorf("sid = %q, want sess123", sid)
	}
	if gotModel != model {
		t.Errorf("model = %q, want %q", gotModel, model)
	}
	if method != "streamGenerateContent" {
		t.Errorf("method = %q, want streamGenerateContent", method)
	}
}

func TestGeminiToOpenAI_TextSystemAndTools(t *testing.T) {
	g := genReq{
		SystemInstruction: &genContent{Parts: []genPart{{Text: "be terse"}}},
		Contents: []genContent{
			{Role: "user", Parts: []genPart{{Text: "hello"}}},
		},
		Tools: []genTool{{FunctionDeclarations: []genFuncDecl{
			{Name: "get_weather", Description: "weather", Parameters: map[string]any{"type": "object"}},
		}}},
		GenerationConfig: &genGenConfig{MaxOutputTokens: intPtr(256)},
	}
	o := geminiToOpenAI(g, "openai/gpt-4o", true)

	if o.Model != "openai/gpt-4o" || !o.Stream {
		t.Fatalf("model/stream wrong: %+v", o)
	}
	if len(o.Messages) != 2 || o.Messages[0].Role != "system" || o.Messages[1].Role != "user" {
		t.Fatalf("messages wrong: %+v", o.Messages)
	}
	if o.Messages[0].Content != "be terse" || o.Messages[1].Content != "hello" {
		t.Errorf("content mapping wrong: %+v", o.Messages)
	}
	if len(o.Tools) != 1 || o.Tools[0].Function.Name != "get_weather" || o.Tools[0].Type != "function" {
		t.Errorf("tools mapping wrong: %+v", o.Tools)
	}
	if o.MaxTokens == nil || *o.MaxTokens != 256 {
		t.Errorf("max_tokens not mapped: %+v", o.MaxTokens)
	}
}

func TestHandleGenerate_NonStreaming(t *testing.T) {
	// Fake broker asserts it received OpenAI format, returns an OpenAI response.
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/broker/sid/openrouter/chat/completions") {
			t.Errorf("unexpected broker path: %s", r.URL.Path)
		}
		var req oaiReq
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.Model != "x/y" {
			t.Errorf("model not forwarded: %q", req.Model)
		}
		_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"hi there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`)
	}))
	defer broker.Close()

	shim := New(0, brokerPortFromURL(t, broker.URL))
	rec := callShim(shim, "x/y", "generateContent", `{"contents":[{"role":"user","parts":[{"text":"hey"}]}]}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp geminiResp
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad gemini json: %v (%s)", err, rec.Body.String())
	}
	if len(resp.Candidates) != 1 || resp.Candidates[0].Content.Parts[0].Text != "hi there" {
		t.Errorf("text not translated back: %+v", resp.Candidates)
	}
	if resp.Candidates[0].FinishReason != "STOP" {
		t.Errorf("finishReason = %q, want STOP", resp.Candidates[0].FinishReason)
	}
	if resp.UsageMetadata == nil || resp.UsageMetadata.TotalTokenCount != 5 {
		t.Errorf("usage not translated: %+v", resp.UsageMetadata)
	}
}

func TestHandleGenerate_Streaming(t *testing.T) {
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fl, _ := w.(http.Flusher)
		for _, chunk := range []string{
			`{"choices":[{"delta":{"content":"Hel"}}]}`,
			`{"choices":[{"delta":{"content":"lo"}}]}`,
			`{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
		} {
			_, _ = io.WriteString(w, "data: "+chunk+"\n\n")
			if fl != nil {
				fl.Flush()
			}
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer broker.Close()

	shim := New(0, brokerPortFromURL(t, broker.URL))
	rec := callShim(shim, "x/y", "streamGenerateContent", `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	// Expect Gemini-format SSE chunks carrying the text deltas, and no [DONE].
	if !strings.Contains(body, `"text":"Hel"`) || !strings.Contains(body, `"text":"lo"`) {
		t.Errorf("text deltas missing from stream:\n%s", body)
	}
	if strings.Contains(body, "[DONE]") {
		t.Errorf("must not forward OpenAI [DONE] sentinel:\n%s", body)
	}
	if !strings.Contains(body, `"finishReason":"STOP"`) {
		t.Errorf("final chunk missing finishReason:\n%s", body)
	}
	// A null parts array makes the @google/genai SDK throw "unknown error" after
	// rendering — the final chunk must serialize parts as [] for plain-text turns.
	if strings.Contains(body, `"parts":null`) {
		t.Errorf("stream emitted parts:null (breaks the SDK):\n%s", body)
	}
}

func TestGeminiToOpenAI_JSONResponseFormat(t *testing.T) {
	g := genReq{
		Contents:         []genContent{{Role: "user", Parts: []genPart{{Text: "decide"}}}},
		GenerationConfig: &genGenConfig{ResponseMimeType: "application/json"},
	}
	o := geminiToOpenAI(g, "x/y", false)
	if o.ResponseFormat == nil || o.ResponseFormat["type"] != "json_object" {
		t.Errorf("responseMimeType not mapped to response_format: %+v", o.ResponseFormat)
	}
}

func TestSanitizeSchema_LowercasesTypesAndDropsGeminiKeys(t *testing.T) {
	in := map[string]any{
		"type": "OBJECT",
		"properties": map[string]any{
			"city": map[string]any{"type": "STRING", "nullable": true, "title": "City"},
			"tags": map[string]any{"type": "ARRAY", "items": map[string]any{"type": "STRING"}},
		},
	}
	out := sanitizeSchema(in)
	if out["type"] != "object" {
		t.Errorf("top type = %v, want object", out["type"])
	}
	props := out["properties"].(map[string]any)
	city := props["city"].(map[string]any)
	if city["type"] != "string" {
		t.Errorf("city type = %v, want string", city["type"])
	}
	if _, ok := city["nullable"]; ok {
		t.Errorf("nullable should be dropped")
	}
	if _, ok := city["title"]; ok {
		t.Errorf("title should be dropped")
	}
	tags := props["tags"].(map[string]any)
	items := tags["items"].(map[string]any)
	if items["type"] != "string" {
		t.Errorf("items type = %v, want string", items["type"])
	}
}

func TestUnsupportedMethods(t *testing.T) {
	shim := New(0, 9)
	rec := callShim(shim, "x/y", "embedContent", `{}`)
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("embedContent status = %d, want 501", rec.Code)
	}
}

// --- helpers ---

func intPtr(i int) *int { return &i }

func brokerPortFromURL(t *testing.T, raw string) int {
	t.Helper()
	_, port, ok := strings.Cut(strings.TrimPrefix(raw, "http://"), ":")
	if !ok {
		t.Fatalf("cannot parse port from %q", raw)
	}
	p, err := strconv.Atoi(port)
	if err != nil {
		t.Fatalf("bad port %q: %v", port, err)
	}
	return p
}

func callShim(s *Shim, model, method, body string) *httptest.ResponseRecorder {
	b64 := base64.RawURLEncoding.EncodeToString([]byte(model))
	path := "/gv1/sid/" + b64 + "/v1beta/models/gemini-x:" + method
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}
