// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: mcp-bridge-v4-tool-change-notify
// mcp-bridge is a stdio-to-HTTP bridge for MCP.
// It allows Claude Code (and other MCP clients that use stdio transport)
// to communicate with the sandbox's HTTP-based MCP server.
//
// Claude Code launches this as an MCP server, communicates via JSON-RPC
// over stdin/stdout, and this bridge translates to HTTP calls.
//
// Features:
// - Translates JSON-RPC over stdio to HTTP calls to sandbox MCP server
// - Passes integration auth (pty_id + token) for integration tool discovery
// - Monitors for tool list changes and sends notifications/tools/list_changed
//   so the LLM discovers newly attached integrations without restarting
//
// Environment variables:
//   - ORCABOT_MCP_URL: Base URL for MCP API (e.g., http://localhost:8081/sessions/{id}/mcp)
//   - ORCABOT_SESSION_ID: Session ID (used to construct URL if ORCABOT_MCP_URL not set)
//   - MCP_LOCAL_PORT: Port for local MCP server (default: 8081)
//   - ORCABOT_PTY_ID: PTY ID for integration tool listing and gateway auth
//   - ORCABOT_INTEGRATION_TOKEN: Integration token for gateway auth
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const bridgeRevision = "mcp-bridge-v4-tool-change-notify"

func init() {
	log.Printf("[mcp-bridge] REVISION: %s loaded at %s", bridgeRevision, time.Now().Format(time.RFC3339))
}

// JSON-RPC structures
type jsonRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// bridgeConfig holds env-derived configuration for the bridge
type bridgeConfig struct {
	mcpURL           string
	ptyID            string
	integrationToken string
}

var (
	httpClient = &http.Client{Timeout: 120 * time.Second}
	// stdoutMu protects stdout writes so the tool monitor goroutine
	// and the main request loop don't interleave JSON lines.
	stdoutMu sync.Mutex
)

func main() {
	cfg := bridgeConfig{
		ptyID:            os.Getenv("ORCABOT_PTY_ID"),
		integrationToken: os.Getenv("ORCABOT_INTEGRATION_TOKEN"),
	}

	// Diagnostic: log env var presence (not values) to verify token injection
	log.Printf("[mcp-bridge] env ORCABOT_PTY_ID set: %v (len=%d)", cfg.ptyID != "", len(cfg.ptyID))
	log.Printf("[mcp-bridge] env ORCABOT_INTEGRATION_TOKEN set: %v (len=%d)", cfg.integrationToken != "", len(cfg.integrationToken))

	cfg.mcpURL = os.Getenv("ORCABOT_MCP_URL")
	if cfg.mcpURL == "" {
		// Construct from session ID
		sessionID := os.Getenv("ORCABOT_SESSION_ID")
		mcpPort := os.Getenv("MCP_LOCAL_PORT")
		if mcpPort == "" {
			mcpPort = "8081"
		}
		if sessionID != "" {
			cfg.mcpURL = fmt.Sprintf("http://localhost:%s/sessions/%s/mcp", mcpPort, sessionID)
		}
	}

	// Fallback: read from config file (for agents like Codex that strip env vars)
	if cfg.mcpURL == "" {
		cfg.mcpURL = readMCPURLFromFile()
	}

	if cfg.mcpURL == "" {
		fmt.Fprintf(os.Stderr, "mcp-bridge: ORCABOT_MCP_URL or ORCABOT_SESSION_ID must be set\n")
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "mcp-bridge: using MCP URL: %s\n", cfg.mcpURL)
	
	// Start background tool list monitor (checks for new/removed tools every 5s)
	go monitorToolChanges(&cfg)

	scanner := bufio.NewScanner(os.Stdin)
	// Increase buffer for large messages (10MB max)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req jsonRPCRequest
		if err := json.Unmarshal(line, &req); err != nil {
			safeWriteResponse(errorResponse(nil, -32700, "Parse error: "+err.Error()))
			continue
		}

		response := handleRequest(&cfg, &req)
		if response != nil {
			safeWriteResponse(response)
		}
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "mcp-bridge: read error: %v\n", err)
		os.Exit(1)
	}
}

// safeWriteResponse writes a JSON-RPC response to stdout with mutex protection
func safeWriteResponse(resp *jsonRPCResponse) {
	responseBytes, _ := json.Marshal(resp)
	stdoutMu.Lock()
	fmt.Println(string(responseBytes))
	stdoutMu.Unlock()
}

func handleRequest(cfg *bridgeConfig, req *jsonRPCRequest) *jsonRPCResponse {
	switch req.Method {
	case "initialize":
		return handleInitialize(req)

	case "tools/list":
		return handleToolsList(cfg, req)

	case "tools/call":
		return handleToolsCall(cfg, req)

	case "notifications/initialized":
		// Notification - no response needed
		return nil

	case "ping":
		return &jsonRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  json.RawMessage(`{}`),
		}

	default:
		return errorResponse(req.ID, -32601, "Method not found: "+req.Method)
	}
}

func handleInitialize(req *jsonRPCRequest) *jsonRPCResponse {
	result := map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"capabilities": map[string]interface{}{
			"tools": map[string]interface{}{
				"listChanged": true, // Advertise tool list change notification support
			},
		},
		"serverInfo": map[string]interface{}{
			"name":    "orcabot",
			"version": "1.0.0",
		},
	}
	resultBytes, _ := json.Marshal(result)
	return &jsonRPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  resultBytes,
	}
}

