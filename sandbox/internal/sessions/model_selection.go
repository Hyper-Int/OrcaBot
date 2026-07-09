// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: model-selection-v5-codex-responses

package sessions

import (
	"encoding/base64"
	"fmt"
	"log"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/broker"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
)

const modelSelectionRevision = "model-selection-v5-codex-responses"

func init() {
	log.Printf("[model-selection] REVISION: %s loaded at %s", modelSelectionRevision, time.Now().Format(time.RFC3339))
}

// ModelSelection describes a per-PTY override for the model/provider the harness should use.
// provider="default" means the harness uses its built-in API. provider="openrouter" routes
// requests through the local broker to OpenRouter. provider="custom" routes through the local
// broker to a user-configured OpenAI-compatible endpoint (PLAN-custom-endpoints.md).
type ModelSelection struct {
	Provider string // "default" | "openrouter" | "custom"
	Model    string // OpenRouter / custom-endpoint model id
	// Catalog-resolved limits (0 = unknown). Used to set Codex's
	// model_context_window / model_max_output_tokens so it doesn't fall back to
	// wrong defaults for models it doesn't recognize.
	ContextWindow   int
	MaxOutputTokens int
	// Custom endpoint fields (Provider == "custom").
	BaseURL    string // user endpoint base URL, e.g. https://my-llm.example.com/v1
	Format     string // "openai" | "anthropic" (front-side the harness speaks)
	SecretName string // name of the brokered secret holding the API key (empty = no auth)
}

// IsCustom returns true if the selection routes to a user-configured custom endpoint.
func (m *ModelSelection) IsCustom() bool {
	return m != nil && m.Provider == "custom" && m.Model != "" && m.BaseURL != ""
}

// IsOpenRouter returns true if the selection requests routing through OpenRouter.
func (m *ModelSelection) IsOpenRouter() bool {
	return m != nil && m.Provider == "openrouter" && m.Model != ""
}

// applyOpenRouterEnv injects the per-harness env vars needed for the agent to route
// requests through the local broker to OpenRouter.
//
// Compatibility:
//   - Codex / OpenCode / Droid: OpenAI-compatible endpoint via OPENAI_BASE_URL
//     pointing at the "openrouter" broker entry (target https://openrouter.ai/api/v1).
//   - Claude Code: Anthropic-compatible endpoint via ANTHROPIC_BASE_URL pointing at
//     the sibling "openrouter-anthropic" broker entry (target https://openrouter.ai/api,
//     no /v1 — the Anthropic SDK appends /v1/messages itself). The broker rewrites
//     the auth header to Bearer <OPENROUTER_API_KEY>; the model id is written into
//     .claude/settings.local.json by SetClaudeModelForOpenRouter in session.go.
//   - Gemini CLI: routed via the local geminishim translation proxy
//     (GOOGLE_GEMINI_BASE_URL → shim → broker → OpenRouter). The shim converts the
//     Gemini wire format to OpenAI Chat Completions. geminiShimPort=0 disables it.
//
// brokerPort comes from Session.BrokerPort(); geminiShimPort from
// Session.GeminiShimPort(). sessionID scopes the broker config.
func applyOpenRouterEnv(envVars map[string]string, agentType mcp.AgentType, sel *ModelSelection, sessionID string, brokerPort, geminiShimPort int) {
	if !sel.IsOpenRouter() {
		return
	}
	brokerURL := fmt.Sprintf("http://localhost:%d/broker/%s/openrouter", brokerPort, sessionID)

	switch agentType {
	case mcp.AgentTypeCodex, mcp.AgentTypeOpenCode, mcp.AgentTypeDroid:
		// OpenAI-compatible SDKs append /chat/completions to the base; the broker
		// strips /broker/{sid}/openrouter and forwards to OpenRouter's /api/v1.
		//
		// NOTE: the modern (Rust) Codex CLI ignores OPENAI_BASE_URL / OPENAI_MODEL —
		// it reads the model from --model and the provider from config. For Codex the
		// actual routing is injected onto the launch command by
		// buildCodexOpenRouterCommand (called from CreatePTYWithOptions). These env
		// vars remain for OpenCode / Droid, which do honor the OpenAI-compatible vars.
		envVars["OPENAI_BASE_URL"] = brokerURL
		envVars["OPENAI_MODEL"] = sel.Model
		// OpenAI-compatible clients refuse to construct/send a request without a
		// non-empty API key, so the request would never reach the broker. Set a
		// placeholder; the broker strips it and injects the real OpenRouter
		// Bearer token (mirrors the ANTHROPIC_API_KEY placeholder below, and the
		// dummy OPENAI_API_KEY the default Codex flow sets in env.go). Codex's
		// -c env_key="OPENAI_API_KEY" override (below) reads this same placeholder.
		envVars["OPENAI_API_KEY"] = broker.GetDummyValue("openai")
		log.Printf("[model-selection] agent=%s routing via OpenRouter model=%s broker=%s", agentType, sel.Model, brokerURL)
	case mcp.AgentTypeClaude:
		anthropicBroker := fmt.Sprintf("http://localhost:%d/broker/%s/openrouter-anthropic", brokerPort, sessionID)
		envVars["ANTHROPIC_BASE_URL"] = anthropicBroker
		// Claude Code only enters API mode (honoring ANTHROPIC_BASE_URL) when
		// ANTHROPIC_API_KEY looks like a real key — the human-readable "[BROKERED]"
		// placeholder is rejected, which forces the user to paste a real Anthropic
		// key for no reason. Use a syntactically-valid placeholder instead: the
		// broker strips the outbound x-api-key header and injects the real
		// OPENROUTER_API_KEY, so this value is never actually sent anywhere.
		envVars["ANTHROPIC_API_KEY"] = "sk-ant-api03-orcabot-openrouter-brokered-placeholder"
		log.Printf("[model-selection] agent=claude routing via OpenRouter model=%s broker=%s", sel.Model, anthropicBroker)
	case mcp.AgentTypeGemini:
		// The Gemini CLI's GATEWAY auth (GOOGLE_GEMINI_BASE_URL) speaks the Gemini
		// wire format, which OpenRouter doesn't serve. Point it at the local shim,
		// which translates to OpenAI Chat Completions and forwards via the broker.
		if geminiShimPort <= 0 {
			log.Printf("[model-selection] agent=gemini OpenRouter shim unavailable (port=0)")
			return
		}
		modelB64 := base64.RawURLEncoding.EncodeToString([]byte(sel.Model))
		shimURL := fmt.Sprintf("http://127.0.0.1:%d/gv1/%s/openrouter/%s", geminiShimPort, sessionID, modelB64)
		envVars["GOOGLE_GEMINI_BASE_URL"] = shimURL
		// GATEWAY mode reads GEMINI_API_KEY; a placeholder is enough — the broker
		// injects the real OpenRouter key downstream of the shim.
		envVars["GEMINI_API_KEY"] = broker.GetDummyValue("gemini")
		log.Printf("[model-selection] agent=gemini routing via OpenRouter shim model=%s url=%s", sel.Model, shimURL)
	default:
		log.Printf("[model-selection] agent=%s OpenRouter routing not supported", agentType)
	}
}

