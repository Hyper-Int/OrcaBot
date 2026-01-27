// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

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
	URL     string            `json:"url,omitempty"` // For remote servers
	Type    string            `json:"type,omitempty"`
}

// Settings represents Claude Code's settings.json structure
type Settings struct {
	MCPServers map[string]MCPServerConfig `json:"mcpServers"`
}

// GenerateSettings creates settings files for all supported agentic coders.
// It always includes the built-in orcabot MCP server and adds any user-configured tools.
// Since HOME is set to workspaceRoot, ~ paths resolve there.
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

// generateClaudeSettings creates .claude/settings.json
func generateClaudeSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	claudeDir := filepath.Join(workspaceRoot, ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		return err
	}

	settings := Settings{MCPServers: servers}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(claudeDir, "settings.json"), data, 0644)
}

// OpenCodeConfig represents OpenCode's opencode.json structure
type OpenCodeConfig struct {
	Schema string                       `json:"$schema"`
	MCP    map[string]OpenCodeMCPServer `json:"mcp"`
}

type OpenCodeMCPServer struct {
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Type    string            `json:"type,omitempty"`
	Enabled bool              `json:"enabled"`
}

// generateOpenCodeSettings creates ~/.config/opencode/opencode.json
func generateOpenCodeSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	configDir := filepath.Join(workspaceRoot, ".config", "opencode")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return err
	}

	mcpServers := make(map[string]OpenCodeMCPServer)
	for name, server := range servers {
		mcpServers[name] = OpenCodeMCPServer{
			Command: server.Command,
			Args:    server.Args,
			Env:     server.Env,
			URL:     server.URL,
			Type:    server.Type,
			Enabled: true,
		}
	}

	config := OpenCodeConfig{
		Schema: "https://opencode.ai/config.json",
		MCP:    mcpServers,
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(configDir, "opencode.json"), data, 0644)
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

// generateGeminiSettings creates ~/.gemini/settings.json
func generateGeminiSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	geminiDir := filepath.Join(workspaceRoot, ".gemini")
	if err := os.MkdirAll(geminiDir, 0755); err != nil {
		return err
	}

	mcpServers := make(map[string]GeminiMCPServer)
	for name, server := range servers {
		mcpServers[name] = GeminiMCPServer{
			Command: server.Command,
			Args:    server.Args,
			URL:     server.URL,
			Type:    server.Type,
		}
	}

	settings := GeminiSettings{MCPServers: mcpServers}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(geminiDir, "settings.json"), data, 0644)
}

// generateCodexSettings creates ~/.codex/config.toml
func generateCodexSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	codexDir := filepath.Join(workspaceRoot, ".codex")
	if err := os.MkdirAll(codexDir, 0755); err != nil {
		return err
	}

	var sb strings.Builder
	sb.WriteString("# Codex MCP configuration (auto-generated by OrcaBot)\n\n")

	for name, server := range servers {
		if server.Command == "" {
			continue // Skip non-stdio servers for TOML format
		}

		sb.WriteString(fmt.Sprintf("[mcp_servers.%q]\n", name))
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

// generateDroidSettings creates ~/.factory/mcp.json
func generateDroidSettings(workspaceRoot string, servers map[string]MCPServerConfig) error {
	factoryDir := filepath.Join(workspaceRoot, ".factory")
	if err := os.MkdirAll(factoryDir, 0755); err != nil {
		return err
	}

	mcpServers := make(map[string]DroidMCPServer)
	for name, server := range servers {
		droidServer := DroidMCPServer{
			Disabled: false,
		}

		if server.URL != "" {
			// HTTP/SSE transport
			droidServer.Type = "http"
			if server.Type == "sse" {
				droidServer.Type = "sse"
			}
			droidServer.URL = server.URL
		} else {
			// stdio transport
			droidServer.Type = "stdio"
			droidServer.Command = server.Command
			droidServer.Args = server.Args
		}

		mcpServers[name] = droidServer
	}

	config := DroidConfig{MCPServers: mcpServers}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(factoryDir, "mcp.json"), data, 0644)
}

// ReadSettings reads the current Claude settings file if it exists
func ReadSettings(workspaceRoot string) (*Settings, error) {
	settingsPath := filepath.Join(workspaceRoot, ".claude", "settings.json")

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

// UpdateSettings merges new MCP servers into existing settings (all formats)
func UpdateSettings(workspaceRoot string, newServers map[string]MCPServerConfig) error {
	settings, err := ReadSettings(workspaceRoot)
	if err != nil {
		return err
	}

	for name, config := range newServers {
		settings.MCPServers[name] = config
	}

	return GenerateSettings(workspaceRoot, "", nil)
}
