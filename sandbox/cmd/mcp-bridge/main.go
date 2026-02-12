// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: mcp-bridge-v19-invalidate-warmup-cache
// mcp-bridge is a stdio-to-HTTP bridge for MCP.
// It allows Claude Code (and other MCP clients that use stdio transport)
// to communicate with the sandbox's HTTP-based MCP server.
//
// Claude Code launches this as an MCP server, communicates via JSON-RPC
// over stdin/stdout, and this bridge translates to HTTP calls.
//
// Features:
// - Translates JSON-RPC over stdio to HTTP calls to sandbox MCP server
// - Passes pty_id for integration tool discovery (token stays server-side)
// - Monitors for tool list changes and sends notifications/tools/list_changed
//   so the LLM discovers newly attached integrations without restarting
//
// Environment variables:
//   - ORCABOT_MCP_URL: Base URL for MCP API (e.g., http://localhost:8081/sessions/{id}/mcp)
//   - ORCABOT_SESSION_ID: Session ID (used to construct URL if ORCABOT_MCP_URL not set)
//   - MCP_LOCAL_PORT: Port for local MCP server (default: 8081)
//   - ORCABOT_PTY_ID: PTY ID for integration tool listing
//   - ORCABOT_MCP_SECRET: Per-PTY auth nonce for MCP request proof-of-possession
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

// REVISION: mcp-bridge-v19-invalidate-warmup-cache
const bridgeRevision = "mcp-bridge-v19-invalidate-warmup-cache"

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
	mcpURL    string
	ptyID     string
	mcpSecret string // per-PTY auth nonce for proof-of-possession
}

var (
	httpClient = &http.Client{Timeout: 120 * time.Second}
	// stdoutMu protects stdout writes so the tool monitor goroutine
	// and the main request loop don't interleave JSON lines.
	stdoutMu sync.Mutex

	// warmedTools holds the pre-warmed tools response body (JSON).
	// Set by the warmup goroutine, consumed by the first handleToolsList call.
	// This ensures MCP clients that don't support notifications/tools/list_changed
	// (e.g., Codex CLI) get the full tool list from their first tools/list call.
	warmedTools   []byte
	warmedToolsMu sync.Mutex
	warmedToolsCh = make(chan struct{}) // closed when warmup is done
)

func main() {
	cfg := bridgeConfig{}

	// Priority 1: Command-line args (most reliable — always passed correctly by MCP clients)
	// Format: --mcp-url=..., --pty-id=..., --mcp-secret=...
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "--mcp-url=") {
			cfg.mcpURL = strings.TrimPrefix(arg, "--mcp-url=")
		} else if strings.HasPrefix(arg, "--pty-id=") {
			cfg.ptyID = strings.TrimPrefix(arg, "--pty-id=")
		} else if strings.HasPrefix(arg, "--mcp-secret=") {
			cfg.mcpSecret = strings.TrimPrefix(arg, "--mcp-secret=")
		}
	}
	if cfg.ptyID != "" {
		log.Printf("[mcp-bridge] config from args: ptyID set, mcpSecret set: %v, mcpURL set: %v", cfg.mcpSecret != "", cfg.mcpURL != "")
	}

	// Priority 2: Environment variables
	if cfg.ptyID == "" {
		cfg.ptyID = os.Getenv("ORCABOT_PTY_ID")
	}
	if cfg.mcpSecret == "" {
		cfg.mcpSecret = os.Getenv("ORCABOT_MCP_SECRET")
	}
	if cfg.mcpURL == "" {
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
	}

	// Priority 3: Config files (for agents like Codex that strip env vars)
	if cfg.ptyID == "" {
		cfg.ptyID = readPtyIDFallback()
	}
	if cfg.mcpURL == "" {
		cfg.mcpURL = readMCPURLFromFile(cfg.ptyID)
	}
	if cfg.mcpSecret == "" {
		cfg.mcpSecret = readConfigFromFile("mcp-secret", cfg.ptyID)
	}

	if cfg.mcpURL == "" {
		fmt.Fprintf(os.Stderr, "mcp-bridge: ORCABOT_MCP_URL or ORCABOT_SESSION_ID must be set\n")
		os.Exit(1)
	}

	// Log final config for diagnostics (ptyID prefix only, never log secrets)
	ptyPrefix := cfg.ptyID
	if len(ptyPrefix) > 8 {
		ptyPrefix = ptyPrefix[:8]
	}
	log.Printf("[mcp-bridge] final config: mcpURL=%s ptyID=%s... secretSet=%v", cfg.mcpURL, ptyPrefix, cfg.mcpSecret != "")
	fmt.Fprintf(os.Stderr, "mcp-bridge: using MCP URL: %s\n", cfg.mcpURL)

	// Pre-warm integration tools in background. MCP clients (especially Codex CLI)
	// may call tools/list before integrations are loaded (~40s after PTY creation).
	// This goroutine polls until integrations appear and caches the full response.
	if cfg.mcpSecret != "" {
		go warmupTools(&cfg)
	} else {
		close(warmedToolsCh) // no warmup needed
	}

	// Start background tool list monitor (checks for new/removed tools every 10s)
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