// customProviderName is the broker provider key for a session's custom endpoint.
// The broker config (target URL + key) is installed in session.go; the broker's
// built-in forwarding path handles /broker/{sid}/customprovider/... generically.
const customProviderName = "customprovider"

// applyCustomEndpointEnv wires a harness to a user-configured custom endpoint via
// the broker's customprovider config. OpenAI-native harnesses point straight at the
// broker; Claude goes through the gateway's /av1 Anthropic→chat translator. Codex
// (Responses→chat) and Gemini custom routing are not wired yet.
func applyCustomEndpointEnv(envVars map[string]string, agentType mcp.AgentType, sel *ModelSelection, sessionID string, brokerPort, geminiShimPort int) {
	if !sel.IsCustom() {
		return
	}
	// 127.0.0.1, NOT localhost: the broker binds IPv4 only, and Node/undici (opencode,
	// droid) resolves "localhost" to IPv6 ::1 first — which the broker never answers —
	// causing a multi-minute retry-storm "hang". Same fix as env.go's broker URLs.
	brokerURL := fmt.Sprintf("http://127.0.0.1:%d/broker/%s/%s", brokerPort, sessionID, customProviderName)
	switch agentType {
	case mcp.AgentTypeOpenCode, mcp.AgentTypeDroid:
		envVars["OPENAI_BASE_URL"] = brokerURL
		envVars["OPENAI_MODEL"] = sel.Model
		envVars["OPENAI_API_KEY"] = broker.GetDummyValue("openai")
		log.Printf("[model-selection] agent=%s routing via custom endpoint model=%s broker=%s", agentType, sel.Model, brokerURL)
	case mcp.AgentTypeClaude:
		modelB64 := base64.RawURLEncoding.EncodeToString([]byte(sel.Model))
		shimURL := fmt.Sprintf("http://127.0.0.1:%d/av1/%s/%s/%s", geminiShimPort, sessionID, customProviderName, modelB64)
		envVars["ANTHROPIC_BASE_URL"] = shimURL
		// Valid-looking placeholder so Claude enters API mode; the broker injects
		// the real key (if any). See [[claude-openrouter-auth-friction]].
		envVars["ANTHROPIC_API_KEY"] = "sk-ant-api03-orcabot-custom-endpoint-placeholder"
		log.Printf("[model-selection] agent=claude routing via custom endpoint model=%s url=%s", sel.Model, shimURL)
	case mcp.AgentTypeGemini:
		modelB64 := base64.RawURLEncoding.EncodeToString([]byte(sel.Model))
		shimURL := fmt.Sprintf("http://127.0.0.1:%d/gv1/%s/%s/%s", geminiShimPort, sessionID, customProviderName, modelB64)
		envVars["GOOGLE_GEMINI_BASE_URL"] = shimURL
		// GATEWAY auth flag (security.auth.selectedType/useExternal) is written in
		// session.go for both OpenRouter and custom Gemini selections.
		envVars["GEMINI_API_KEY"] = broker.GetDummyValue("gemini")
		log.Printf("[model-selection] agent=gemini routing via custom endpoint model=%s url=%s", sel.Model, shimURL)
	default:
		log.Printf("[model-selection] agent=%s custom endpoint routing not supported yet", agentType)
	}
}

