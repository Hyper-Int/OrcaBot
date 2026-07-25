// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package broker

import (
	"strings"
	"testing"
)

func TestClassifyProviderError(t *testing.T) {
	body429 := []byte(`{"error":{"message":"deepseek/deepseek-chat is temporarily rate-limited upstream","code":429}}`)
	title, msg, hint := classifyProviderError(429, body429)
	if !strings.Contains(strings.ToLower(title), "rate-limited") {
		t.Errorf("429 title = %q", title)
	}
	if !strings.Contains(msg, "deepseek") {
		t.Errorf("429 message should carry upstream text verbatim: %q", msg)
	}
	// 429 is NOT a credit problem — the fix is provider routing, not adding credits.
	if !strings.Contains(strings.ToLower(hint), "throughput") {
		t.Errorf("429 hint should point at provider routing/throughput: %q", hint)
	}
	if strings.Contains(strings.ToLower(hint), "add credits") {
		t.Errorf("429 hint must not suggest adding credits (misleading): %q", hint)
	}

	// Missing message → falls back to a sensible default, never empty.
	title, msg, hint = classifyProviderError(402, []byte(`{}`))
	if title == "" || msg == "" || hint == "" {
		t.Errorf("402 fields must be non-empty: title=%q msg=%q hint=%q", title, msg, hint)
	}

	title, _, _ = classifyProviderError(401, []byte(`{}`))
	if !strings.Contains(strings.ToLower(title), "key") {
		t.Errorf("401 title should mention key, got %q", title)
	}

	title, _, _ = classifyProviderError(503, []byte(`{}`))
	if !strings.Contains(strings.ToLower(title), "provider") {
		t.Errorf("503 title should mention provider, got %q", title)
	}
}

func TestIsModelRoutingProvider(t *testing.T) {
	for _, p := range []string{"openrouter", "openrouter-anthropic"} {
		if !isModelRoutingProvider(p) {
			t.Errorf("%q should be a model-routing provider", p)
		}
	}
	for _, p := range []string{"openai", "elevenlabs", "deepgram", "anthropic", ""} {
		if isModelRoutingProvider(p) {
			t.Errorf("%q should NOT trigger model-error toasts", p)
		}
	}
}

func TestHostAllowed_DesktopCustomHTTP(t *testing.T) {
	b := NewSecretsBroker(0)
	// A custom endpoint reachable over http via the desktop VM host gateway.
	b.SetConfig(ConfigKey("s1", "customprovider"), &ProviderConfig{
		Name: "customprovider", TargetBaseURL: "http://10.0.2.2:11434/v1", SessionID: "s1",
	})
	key := ConfigKey("s1", "customprovider")
	target := "http://10.0.2.2:11434/v1/chat/completions"

	t.Setenv("ALLOW_HTTP_CUSTOM_ENDPOINT", "")
	if b.hostAllowed(key, target) {
		t.Errorf("http custom endpoint must be blocked without the desktop flag")
	}
	t.Setenv("ALLOW_HTTP_CUSTOM_ENDPOINT", "true")
	if !b.hostAllowed(key, target) {
		t.Errorf("http custom endpoint should be allowed with the desktop flag")
	}
	// Host-match still enforced: a different http host is rejected even with the flag.
	if b.hostAllowed(key, "http://evil.example.com/v1/chat/completions") {
		t.Errorf("host-match must still reject a non-configured http host")
	}
}
