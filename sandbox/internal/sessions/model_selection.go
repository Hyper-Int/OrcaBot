// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: model-selection-v1-openrouter

package sessions

import (
	"fmt"
	"log"
	"os"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
)

const modelSelectionRevision = "model-selection-v1-openrouter"

func init() {
	log.Printf("[model-selection] REVISION: %s loaded at %s", modelSelectionRevision, "init")
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
// brokerHost is typically "localhost:8082". sessionID scopes the broker config.
func applyOpenRouterEnv(envVars map[string]string, agentType mcp.AgentType, sel *ModelSelection, sessionID, brokerHost string) {
	if !sel.IsOpenRouter() {
		return
	}
	if brokerHost == "" {
		brokerHost = "localhost:8082"
	}
	brokerURL := fmt.Sprintf("http://%s/broker/%s/openrouter", brokerHost, sessionID)

	switch agentType {
	case mcp.AgentTypeCodex, mcp.AgentTypeOpenCode, mcp.AgentTypeDroid:
		// OpenAI-compatible SDKs append /chat/completions to the base; the broker
		// strips /broker/{sid}/openrouter and forwards to OpenRouter's /api/v1.
		envVars["OPENAI_BASE_URL"] = brokerURL
		envVars["OPENAI_MODEL"] = sel.Model
		// Some clients respect a per-provider override variable:
		envVars["OPENROUTER_BASE_URL"] = brokerURL
		envVars["OPENROUTER_MODEL"] = sel.Model
		log.Printf("[model-selection] agent=%s routing via OpenRouter model=%s broker=%s", agentType, sel.Model, brokerURL)
	case mcp.AgentTypeClaude:
		// Anthropic SDK appends /v1/messages to ANTHROPIC_BASE_URL, so route to
		// the sibling broker entry (openrouter-anthropic) whose target is
		// https://openrouter.ai/api (no /v1) — final URL becomes
		// https://openrouter.ai/api/v1/messages. The broker injects the OpenRouter
		// Bearer token; Claude Code's own apiKeyHelper is cleared by
		// SetClaudeModelForOpenRouter (called from session.go).
		anthropicBroker := fmt.Sprintf("http://%s/broker/%s/openrouter-anthropic", brokerHost, sessionID)
		envVars["ANTHROPIC_BASE_URL"] = anthropicBroker
		// Placeholder for ANTHROPIC_API_KEY so Claude Code starts; the broker
		// strips this header and substitutes the real OpenRouter Bearer token.
		envVars["ANTHROPIC_API_KEY"] = "[BROKERED] OpenRouter Bearer injected by broker"
		log.Printf("[model-selection] agent=claude routing via OpenRouter model=%s broker=%s", sel.Model, anthropicBroker)
	default:
		log.Printf("[model-selection] agent=%s OpenRouter routing not supported", agentType)
	}
}

// brokerHostFromEnv resolves the broker host:port, falling back to localhost:8082.
func brokerHostFromEnv() string {
	if h := os.Getenv("ORCABOT_BROKER_HOST"); h != "" {
		return h
	}
	return "localhost:8082"
}
