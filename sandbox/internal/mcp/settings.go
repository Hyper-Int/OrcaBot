// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: settings-v2-robust-agent-detect

// Package mcp provides MCP (Model Context Protocol) settings generation
// for agentic coders running in the sandbox.
package mcp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// MCPTool represents a user-configured MCP tool
type MCPTool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	ServerURL   string                 `json:"server_url"`
	Transport   string                 `json:"transport"` // "stdio", "sse", "streamable-http"
	Config      map[string]interface{} `json:"config"`    // command, args, env, etc.
}

// MCPServerConfig represents the configuration for an MCP server
type MCPServerConfig struct {
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	EnvVars []string          `json:"env_vars,omitempty"` // Env var names to forward from parent (Codex)
	URL     string            `json:"url,omitempty"`      // For remote servers
	Type    string            `json:"type,omitempty"`
}

// Settings represents Claude Code's settings.json structure
type Settings struct {
	MCPServers map[string]MCPServerConfig `json:"mcpServers"`
}

// AgentType identifies which agentic coder is being used
type AgentType string

const (
	AgentTypeClaude   AgentType = "claude"
	AgentTypeOpenCode AgentType = "opencode"
	AgentTypeGemini   AgentType = "gemini"
	AgentTypeCodex    AgentType = "codex"
	AgentTypeDroid   AgentType = "droid"
	AgentTypeMoltbot AgentType = "moltbot"
	AgentTypeUnknown  AgentType = ""
)

// DetectAgentType determines which agent is being launched from the command string.
// Returns AgentTypeUnknown if no agent is detected (e.g., plain shell).
//
// Uses word-boundary matching so commands like "talkito codex" or "env VAR=x claude"
// are correctly detected. A word boundary is a space or the start/end of string.
func DetectAgentType(command string) AgentType {
	cmd := strings.ToLower(strings.TrimSpace(command))

	// Check if command contains the agent name as a word (not substring)
	// Order matters: check more specific names first to avoid false matches
	switch {
	case containsWord(cmd, "openclaw") || containsWord(cmd, "moltbot") ||
		containsWord(cmd, "molt") || containsWord(cmd, "clawdbot"):
		return AgentTypeMoltbot
	case containsWord(cmd, "opencode"):
		return AgentTypeOpenCode
	case containsWord(cmd, "claude"):
		return AgentTypeClaude
	case containsWord(cmd, "gemini"):
		return AgentTypeGemini
	case containsWord(cmd, "codex"):
		return AgentTypeCodex
	case containsWord(cmd, "droid"):
		return AgentTypeDroid
	default:
		return AgentTypeUnknown
	}
}

// containsWord checks if the command contains the word as a standalone token.
// A word is considered standalone if it's surrounded by spaces, or at the
// start/end of the string. This prevents matching "claude" in "claudette".
func containsWord(cmd, word string) bool {
	idx := strings.Index(cmd, word)
	if idx == -1 {
		return false
	}

	// Check left boundary: must be start of string or preceded by space
	if idx > 0 && cmd[idx-1] != ' ' {
		return false
	}

	// Check right boundary: must be end of string or followed by space
	endIdx := idx + len(word)
	if endIdx < len(cmd) && cmd[endIdx] != ' ' {
		return false
	}

	return true
}

// GenerateSettingsForAgent creates settings file for a specific agent only.
// If agentType is AgentTypeUnknown, no settings are generated.
func GenerateSettingsForAgent(workspaceRoot string, agentType AgentType, userTools []MCPTool) error {
	if agentType == AgentTypeUnknown {
		return nil // No agent detected, skip settings generation
	}

	servers := buildServerConfigs(userTools)

	switch agentType {
	case AgentTypeClaude:
		return generateClaudeSettings(workspaceRoot, servers)
	case AgentTypeOpenCode:
		return generateOpenCodeSettings(workspaceRoot, servers)
	case AgentTypeGemini:
		return generateGeminiSettings(workspaceRoot, servers)
	case AgentTypeCodex:
		return generateCodexSettings(workspaceRoot, servers)
	case AgentTypeDroid:
		return generateDroidSettings(workspaceRoot, servers)
	case AgentTypeMoltbot:
		return generateMoltbotSettings(workspaceRoot, servers)
	default:
		return nil
	}
}

