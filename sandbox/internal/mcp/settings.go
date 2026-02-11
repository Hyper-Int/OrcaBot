// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: settings-v7-wrapper-command

// Package mcp provides MCP (Model Context Protocol) settings generation
// for agentic coders running in the sandbox.
package mcp

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const settingsRevision = "settings-v7-wrapper-command"

func init() {
	log.Printf("[mcp/settings] REVISION: %s loaded at %s", settingsRevision, time.Now().Format(time.RFC3339))
}

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
// mcpEnv contains env var values to embed in the MCP server config's env field,
// ensuring mcp-bridge gets them even when the host agent strips parent env vars (Codex).
func GenerateSettingsForAgent(workspaceRoot string, agentType AgentType, userTools []MCPTool, mcpEnv map[string]string) error {
	if agentType == AgentTypeUnknown {
		return nil // No agent detected, skip settings generation
	}

	servers := buildServerConfigs(userTools, mcpEnv)

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
func GenerateSettings(workspaceRoot string, sessionID string, userTools []MCPTool, mcpEnv map[string]string) error {
	// Build the server configs once, reuse for all formats
	servers := buildServerConfigs(userTools, mcpEnv)

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

// buildServerConfigs converts user tools into MCPServerConfig map.
// mcpEnv contains env var values to embed directly in the orcabot MCP server config,
// so mcp-bridge gets them even when the host agent strips parent env vars (e.g., Codex).
func buildServerConfigs(userTools []MCPTool, mcpEnv map[string]string) map[string]MCPServerConfig {
	servers := make(map[string]MCPServerConfig)

	// Add built-in orcabot MCP server (uses mcp-bridge for stdio transport)
	// Embed actual env var values so mcp-bridge works even when the host agent
	// strips parent env vars (Codex does this). For agents that inherit env vars
	// (Claude Code, Gemini), these are redundant but harmless.
	//
	// SECURITY: ORCABOT_INTEGRATION_TOKEN is deliberately NOT included here.
	// Following the broker pattern, the token stays in sandbox server memory only.
	// The MCP server (localhost:8081) looks up the token by pty_id internally.
	// ORCABOT_MCP_SECRET is a per-PTY nonce for proof-of-possession (not the integration token).
	bridgeEnv := make(map[string]string)
	for _, key := range []string{"ORCABOT_SESSION_ID", "ORCABOT_MCP_URL", "MCP_LOCAL_PORT", "ORCABOT_PTY_ID", "ORCABOT_MCP_SECRET"} {
		if v, ok := mcpEnv[key]; ok && v != "" {
			bridgeEnv[key] = v
		}
	}
	// Pass critical config as command-line args AND env. Some MCP clients
	// (Gemini CLI) don't propagate the env block to subprocesses correctly.
	// Args are always passed reliably to the subprocess.
	// REVISION: mcp-settings-v3-wrapper-command
	var bridgeArgs []string
	if v := mcpEnv["ORCABOT_MCP_URL"]; v != "" {
		bridgeArgs = append(bridgeArgs, "--mcp-url="+v)
	}
	if v := mcpEnv["ORCABOT_PTY_ID"]; v != "" {
		bridgeArgs = append(bridgeArgs, "--pty-id="+v)
	}
	if v := mcpEnv["ORCABOT_MCP_SECRET"]; v != "" {
		bridgeArgs = append(bridgeArgs, "--mcp-secret="+v)
	}
	// Use per-PTY wrapper script as command if available. The wrapper embeds
	// all config in the command itself, making it work regardless of whether
	// the MCP client forwards args/env to subprocesses. Falls back to bare
	// "mcp-bridge" for local development or when wrapper isn't generated.
	bridgeCommand := "mcp-bridge"
	if cmd := mcpEnv["ORCABOT_BRIDGE_COMMAND"]; cmd != "" {
		bridgeCommand = cmd
	}
	servers["orcabot"] = MCPServerConfig{
		Command: bridgeCommand,
		Args:    bridgeArgs,
		Env:     bridgeEnv,
		EnvVars: []string{"ORCABOT_SESSION_ID", "ORCABOT_MCP_URL", "MCP_LOCAL_PORT", "ORCABOT_PTY_ID", "ORCABOT_MCP_SECRET"},
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

// generateClaudeSettings writes MCP servers to {workspaceRoot}/.mcp.json (project scope).
// Claude Code reads MCP servers from ~/.claude.json (user scope) or .mcp.json (project scope),
// NOT from ~/.claude/settings.json (which is only for permissions, hooks, and preferences).
func generateClaudeSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	mcpJsonPath := filepath.Join(workspaceRoot, ".mcp.json")

	// Read existing .mcp.json or create new
	var settings map[string]interface{}
	data, err := os.ReadFile(mcpJsonPath)
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
	return os.WriteFile(mcpJsonPath, data, 0644)
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

// buildGeminiMCPServers converts MCPServerConfig map to Gemini's JSON format.
func buildGeminiMCPServers(servers map[string]MCPServerConfig) map[string]interface{} {
	mcpServers := make(map[string]interface{})
	for name, server := range servers {
		entry := map[string]interface{}{}
		if server.Command != "" {
			entry["command"] = server.Command
		}
		if len(server.Args) > 0 {
			entry["args"] = server.Args
		}
		if len(server.Env) > 0 {
			entry["env"] = server.Env
		}
		if server.URL != "" {
			entry["url"] = server.URL
		}
		if server.Type != "" {
			entry["type"] = server.Type
		}
		mcpServers[name] = entry
	}
	return mcpServers
}

// mergeGeminiMCPServers writes MCP servers into a Gemini settings file, preserving existing fields.
func mergeGeminiMCPServers(settingsPath string, mcpServers map[string]interface{}) error {
	var settings map[string]interface{}
	if data, err := os.ReadFile(settingsPath); err == nil {
		if err := json.Unmarshal(data, &settings); err != nil {
			settings = make(map[string]interface{})
		}
	} else {
		settings = make(map[string]interface{})
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

// generateGeminiSettings writes MCP servers to both ~/.gemini/settings.json and
// the system override file (.orcabot/gemini-system-settings.json).
// Gemini CLI overwrites ~/.gemini/settings.json on startup, but the system override
// file (pointed to by GEMINI_CLI_SYSTEM_SETTINGS_PATH) has highest precedence and
// is never overwritten by the CLI.
func generateGeminiSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	mcpServers := buildGeminiMCPServers(servers)

	// Write to ~/.gemini/settings.json (may be overwritten by Gemini CLI, but useful as fallback)
	geminiDir := filepath.Join(workspaceRoot, ".gemini")
	if err := os.MkdirAll(geminiDir, 0755); err != nil {
		return err
	}
	settingsPath := filepath.Join(geminiDir, "settings.json")
	if err := mergeGeminiMCPServers(settingsPath, mcpServers); err != nil {
		return err
	}

	// Also write to the system override file (highest precedence, survives CLI rewrites)
	overrideDir := filepath.Join(workspaceRoot, ".orcabot")
	if err := os.MkdirAll(overrideDir, 0755); err != nil {
		return err
	}
	overridePath := filepath.Join(overrideDir, "gemini-system-settings.json")
	return mergeGeminiMCPServers(overridePath, mcpServers)
}

// buildCodexMCPToml generates the [mcp_servers.*] TOML sections for Codex config.
func buildCodexMCPToml(servers map[string]MCPServerConfig) string {
	var sb strings.Builder
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
	return sb.String()
}

// mergeCodexMCPConfig merges MCP server TOML sections into an existing Codex config file,
// preserving non-MCP settings (trust_level, notify, etc.).
func mergeCodexMCPConfig(configPath string, mcpToml string) error {
	existing, _ := os.ReadFile(configPath)
	existingStr := string(existing)

	// Remove any existing [mcp_servers.*] sections to avoid duplicates
	lines := strings.Split(existingStr, "\n")
	var preserved []string
	inMCPSection := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[mcp_servers.") || strings.HasPrefix(trimmed, "[mcp_servers]") {
			inMCPSection = true
			continue
		}
		if inMCPSection && (strings.HasPrefix(trimmed, "[") || trimmed == "") {
			if strings.HasPrefix(trimmed, "[") && !strings.HasPrefix(trimmed, "[mcp_servers") {
				inMCPSection = false
				preserved = append(preserved, line)
			}
			// Skip empty lines within MCP sections
			continue
		}
		if inMCPSection {
			continue // Skip MCP section content (command, env, etc.)
		}
		// Skip our old auto-generated comment
		if trimmed == "# Codex MCP configuration (auto-generated by OrcaBot v2)" {
			continue
		}
		preserved = append(preserved, line)
	}

	// Build final config: preserved content + MCP sections
	var result strings.Builder
	preservedStr := strings.TrimRight(strings.Join(preserved, "\n"), "\n\t ")
	if preservedStr != "" {
		result.WriteString(preservedStr)
		result.WriteString("\n\n")
	}
	result.WriteString("# Codex MCP configuration (auto-generated by OrcaBot)\n")
	result.WriteString(mcpToml)

	return os.WriteFile(configPath, []byte(result.String()), 0644)
}

// generateCodexSettings writes MCP servers to both ~/.codex/config.toml and
// /etc/codex/config.toml (system config). Codex CLI overwrites ~/.codex/config.toml
// on startup, but the system config is read and never overwritten by Codex.
func generateCodexSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	mcpToml := buildCodexMCPToml(servers)

	// Write to ~/.codex/config.toml (may be overwritten by Codex, but useful as fallback)
	codexDir := filepath.Join(workspaceRoot, ".codex")
	if err := os.MkdirAll(codexDir, 0755); err != nil {
		return err
	}
	userConfigPath := filepath.Join(codexDir, "config.toml")
	if err := mergeCodexMCPConfig(userConfigPath, mcpToml); err != nil {
		return err
	}

	// Also write to /etc/codex/config.toml (system config, survives CLI rewrites)
	systemCodexDir := "/etc/codex"
	if err := os.MkdirAll(systemCodexDir, 0755); err != nil {
		// /etc may not be writable on macOS dev, only log warning
		fmt.Fprintf(os.Stderr, "Warning: cannot write Codex system config: %v\n", err)
		return nil
	}
	systemConfigPath := filepath.Join(systemCodexDir, "config.toml")
	return mergeCodexMCPConfig(systemConfigPath, mcpToml)
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