// setMCPAuthHeader sets the per-PTY auth nonce header on an HTTP request.
// This proves the caller is the authorized mcp-bridge for this PTY.
func setMCPAuthHeader(req *http.Request, cfg *bridgeConfig) {
	if cfg.mcpSecret != "" {
		req.Header.Set("X-MCP-Secret", cfg.mcpSecret)
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

// fetchToolNames fetches the current tool list and returns sorted tool names.
// Used by both handleToolsList and the background monitor.
func fetchToolNames(cfg *bridgeConfig) ([]string, error) {
	toolsURL := buildToolsURL(cfg, "/tools")
	httpReq, err := http.NewRequest("GET", toolsURL, nil)
	if err != nil {
		return nil, err
	}
	setMCPAuthHeader(httpReq, cfg)

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

// warmupTools polls the tools endpoint until integration tools appear.
// Caches the full response so the first handleToolsList call returns immediately
// with the complete tool set. This is critical for Codex CLI which doesn't
// handle notifications/tools/list_changed and caches tools from the first call.
func warmupTools(cfg *bridgeConfig) {
	defer close(warmedToolsCh)

	// Integration tools take 30-60s to become available after PTY creation.
	// Poll every 5s for up to 90s.
	deadline := time.Now().Add(90 * time.Second)
	baselineCount := 0

	for time.Now().Before(deadline) {
		body, count := fetchToolsRaw(cfg)
		if body == nil {
			time.Sleep(5 * time.Second)
			continue
		}

		if baselineCount == 0 {
			baselineCount = count
			log.Printf("[mcp-bridge] warmup: baseline %d tools", count)
		}

		// Integration tools add 6+ tools above the baseline (agent state + UI tools)
		if count > baselineCount {
			log.Printf("[mcp-bridge] warmup: integration tools loaded (%d -> %d), caching response", baselineCount, count)
			warmedToolsMu.Lock()
			warmedTools = body
			warmedToolsMu.Unlock()
			return
		}

		time.Sleep(5 * time.Second)
	}

	log.Printf("[mcp-bridge] warmup: timed out after 90s, integration tools not found")
}

// fetchToolsRaw fetches tools from the server and returns the raw JSON body + count.
func fetchToolsRaw(cfg *bridgeConfig) ([]byte, int) {
	toolsURL := buildToolsURL(cfg, "/tools")
	httpReq, err := http.NewRequest("GET", toolsURL, nil)
	if err != nil {
		return nil, 0
	}
	setMCPAuthHeader(httpReq, cfg)

	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return nil, 0
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil || resp.StatusCode != 200 {
		return nil, 0
	}

	var toolsResp struct {
		Tools []json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(body, &toolsResp); err != nil {
		return nil, 0
	}
	return body, len(toolsResp.Tools)
}

func handleToolsList(cfg *bridgeConfig, req *jsonRPCRequest) *jsonRPCResponse {
	// Non-blocking check: if warmup already completed, use cached response.
	// Don't block — Codex CLI has a 10s timeout for MCP startup.
	select {
	case <-warmedToolsCh:
		warmedToolsMu.Lock()
		cached := warmedTools
		warmedToolsMu.Unlock()
		if cached != nil {
			var toolsResp struct {
				Tools []json.RawMessage `json:"tools"`
			}
			if json.Unmarshal(cached, &toolsResp) == nil {
				log.Printf("[mcp-bridge] handleToolsList: returning %d warmed-up tools", len(toolsResp.Tools))
			}
			return &jsonRPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Result:  cached,
			}
		}
	default:
		// Warmup still running — fall through to live fetch
	}

	// Live fetch from server (returns whatever's available now)
	toolsURL := buildToolsURL(cfg, "/tools")

	httpReq, err := http.NewRequest("GET", toolsURL, nil)
	if err != nil {
		return errorResponse(req.ID, -32000, "Failed to create request: "+err.Error())
	}
	setMCPAuthHeader(httpReq, cfg)

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
		log.Printf("[mcp-bridge] handleToolsList: ERROR status=%d body=%s", resp.StatusCode, string(body))
		return errorResponse(req.ID, -32000, "Tools endpoint error: "+string(body))
	}

	// Count tools for diagnostic logging
	var toolsResp struct {
		Tools []json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(body, &toolsResp); err == nil {
		log.Printf("[mcp-bridge] handleToolsList: returning %d tools (url=%s)", len(toolsResp.Tools), toolsURL)
	} else {
		log.Printf("[mcp-bridge] handleToolsList: response parse failed (len=%d): %v", len(body), err)
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
	setMCPAuthHeader(httpReq, cfg)

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
//
// REVISION: mcp-bridge-v19-invalidate-warmup-cache
// Strategy: When tools change, send the list_changed notification AND notify the
// sandbox server via HTTP so it can broadcast a WebSocket event to the frontend.
// The frontend shows a "restart to apply" banner for agents (like Codex CLI) that
// don't support dynamic tool list updates.
func monitorToolChanges(cfg *bridgeConfig) {
	// Establish baseline: fetch current tools BEFORE the delay so we capture
	// what the client approximately received from its initial tools/list call.
	// If this fails (server not ready yet), baseline stays empty and we'll
	// send a (harmless) notification on the first successful poll.
	var lastToolKey string
	if names, err := fetchToolNames(cfg); err == nil {
		lastToolKey = strings.Join(names, ",")
		log.Printf("[mcp-bridge] tool monitor: baseline established with %d tools", len(names))
	} else {
		log.Printf("[mcp-bridge] tool monitor: baseline fetch failed (will retry): %v", err)
	}

	// Wait for initialization to complete (integrations may be attached during this window)
	time.Sleep(10 * time.Second)

	// notifyUntil: keep re-sending list_changed until this deadline.
	// Agents may be busy when the first notification arrives; retrying
	// ensures they process it when they become idle.
	var notifyUntil time.Time

	for {
		names, err := fetchToolNames(cfg)
		if err != nil {
			log.Printf("[mcp-bridge] tool monitor: fetch error: %v", err)
			time.Sleep(10 * time.Second)
			continue
		}

		toolKey := strings.Join(names, ",")

		if toolKey != lastToolKey {
			oldCount := 0
			if lastToolKey != "" {
				oldCount = strings.Count(lastToolKey, ",") + 1
			}
			log.Printf("[mcp-bridge] tool list changed: %d -> %d tools", oldCount, len(names))

			// Invalidate warmup cache so the next tools/list call does a live fetch.
			// Without this, agents that re-fetch after notifications/tools/list_changed
			// (e.g., Gemini CLI, Claude Code) would get stale cached data.
			warmedToolsMu.Lock()
			warmedTools = nil
			warmedToolsMu.Unlock()
			log.Printf("[mcp-bridge] warmup cache invalidated")

			// Notify sandbox server so it can broadcast a WebSocket event to the frontend.
			// The frontend shows a "restart to apply" banner for agents that don't
			// support dynamic tool list updates (e.g., Codex CLI).
			go notifyToolsChanged(cfg, oldCount, len(names))

			lastToolKey = toolKey
			// Start/extend the notification window (15s = ~2 retries at 10s intervals)
			notifyUntil = time.Now().Add(15 * time.Second)
		}

		// Send notification if we're within the retry window
		if time.Now().Before(notifyUntil) {
			log.Printf("[mcp-bridge] sending list_changed notification (retry window active)")
			notification := &jsonRPCResponse{
				JSONRPC: "2.0",
				Method:  "notifications/tools/list_changed",
			}
			safeWriteResponse(notification)
		}

		time.Sleep(10 * time.Second)
	}
}

// notifyToolsChanged calls the sandbox server's tools-changed endpoint.
// This broadcasts a WebSocket event so the frontend can show a restart prompt.
// REVISION: mcp-bridge-v19-invalidate-warmup-cache
func notifyToolsChanged(cfg *bridgeConfig, oldCount, newCount int) {
	// Derive the tools-changed URL from mcpURL.
	// mcpURL is like http://localhost:8081/sessions/{sessionId}/mcp
	// We need http://localhost:8081/sessions/{sessionId}/ptys/{ptyId}/tools-changed
	baseURL := strings.TrimSuffix(cfg.mcpURL, "/mcp")
	toolsChangedURL := fmt.Sprintf("%s/ptys/%s/tools-changed", baseURL, cfg.ptyID)

	body, _ := json.Marshal(map[string]int{
		"oldCount": oldCount,
		"newCount": newCount,
	})

	req, err := http.NewRequest("POST", toolsChangedURL, bytes.NewReader(body))
	if err != nil {
		log.Printf("[mcp-bridge] failed to create tools-changed request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("[mcp-bridge] failed to send tools-changed: %v", err)
		return
	}
	resp.Body.Close()
	log.Printf("[mcp-bridge] notified sandbox: tools changed %d -> %d", oldCount, newCount)
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

// readConfigFromFile reads a config value from a per-PTY file under .orcabot/pty/.
// This is a fallback for agents (like Codex) that don't forward env vars to MCP subprocesses.
// Checks $HOME/.orcabot/pty/{ptyID}/{name} first, then /workspace/.orcabot/pty/{ptyID}/{name}.
func readConfigFromFile(name, ptyID string) string {
	if ptyID == "" {
		return ""
	}
	paths := []string{}
	if home := os.Getenv("HOME"); home != "" {
		paths = append(paths, filepath.Join(home, ".orcabot", "pty", ptyID, name))
	}
	paths = append(paths, filepath.Join("/workspace/.orcabot", "pty", ptyID, name))

	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err == nil {
			val := strings.TrimSpace(string(data))
			if val != "" {
				log.Printf("[mcp-bridge] read %s from %s", name, p)
				return val
			}
		}
	}
	return ""
}

// readPtyIDFallback reads a best-effort PTY ID pointer for agents that don't pass PTY ID.
// Checks $HOME/.orcabot/pty-id first, then /workspace/.orcabot/pty-id.
func readPtyIDFallback() string {
	paths := []string{}
	if home := os.Getenv("HOME"); home != "" {
		paths = append(paths, filepath.Join(home, ".orcabot", "pty-id"))
	}
	paths = append(paths, filepath.Join("/workspace/.orcabot", "pty-id"))

	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err == nil {
			val := strings.TrimSpace(string(data))
			if val != "" {
				log.Printf("[mcp-bridge] read pty-id from %s", p)
				return val
			}
		}
	}
	return ""
}

// readMCPURLFromFile reads MCP URL from a per-PTY config file.
// Kept for backwards compatibility; delegates to readConfigFromFile.
func readMCPURLFromFile(ptyID string) string {
	return readConfigFromFile("mcp-url", ptyID)
}