// GenerateSettings creates settings files for all supported agentic coders.
// Deprecated: Use GenerateSettingsForAgent with DetectAgentType for targeted generation.
func GenerateSettings(workspaceRoot string, sessionID string, userTools []MCPTool) error {
	// Build the server configs once, reuse for all formats
	servers := buildServerConfigs(userTools)

	// Generate settings for each agent
	var errs []error

	if err := generateClaudeSettings(workspaceRoot, servers); err != nil {
		errs = append(errs, fmt.Errorf("claude: %w", err))
	}

	if err := generateOpenCodeSettings(workspaceRoot, servers); err != nil {
		errs = append(errs, fmt.Errorf("opencode: %w", err))
	}

	if err := generateGeminiSettings(workspaceRoot, servers); err != nil {
		errs = append(errs, fmt.Errorf("gemini: %w", err))
	}

	if err := generateCodexSettings(workspaceRoot, servers); err != nil {
		errs = append(errs, fmt.Errorf("codex: %w", err))
	}

	if err := generateDroidSettings(workspaceRoot, servers); err != nil {
		errs = append(errs, fmt.Errorf("droid: %w", err))
	}

	if err := generateMoltbotSettings(workspaceRoot, servers); err != nil {
		errs = append(errs, fmt.Errorf("moltbot: %w", err))
	}

	if len(errs) > 0 {
		return fmt.Errorf("settings generation errors: %v", errs)
	}
	return nil
}

// buildServerConfigs converts user tools into MCPServerConfig map
func buildServerConfigs(userTools []MCPTool) map[string]MCPServerConfig {
	servers := make(map[string]MCPServerConfig)

	// Add built-in orcabot MCP server (uses mcp-bridge for stdio transport)
	// Environment variables ORCABOT_SESSION_ID and ORCABOT_MCP_URL are already set in PTY
	servers["orcabot"] = MCPServerConfig{
		Command: "mcp-bridge",
		Env:     map[string]string{},
		EnvVars: []string{"ORCABOT_SESSION_ID", "ORCABOT_MCP_URL", "MCP_LOCAL_PORT", "ORCABOT_PTY_ID"},
	}

	// Add user-configured MCP tools
	for _, tool := range userTools {
		config := MCPServerConfig{}

		switch tool.Transport {
		case "stdio":
			if cmd, ok := tool.Config["command"].(string); ok {
				config.Command = cmd
			}
			if args, ok := tool.Config["args"].([]interface{}); ok {
				for _, arg := range args {
					if s, ok := arg.(string); ok {
						config.Args = append(config.Args, s)
					}
				}
			}
			if env, ok := tool.Config["env"].(map[string]interface{}); ok {
				config.Env = make(map[string]string)
				for k, v := range env {
					if s, ok := v.(string); ok {
						config.Env[k] = s
					}
				}
			}

		case "sse", "streamable-http":
			config.Type = tool.Transport
			if tool.ServerURL != "" {
				config.URL = tool.ServerURL
			} else if url, ok := tool.Config["url"].(string); ok {
				config.URL = url
			}
		}

		if tool.Name != "" {
			servers[tool.Name] = config
		}
	}

	return servers
}

// generateClaudeSettings merges MCP servers into ~/.claude/settings.json
// This file also contains hooks, so we must merge rather than overwrite.
func generateClaudeSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	claudeDir := filepath.Join(workspaceRoot, ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		return err
	}

	settingsPath := filepath.Join(claudeDir, "settings.json")

	// Read existing settings or create new
	var settings map[string]interface{}
	data, err := os.ReadFile(settingsPath)
	if err == nil {
		if err := json.Unmarshal(data, &settings); err != nil {
			settings = make(map[string]interface{})
		}
	} else {
		settings = make(map[string]interface{})
	}

	// Convert servers to interface{} map for merging
	mcpServers := make(map[string]interface{})
	for name, server := range servers {
		serverMap := map[string]interface{}{
			"command": server.Command,
		}
		if len(server.Args) > 0 {
			serverMap["args"] = server.Args
		}
		if len(server.Env) > 0 {
			serverMap["env"] = server.Env
		} else {
			serverMap["env"] = map[string]interface{}{}
		}
		if server.URL != "" {
			serverMap["url"] = server.URL
		}
		if server.Type != "" {
			serverMap["type"] = server.Type
		}
		mcpServers[name] = serverMap
	}

	// Merge our servers with existing ones (our servers take precedence)
	existingServers, ok := settings["mcpServers"].(map[string]interface{})
	if ok {
		for name, server := range mcpServers {
			existingServers[name] = server
		}
		settings["mcpServers"] = existingServers
	} else {
		settings["mcpServers"] = mcpServers
	}

	// Write back
	data, err = json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(settingsPath, data, 0644)
}

// OpenCodeConfig represents OpenCode's opencode.json structure
// See: https://github.com/opencode-ai/opencode/blob/main/internal/config/config.go
type OpenCodeConfig struct {
	MCPServers map[string]OpenCodeMCPServer `json:"mcpServers,omitempty"`
}

type OpenCodeMCPServer struct {
	Type    string            `json:"type"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     []string          `json:"env"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// generateOpenCodeSettings is a no-op for now.
// OpenCode rewrites its config on startup, mangling MCP entries (drops type,
// changes command format, renames fields), then fails to validate its own output.
// TODO: revisit when OpenCode's config format stabilizes. Users can add MCP
// servers at runtime via `opencode mcp add`.
func generateOpenCodeSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	return nil
}

