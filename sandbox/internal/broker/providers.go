// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Package broker implements a session-local auth broker that injects API keys
// into outbound requests, preventing LLMs from accessing secrets directly.
// REVISION: broker-v2-fix-gemini-baseurl
package broker

import "fmt"

// ProviderSpec defines how to broker requests for a specific API provider.
type ProviderSpec struct {
	EnvKey        string // Original key name (e.g., OPENAI_API_KEY)
	TargetBaseURL string // Target API base URL (e.g., https://api.openai.com/v1)
	HeaderName    string // Auth header name (e.g., Authorization)
	HeaderFormat  string // Auth header format (e.g., "Bearer %s")
	BrokerEnvKey  string // Env var to set for broker URL (e.g., OPENAI_BASE_URL)
	Category      string // "agent" or "tool"
}

// Providers maps provider names to their specifications.
// These are built-in providers with hardcoded configurations.
var Providers = map[string]ProviderSpec{
	// Agent providers - LLM API keys
	"anthropic": {
		EnvKey:        "ANTHROPIC_API_KEY",
		TargetBaseURL: "https://api.anthropic.com",
		HeaderName:    "x-api-key",
		HeaderFormat:  "%s",
		BrokerEnvKey:  "ANTHROPIC_BASE_URL",
		Category:      "agent",
	},
	"openai": {
		EnvKey:        "OPENAI_API_KEY",
		TargetBaseURL: "https://api.openai.com/v1",
		HeaderName:    "Authorization",
		HeaderFormat:  "Bearer %s",
		BrokerEnvKey:  "OPENAI_BASE_URL",
		Category:      "agent",
	},
	"google": {
		EnvKey:        "GOOGLE_API_KEY",
		TargetBaseURL: "https://generativelanguage.googleapis.com",
		HeaderName:    "x-goog-api-key",
		HeaderFormat:  "%s",
		BrokerEnvKey:  "GOOGLE_BASE_URL",
		Category:      "agent",
	},
	"gemini": {
		EnvKey:        "GEMINI_API_KEY",
		TargetBaseURL: "https://generativelanguage.googleapis.com",
		HeaderName:    "x-goog-api-key",
		HeaderFormat:  "%s",
		BrokerEnvKey:  "GOOGLE_GEMINI_BASE_URL",
		Category:      "agent",
	},

	// Tool providers - third-party API keys
	"elevenlabs": {
		EnvKey:        "ELEVENLABS_API_KEY",
		TargetBaseURL: "https://api.elevenlabs.io",
		HeaderName:    "xi-api-key",
		HeaderFormat:  "%s",
		BrokerEnvKey:  "ELEVENLABS_BASE_URL",
		Category:      "tool",
	},
	"deepgram": {
		EnvKey:        "DEEPGRAM_API_KEY",
		TargetBaseURL: "https://api.deepgram.com",
		HeaderName:    "Authorization",
		HeaderFormat:  "Token %s",
		BrokerEnvKey:  "DEEPGRAM_BASE_URL",
		Category:      "tool",
	},
	"groq": {
		EnvKey:        "GROQ_API_KEY",
		TargetBaseURL: "https://api.groq.com/openai/v1",
		HeaderName:    "Authorization",
		HeaderFormat:  "Bearer %s",
		BrokerEnvKey:  "GROQ_BASE_URL",
		Category:      "agent",
	},
	"together": {
		EnvKey:        "TOGETHER_API_KEY",
		TargetBaseURL: "https://api.together.xyz/v1",
		HeaderName:    "Authorization",
		HeaderFormat:  "Bearer %s",
		BrokerEnvKey:  "TOGETHER_BASE_URL",
		Category:      "agent",
	},
	"fireworks": {
		EnvKey:        "FIREWORKS_API_KEY",
		TargetBaseURL: "https://api.fireworks.ai/inference/v1",
		HeaderName:    "Authorization",
		HeaderFormat:  "Bearer %s",
		BrokerEnvKey:  "FIREWORKS_BASE_URL",
		Category:      "agent",
	},
	"mistral": {
		EnvKey:        "MISTRAL_API_KEY",
		TargetBaseURL: "https://api.mistral.ai/v1",
		HeaderName:    "Authorization",
		HeaderFormat:  "Bearer %s",
		BrokerEnvKey:  "MISTRAL_BASE_URL",
		Category:      "agent",
	},
	"cohere": {
		EnvKey:        "COHERE_API_KEY",
		TargetBaseURL: "https://api.cohere.ai/v1",
		HeaderName:    "Authorization",
		HeaderFormat:  "Bearer %s",
		BrokerEnvKey:  "COHERE_BASE_URL",
		Category:      "agent",
	},
	"replicate": {
		EnvKey:        "REPLICATE_API_TOKEN",
		TargetBaseURL: "https://api.replicate.com/v1",
		HeaderName:    "Authorization",
		HeaderFormat:  "Token %s",
		BrokerEnvKey:  "REPLICATE_BASE_URL",
		Category:      "tool",
	},
	"huggingface": {
		EnvKey:        "HUGGINGFACE_API_KEY",
		TargetBaseURL: "https://api-inference.huggingface.co",
		HeaderName:    "Authorization",
		HeaderFormat:  "Bearer %s",
		BrokerEnvKey:  "HUGGINGFACE_BASE_URL",
		Category:      "tool",
	},
}

// GetProviderByEnvKey finds a provider spec by environment variable name.
// Returns the provider name and spec, or empty values if not found.
func GetProviderByEnvKey(envKey string) (string, *ProviderSpec) {
	for name, spec := range Providers {
		if spec.EnvKey == envKey {
			s := spec // Copy to avoid range var pointer issues
			return name, &s
		}
	}
	return "", nil
}

// GetDummyValue returns a placeholder message for a brokered key.
// This is set as the env var value to inform LLMs that the key is brokered.
func GetDummyValue(provider string) string {
	spec, exists := Providers[provider]
	if !exists {
		return "[BROKERED] This key is securely managed. API calls are brokered automatically."
	}
	return fmt.Sprintf("[BROKERED] %s is securely managed. API calls are brokered automatically.", spec.EnvKey)
}

// GetCustomDummyValue returns a placeholder for custom (non-built-in) secrets.
func GetCustomDummyValue(secretName string) string {
	return fmt.Sprintf("[BROKERED - route API calls through $%s_BROKER]", secretName)
}

// IsKnownSecretKey returns true if the env key name looks like a secret.
// Used to detect when users accidentally add secrets as regular env vars.
func IsKnownSecretKey(envKey string) bool {
	// Check if it's a known provider key
	if _, spec := GetProviderByEnvKey(envKey); spec != nil {
		return true
	}

	// Check common secret patterns
	secretPatterns := []string{
		"_KEY", "_TOKEN", "_SECRET", "_API_KEY", "_ACCESS_KEY",
		"_PASSWORD", "_CREDENTIAL", "_AUTH",
	}
	for _, pattern := range secretPatterns {
		if len(envKey) > len(pattern) {
			suffix := envKey[len(envKey)-len(pattern):]
			if suffix == pattern {
				return true
			}
		}
	}
	return false
}
