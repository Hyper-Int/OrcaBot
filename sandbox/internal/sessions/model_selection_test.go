package sessions

import (
	"strings"
	"testing"
)

func TestBuildCodexOpenRouterCommand(t *testing.T) {
	sel := &ModelSelection{
		Provider:        "openrouter",
		Model:           "deepseek/deepseek-chat",
		ContextWindow:   131072,
		MaxOutputTokens: 16000,
	}

	got := buildCodexOpenRouterCommand("codex", sel, "sess123", 8082)

	// Must keep the original token and append flags after it.
	if !strings.HasPrefix(got, "codex ") {
		t.Fatalf("expected command to start with the codex token, got %q", got)
	}
	for _, want := range []string{
		"--model 'deepseek/deepseek-chat'",
		`model_provider="openrouter"`,
		`model_providers.openrouter.base_url="http://localhost:8082/broker/sess123/openrouter"`,
		`model_providers.openrouter.env_key="OPENAI_API_KEY"`,
		`model_providers.openrouter.wire_api="responses"`,
		"model_context_window=131072",
		"model_max_output_tokens=16000",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rewritten command missing %q\n  full: %s", want, got)
		}
	}
}

func TestBuildCodexOpenRouterCommand_OmitsLimitsWhenUnknown(t *testing.T) {
	sel := &ModelSelection{Provider: "openrouter", Model: "x/y"} // no limits

	got := buildCodexOpenRouterCommand("codex", sel, "s", 8082)

	if strings.Contains(got, "model_context_window") || strings.Contains(got, "model_max_output_tokens") {
		t.Errorf("limit flags should be omitted when zero: %s", got)
	}
}

func TestBuildCodexOpenRouterCommand_PreservesUserArgs(t *testing.T) {
	sel := &ModelSelection{Provider: "openrouter", Model: "openai/gpt-4o"}

	got := buildCodexOpenRouterCommand("codex resume --foo", sel, "s", 8082)

	// Injected flags go right after `codex`; user args remain afterwards.
	if !strings.Contains(got, "resume --foo") {
		t.Errorf("user args dropped: %s", got)
	}
	if strings.Index(got, "--model") > strings.Index(got, "resume") {
		t.Errorf("expected injected flags before user args: %s", got)
	}
}

func TestBuildCodexOpenRouterCommand_NoopWhenDefault(t *testing.T) {
	// Default provider (or nil) must not alter the command.
	if got := buildCodexOpenRouterCommand("codex", &ModelSelection{Provider: "default"}, "s", 8082); got != "codex" {
		t.Errorf("default selection should be a no-op, got %q", got)
	}
	if got := buildCodexOpenRouterCommand("codex", nil, "s", 8082); got != "codex" {
		t.Errorf("nil selection should be a no-op, got %q", got)
	}
}