// hostGatewayAddr is the address the sandbox VM uses to reach the host (for desktop
// local model servers). QEMU user-net / slirp maps the host to 10.0.2.2; overridable.
func hostGatewayAddr() string {
	if g := os.Getenv("ORCABOT_HOST_GATEWAY"); g != "" {
		return g
	}
	return "10.0.2.2"
}

// rewriteCustomBaseURLForDesktop rewrites a localhost custom-endpoint URL to the VM
// host gateway so the sandbox can reach a model server (Ollama/LM Studio) running on
// the host. Desktop-only — gated on ALLOW_HTTP_CUSTOM_ENDPOINT; no-op otherwise, so
// cloud endpoints (real public hosts) are untouched.
func rewriteCustomBaseURLForDesktop(baseURL string) string {
	if os.Getenv("ALLOW_HTTP_CUSTOM_ENDPOINT") != "true" {
		return baseURL
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return baseURL
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		gw := hostGatewayAddr()
		if port := u.Port(); port != "" {
			u.Host = gw + ":" + port
		} else {
			u.Host = gw
		}
		return u.String()
	}
	return baseURL
}

// shellSingleQuote wraps s as a single safe POSIX shell token.
func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// codexTokenRE matches the standalone `codex` invocation token in a command so we
// can inject flags immediately after it (handles bare `codex` and `/path/to/codex`).
var codexTokenRE = regexp.MustCompile(`\bcodex\b`)

// buildCodexOpenRouterCommand injects per-invocation Codex CLI overrides so the agent
// routes through the local broker to OpenRouter using the selected model.
//
// Why command flags instead of env vars or ~/.codex/config.toml:
//   - The Rust Codex CLI ignores OPENAI_BASE_URL / OPENAI_MODEL; model comes from
//     --model and the provider from config / -c overrides.
//   - config.toml lives in the workspace HOME which is shared across the dashboard's
//     terminals, so two terminals picking different models would clobber each other.
//     Per-invocation -c flags keep each PTY independent.
//
// base_url points at the broker (not openrouter.ai) so the real key is injected
// server-side; env_key="OPENAI_API_KEY" reads the dummy placeholder set in
// applyOpenRouterEnv, which the broker strips and replaces with the Bearer token.
// wire_api="responses" makes Codex POST {base_url}/responses — current Codex
// rejects wire_api="chat" (codex#7782), and OpenRouter serves an OpenAI-compatible
// Responses API at /api/v1/responses, which the broker forwards to unchanged.
func buildCodexOpenRouterCommand(command string, sel *ModelSelection, sessionID string, brokerPort int) string {
	if !sel.IsOpenRouter() || command == "" {
		return command
	}
	loc := codexTokenRE.FindStringIndex(command)
	if loc == nil {
		return command
	}
	brokerURL := fmt.Sprintf("http://localhost:%d/broker/%s/openrouter", brokerPort, sessionID)
	flags := []string{
		"--model " + shellSingleQuote(sel.Model),
		"-c " + shellSingleQuote(`model_provider="openrouter"`),
		"-c " + shellSingleQuote(`model_providers.openrouter.name="openrouter"`),
		"-c " + shellSingleQuote(fmt.Sprintf(`model_providers.openrouter.base_url="%s"`, brokerURL)),
		"-c " + shellSingleQuote(`model_providers.openrouter.env_key="OPENAI_API_KEY"`),
		"-c " + shellSingleQuote(`model_providers.openrouter.wire_api="responses"`),
	}
	// Catalog-resolved limits silence Codex's "model metadata not found" fallback
	// and keep it from assuming the wrong context window for unknown OpenRouter ids.
	if sel.ContextWindow > 0 {
		flags = append(flags, "-c "+shellSingleQuote(fmt.Sprintf("model_context_window=%d", sel.ContextWindow)))
	}
	if sel.MaxOutputTokens > 0 {
		flags = append(flags, "-c "+shellSingleQuote(fmt.Sprintf("model_max_output_tokens=%d", sel.MaxOutputTokens)))
	}
	insert := " " + strings.Join(flags, " ")
	log.Printf("[model-selection] agent=codex injecting CLI flags model=%s broker=%s", sel.Model, brokerURL)
	return command[:loc[1]] + insert + command[loc[1]:]
}