// GeminiSettings represents Gemini's settings.json structure
type GeminiSettings struct {
	MCPServers map[string]GeminiMCPServer `json:"mcpServers"`
}

type GeminiMCPServer struct {
	Command string   `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	URL     string   `json:"url,omitempty"`
	Type    string   `json:"type,omitempty"`
}

// generateGeminiSettings merges MCP servers into ~/.gemini/settings.json,
// preserving existing fields (auth config, user preferences, etc.).
func generateGeminiSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	geminiDir := filepath.Join(workspaceRoot, ".gemini")
	if err := os.MkdirAll(geminiDir, 0755); err != nil {
		return err
	}

	settingsPath := filepath.Join(geminiDir, "settings.json")

	// Read existing settings to preserve auth-related and other user fields
	var settings map[string]interface{}
	if data, err := os.ReadFile(settingsPath); err == nil {
		if err := json.Unmarshal(data, &settings); err != nil {
			settings = make(map[string]interface{})
		}
	} else {
		settings = make(map[string]interface{})
	}

	// Build our MCP servers
	mcpServers := make(map[string]interface{})
	for name, server := range servers {
		entry := map[string]interface{}{}
		if server.Command != "" {
			entry["command"] = server.Command
		}
		if len(server.Args) > 0 {
			entry["args"] = server.Args
		}
		if server.URL != "" {
			entry["url"] = server.URL
		}
		if server.Type != "" {
			entry["type"] = server.Type
		}
		mcpServers[name] = entry
	}

	// Merge: preserve existing MCP servers, our entries take precedence
	if existing, ok := settings["mcpServers"].(map[string]interface{}); ok {
		for name, server := range mcpServers {
			existing[name] = server
		}
	} else {
		settings["mcpServers"] = mcpServers
	}

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(settingsPath, data, 0644)
}

// generateCodexSettings creates ~/.codex/config.toml
func generateCodexSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	codexDir := filepath.Join(workspaceRoot, ".codex")
	if err := os.MkdirAll(codexDir, 0755); err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "[DEBUG] generateCodexSettings v2: codexDir=%s (env_vars+bare_keys)\n", codexDir)

	var sb strings.Builder
	sb.WriteString("# Codex MCP configuration (auto-generated by OrcaBot v2)\n\n")

	for name, server := range servers {
		if server.Command == "" {
			continue // Skip non-stdio servers for TOML format
		}

		// Use bare key if valid (alphanumeric, dash, underscore), otherwise quote
		if isBareKey(name) {
			sb.WriteString(fmt.Sprintf("[mcp_servers.%s]\n", name))
		} else {
			sb.WriteString(fmt.Sprintf("[mcp_servers.%q]\n", name))
		}
		sb.WriteString(fmt.Sprintf("command = %q\n", server.Command))

		if len(server.Args) > 0 {
			argsQuoted := make([]string, len(server.Args))
			for i, arg := range server.Args {
				argsQuoted[i] = fmt.Sprintf("%q", arg)
			}
			sb.WriteString(fmt.Sprintf("args = [%s]\n", strings.Join(argsQuoted, ", ")))
		}

		if len(server.Env) > 0 {
			sb.WriteString("env = { ")
			envPairs := make([]string, 0, len(server.Env))
			for k, v := range server.Env {
				envPairs = append(envPairs, fmt.Sprintf("%q = %q", k, v))
			}
			sb.WriteString(strings.Join(envPairs, ", "))
			sb.WriteString(" }\n")
		}

		// env_vars: list of env var names to forward from parent process
		if len(server.EnvVars) > 0 {
			varsQuoted := make([]string, len(server.EnvVars))
			for i, v := range server.EnvVars {
				varsQuoted[i] = fmt.Sprintf("%q", v)
			}
			sb.WriteString(fmt.Sprintf("env_vars = [%s]\n", strings.Join(varsQuoted, ", ")))
		}

		sb.WriteString("\n")
	}

	return os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte(sb.String()), 0644)
}

// DroidConfig represents Droid's mcp.json structure
type DroidConfig struct {
	MCPServers map[string]DroidMCPServer `json:"mcpServers"`
}

type DroidMCPServer struct {
	Type     string   `json:"type"`
	Command  string   `json:"command,omitempty"`
	Args     []string `json:"args,omitempty"`
	URL      string   `json:"url,omitempty"`
	Disabled bool     `json:"disabled"`
}

// generateDroidSettings merges MCP servers into ~/.factory/mcp.json,
// preserving existing user config fields.
func generateDroidSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	factoryDir := filepath.Join(workspaceRoot, ".factory")
	if err := os.MkdirAll(factoryDir, 0755); err != nil {
		return err
	}

	configPath := filepath.Join(factoryDir, "mcp.json")

	var config map[string]interface{}
	if data, err := os.ReadFile(configPath); err == nil {
		if err := json.Unmarshal(data, &config); err != nil {
			config = make(map[string]interface{})
		}
	} else {
		config = make(map[string]interface{})
	}

	mcpServers := make(map[string]interface{})
	for name, server := range servers {
		entry := map[string]interface{}{
			"disabled": false,
		}
		if server.URL != "" {
			entry["type"] = "http"
			if server.Type == "sse" {
				entry["type"] = "sse"
			}
			entry["url"] = server.URL
		} else {
			entry["type"] = "stdio"
			entry["command"] = server.Command
			if len(server.Args) > 0 {
				entry["args"] = server.Args
			}
		}
		mcpServers[name] = entry
	}

	// Merge: preserve existing servers, our entries take precedence
	if existing, ok := config["mcpServers"].(map[string]interface{}); ok {
		for name, server := range mcpServers {
			existing[name] = server
		}
	} else {
		config["mcpServers"] = mcpServers
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, data, 0644)
}

// MoltbotConfig represents OpenClaw's MCP configuration
type MoltbotConfig struct {
	MCPServers map[string]MoltbotMCPServer `json:"mcpServers"`
}

type MoltbotMCPServer struct {
	Type    string   `json:"type"`
	Command string   `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	URL     string   `json:"url,omitempty"`
}

