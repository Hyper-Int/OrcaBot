// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: model-selection-v3-openai-key

package sessions

import (
	"fmt"
	"log"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/broker"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
)

const modelSelectionRevision = "model-selection-v3-openai-key"

func init() {
	log.Printf("[model-selection] REVISION: %s loaded at %s", modelSelectionRevision, time.Now().Format(time.RFC3339))
}

// ModelSelection describes a per-PTY override for the model/provider the harness should use.
// provider="default" means the harness uses its built-in API. provider="openrouter" routes
// requests through the local broker to OpenRouter.
type ModelSelection struct {
	Provider string // "default" | "openrouter"
	Model    string // OpenRouter model id, e.g. "anthropic/claude-sonnet-4.6"
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
//   - Gemini CLI / Moltbot: not supported.
//
// brokerPort comes from Session.BrokerPort(). sessionID scopes the broker config.
func applyOpenRouterEnv(envVars map[string]string, agentType mcp.AgentType, sel *ModelSelection, sessionID string, brokerPort int) {
	if !sel.IsOpenRouter() {
		return
	}
	brokerURL := fmt.Sprintf("http://localhost:%d/broker/%s/openrouter", brokerPort, sessionID)

	switch agentType {
	case mcp.AgentTypeCodex, mcp.AgentTypeOpenCode, mcp.AgentTypeDroid:
		// OpenAI-compatible SDKs append /chat/completions to the base; the broker
		// strips /broker/{sid}/openrouter and forwards to OpenRouter's /api/v1.
		envVars["OPENAI_BASE_URL"] = brokerURL
		envVars["OPENAI_MODEL"] = sel.Model
		// OpenAI-compatible clients refuse to construct/send a request without a
		// non-empty API key, so the request would never reach the broker. Set a
		// placeholder; the broker strips it and injects the real OpenRouter
		// Bearer token (mirrors the ANTHROPIC_API_KEY placeholder below, and the
		// dummy OPENAI_API_KEY the default Codex flow sets in env.go).
		envVars["OPENAI_API_KEY"] = broker.GetDummyValue("openai")
		log.Printf("[model-selection] agent=%s routing via OpenRouter model=%s broker=%s", agentType, sel.Model, brokerURL)
	case mcp.AgentTypeClaude:
		anthropicBroker := fmt.Sprintf("http://localhost:%d/broker/%s/openrouter-anthropic", brokerPort, sessionID)
		envVars["ANTHROPIC_BASE_URL"] = anthropicBroker
		// Placeholder so Claude Code starts; the broker strips x-api-key on the
		// outbound request and substitutes the real OpenRouter Bearer token.
		envVars["ANTHROPIC_API_KEY"] = broker.GetDummyValue("anthropic")
		log.Printf("[model-selection] agent=claude routing via OpenRouter model=%s broker=%s", sel.Model, anthropicBroker)
	default:
		log.Printf("[model-selection] agent=%s OpenRouter routing not supported", agentType)
	}
}
