package sessions

import (
	"strings"
	"testing"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
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

func TestApplyCustomEndpointEnv_OpenAINative(t *testing.T) {
	sel := &ModelSelection{Provider: "custom", Model: "llama3.3:70b", BaseURL: "https://my-llm.example.com/v1", Format: "openai"}
	for _, agent := range []mcp.AgentType{mcp.AgentTypeOpenCode, mcp.AgentTypeDroid} {
		env := map[string]string{}
		applyCustomEndpointEnv(env, agent, sel, "sess1", 8082, 8086)
		if env["OPENAI_BASE_URL"] != "http://localhost:8082/broker/sess1/customprovider" {
			t.Errorf("%s OPENAI_BASE_URL = %q", agent, env["OPENAI_BASE_URL"])
		}
		if env["OPENAI_MODEL"] != "llama3.3:70b" {
			t.Errorf("%s OPENAI_MODEL = %q", agent, env["OPENAI_MODEL"])
		}
		if env["OPENAI_API_KEY"] == "" {
			t.Errorf("%s should set a placeholder OPENAI_API_KEY", agent)
		}
	}
}

func TestApplyCustomEndpointEnv_Claude(t *testing.T) {
	sel := &ModelSelection{Provider: "custom", Model: "llama3.3:70b", BaseURL: "https://x/v1", Format: "openai"}
	env := map[string]string{}
	applyCustomEndpointEnv(env, mcp.AgentTypeClaude, sel, "sess1", 8082, 8086)
	// ANTHROPIC_BASE_URL points at the gateway /av1 with the customprovider ref.
	if !strings.Contains(env["ANTHROPIC_BASE_URL"], "/av1/sess1/customprovider/") {
		t.Errorf("ANTHROPIC_BASE_URL = %q", env["ANTHROPIC_BASE_URL"])
	}
	if !strings.HasPrefix(env["ANTHROPIC_API_KEY"], "sk-ant-") {
		t.Errorf("ANTHROPIC_API_KEY should be a valid-looking placeholder: %q", env["ANTHROPIC_API_KEY"])
	}
}

func TestApplyCustomEndpointEnv_NoopWhenNotCustom(t *testing.T) {
	env := map[string]string{}
	applyCustomEndpointEnv(env, mcp.AgentTypeOpenCode, &ModelSelection{Provider: "openrouter", Model: "x"}, "s", 8082, 8086)
	if len(env) != 0 {
		t.Errorf("non-custom selection should be a no-op, got %v", env)
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

func TestRewriteCustomBaseURLForDesktop(t *testing.T) {
	t.Setenv("ALLOW_HTTP_CUSTOM_ENDPOINT", "")
	if got := rewriteCustomBaseURLForDesktop("http://localhost:11434/v1"); got != "http://localhost:11434/v1" {
		t.Errorf("no flag = no-op, got %q", got)
	}
	t.Setenv("ALLOW_HTTP_CUSTOM_ENDPOINT", "true")
	if got := rewriteCustomBaseURLForDesktop("http://localhost:11434/v1"); got != "http://10.0.2.2:11434/v1" {
		t.Errorf("localhost should rewrite to host gateway, got %q", got)
	}
	if got := rewriteCustomBaseURLForDesktop("http://127.0.0.1:1234/v1"); got != "http://10.0.2.2:1234/v1" {
		t.Errorf("127.0.0.1 should rewrite, got %q", got)
	}
	// A real public host is left alone even with the flag.
	if got := rewriteCustomBaseURLForDesktop("https://my-llm.example.com/v1"); got != "https://my-llm.example.com/v1" {
		t.Errorf("public host must be untouched, got %q", got)
	}
	t.Setenv("ORCABOT_HOST_GATEWAY", "192.168.64.1")
	if got := rewriteCustomBaseURLForDesktop("http://localhost:11434/v1"); got != "http://192.168.64.1:11434/v1" {
		t.Errorf("custom gateway override not honored, got %q", got)
	}
}