// generateMoltbotSettings merges MCP servers into .openclaw/mcp.json,
// preserving existing user config fields.
func generateMoltbotSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	openclawDir := filepath.Join(workspaceRoot, ".openclaw")
	if err := os.MkdirAll(openclawDir, 0755); err != nil {
		return err
	}

	configPath := filepath.Join(openclawDir, "mcp.json")

	var config map[string]interface{}
	if data, err := os.ReadFile(configPath); err == nil {
		if err := json.Unmarshal(data, &config); err != nil {
			config = make(map[string]interface{})
		}
	} else {
		config = make(map[string]interface{})
	}

	mcpServers := make(map[string]interface{})
	for name, server := range servers {
		entry := map[string]interface{}{}
		if server.URL != "" {
			entry["type"] = "http"
			entry["url"] = server.URL
		} else {
			entry["type"] = "stdio"
			entry["command"] = server.Command
			if len(server.Args) > 0 {
				entry["args"] = server.Args
			}
		}
		mcpServers[name] = entry
	}

	if existing, ok := config["mcpServers"].(map[string]interface{}); ok {
		for name, server := range mcpServers {
			existing[name] = server
		}
	} else {
		config["mcpServers"] = mcpServers
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, data, 0644)
}

// isBareKey returns true if the string is valid as a TOML bare key (A-Za-z0-9_-)
func isBareKey(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// ReadSettings reads the current Claude settings file if it exists
func ReadSettings(workspaceRoot string) (*Settings, error) {
	settingsPath := filepath.Join(workspaceRoot, ".mcp.json")

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return &Settings{MCPServers: make(map[string]MCPServerConfig)}, nil
		}
		return nil, err
	}

	var settings Settings
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, err
	}

	if settings.MCPServers == nil {
		settings.MCPServers = make(map[string]MCPServerConfig)
	}

	return &settings, nil
}

// UpdateSettings merges new MCP servers into existing settings and regenerates all config files
func UpdateSettings(workspaceRoot string, newServers map[string]MCPServerConfig) error {
	settings, err := ReadSettings(workspaceRoot)
	if err != nil {
		return err
	}

	for name, config := range newServers {
		settings.MCPServers[name] = config
	}

	// Write all formats using the merged server configs
	var errs []error

	if err := generateClaudeSettings(workspaceRoot, settings.MCPServers); err != nil {
		errs = append(errs, fmt.Errorf("claude: %w", err))
	}
	if err := generateOpenCodeSettings(workspaceRoot, settings.MCPServers); err != nil {
		errs = append(errs, fmt.Errorf("opencode: %w", err))
	}
	if err := generateGeminiSettings(workspaceRoot, settings.MCPServers); err != nil {
		errs = append(errs, fmt.Errorf("gemini: %w", err))
	}
	if err := generateCodexSettings(workspaceRoot, settings.MCPServers); err != nil {
		errs = append(errs, fmt.Errorf("codex: %w", err))
	}
	if err := generateDroidSettings(workspaceRoot, settings.MCPServers); err != nil {
		errs = append(errs, fmt.Errorf("droid: %w", err))
	}
	if err := generateMoltbotSettings(workspaceRoot, settings.MCPServers); err != nil {
		errs = append(errs, fmt.Errorf("moltbot: %w", err))
	}

	if len(errs) > 0 {
		return fmt.Errorf("settings update errors: %v", errs)
	}
	return nil
}
