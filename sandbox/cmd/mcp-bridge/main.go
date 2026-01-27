// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// mcp-bridge is a stdio-to-HTTP bridge for MCP.
// It allows Claude Code (and other MCP clients that use stdio transport)
// to communicate with the sandbox's HTTP-based MCP server.
//
// Claude Code launches this as an MCP server, communicates via JSON-RPC
// over stdin/stdout, and this bridge translates to HTTP calls.
//
// Environment variables:
//   - ORCABOT_MCP_URL: Base URL for MCP API (e.g., http://localhost:8081/sessions/{id}/mcp)
//   - ORCABOT_SESSION_ID: Session ID (used to construct URL if ORCABOT_MCP_URL not set)
//   - MCP_LOCAL_PORT: Port for local MCP server (default: 8081)
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// JSON-RPC structures
type jsonRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

var httpClient = &http.Client{Timeout: 120 * time.Second}

func main() {
	mcpURL := os.Getenv("ORCABOT_MCP_URL")
	if mcpURL == "" {
		// Construct from session ID
		sessionID := os.Getenv("ORCABOT_SESSION_ID")
		mcpPort := os.Getenv("MCP_LOCAL_PORT")
		if mcpPort == "" {
			mcpPort = "8081"
		}
		if sessionID != "" {
			mcpURL = fmt.Sprintf("http://localhost:%s/sessions/%s/mcp", mcpPort, sessionID)
		}
	}

	if mcpURL == "" {
		fmt.Fprintf(os.Stderr, "mcp-bridge: ORCABOT_MCP_URL or ORCABOT_SESSION_ID must be set\n")
		os.Exit(1)
	}

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
			writeResponse(errorResponse(nil, -32700, "Parse error: "+err.Error()))
			continue
		}

		response := handleRequest(mcpURL, &req)
		if response != nil {
			writeResponse(response)
		}
	}

	if err := scanner.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "mcp-bridge: read error: %v\n", err)
		os.Exit(1)
	}
}

func writeResponse(resp *jsonRPCResponse) {
	responseBytes, _ := json.Marshal(resp)
	fmt.Println(string(responseBytes))
}

func handleRequest(mcpURL string, req *jsonRPCRequest) *jsonRPCResponse {
	switch req.Method {
	case "initialize":
		return handleInitialize(req)

	case "tools/list":
		return handleToolsList(mcpURL, req)

	case "tools/call":
		return handleToolsCall(mcpURL, req)

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
			"tools": map[string]interface{}{},
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

func handleToolsList(mcpURL string, req *jsonRPCRequest) *jsonRPCResponse {
	resp, err := httpClient.Get(mcpURL + "/tools")
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

func handleToolsCall(mcpURL string, req *jsonRPCRequest) *jsonRPCResponse {
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

	resp, err := httpClient.Post(mcpURL+"/tools/call", "application/json", bytes.NewReader(callBody))
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