// buildToolsURL constructs the tools endpoint URL with pty_id query parameter
func buildToolsURL(cfg *bridgeConfig, path string) string {
	toolsURL := cfg.mcpURL + path
	if cfg.ptyID != "" {
		toolsURL += "?pty_id=" + url.QueryEscape(cfg.ptyID)
	}
	return toolsURL
}

// setIntegrationHeaders adds the X-Integration-Token header if available
func setIntegrationHeaders(req *http.Request, cfg *bridgeConfig) {
	if cfg.integrationToken != "" {
		req.Header.Set("X-Integration-Token", cfg.integrationToken)
	}
}

// fetchToolNames fetches the current tool list and returns sorted tool names.
// Used by both handleToolsList and the background monitor.
func fetchToolNames(cfg *bridgeConfig) ([]string, error) {
	toolsURL := buildToolsURL(cfg, "/tools")
	httpReq, err := http.NewRequest("GET", toolsURL, nil)
	if err != nil {
		return nil, err
	}
	setIntegrationHeaders(httpReq, cfg)

	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	names := make([]string, len(result.Tools))
	for i, t := range result.Tools {
		names[i] = t.Name
	}
	sort.Strings(names)
	return names, nil
}

func handleToolsList(cfg *bridgeConfig, req *jsonRPCRequest) *jsonRPCResponse {
	toolsURL := buildToolsURL(cfg, "/tools")

	httpReq, err := http.NewRequest("GET", toolsURL, nil)
	if err != nil {
		return errorResponse(req.ID, -32000, "Failed to create request: "+err.Error())
	}
	setIntegrationHeaders(httpReq, cfg)

	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return errorResponse(req.ID, -32000, "Failed to fetch tools: "+err.Error())
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return errorResponse(req.ID, -32000, "Failed to read response: "+err.Error())
	}

	if resp.StatusCode != 200 {
		return errorResponse(req.ID, -32000, "Tools endpoint error: "+string(body))
	}

	// Server returns {"tools": [...]} - return as-is
	return &jsonRPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  body,
	}
}

func handleToolsCall(cfg *bridgeConfig, req *jsonRPCRequest) *jsonRPCResponse {
	// Parse parameters
	var params struct {
		Name      string                 `json:"name"`
		Arguments map[string]interface{} `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return errorResponse(req.ID, -32602, "Invalid params: "+err.Error())
	}

	// Build request body
	callBody, _ := json.Marshal(map[string]interface{}{
		"name":      params.Name,
		"arguments": params.Arguments,
	})

	callURL := buildToolsURL(cfg, "/tools/call")

	httpReq, err := http.NewRequest("POST", callURL, bytes.NewReader(callBody))
	if err != nil {
		return errorResponse(req.ID, -32000, "Failed to create request: "+err.Error())
	}
	httpReq.Header.Set("Content-Type", "application/json")
	setIntegrationHeaders(httpReq, cfg)

	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return errorResponse(req.ID, -32000, "Failed to call tool: "+err.Error())
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return errorResponse(req.ID, -32000, "Failed to read response: "+err.Error())
	}

	if resp.StatusCode >= 400 {
		return errorResponse(req.ID, -32000, "Tool call error: "+string(body))
	}

	// Server returns MCP-compatible response with {"content": [...]}
	return &jsonRPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  body,
	}
}

// monitorToolChanges polls the tools endpoint and sends notifications/tools/list_changed
// when the tool set changes (e.g., when an integration is attached or detached).
// This allows Claude Code to discover new tools without restarting.
func monitorToolChanges(cfg *bridgeConfig) {
	// Wait before first poll to let initialization complete
	time.Sleep(10 * time.Second)

	var lastToolKey string

	for {
		names, err := fetchToolNames(cfg)
		if err != nil {
			log.Printf("[mcp-bridge] tool monitor: fetch error: %v", err)
			time.Sleep(10 * time.Second)
			continue
		}

		toolKey := strings.Join(names, ",")
		if lastToolKey != "" && toolKey != lastToolKey {
			log.Printf("[mcp-bridge] tool list changed: %d -> %d tools", strings.Count(lastToolKey, ",")+1, len(names))
			// Send MCP notification (no id field = notification, not request)
			notification := &jsonRPCResponse{
				JSONRPC: "2.0",
				Method:  "notifications/tools/list_changed",
			}
			safeWriteResponse(notification)
		}
		lastToolKey = toolKey

		time.Sleep(5 * time.Second)
	}
}

func errorResponse(id interface{}, code int, message string) *jsonRPCResponse {
	return &jsonRPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &jsonRPCError{
			Code:    code,
			Message: message,
		},
	}
}

// readMCPURLFromFile reads MCP URL from a well-known config file.
// This is a fallback for agents (like Codex) that don't forward env vars to MCP subprocesses.
// Checks $HOME/.orcabot/mcp-url first, then /workspace/.orcabot/mcp-url as fallback.
func readMCPURLFromFile() string {
	paths := []string{}
	if home := os.Getenv("HOME"); home != "" {
		paths = append(paths, filepath.Join(home, ".orcabot", "mcp-url"))
	}
	// Also check common workspace paths
	paths = append(paths, "/workspace/.orcabot/mcp-url")

	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err == nil {
			url := strings.TrimSpace(string(data))
			if url != "" {
				fmt.Fprintf(os.Stderr, "mcp-bridge: read MCP URL from %s\n", p)
				return url
			}
		}
	}
	return ""
}
