// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

// MCP proxy handlers - forward MCP requests to the control plane
// This allows agents in terminals to access MCP UI tools without
// needing to know about authentication tokens.

// handleMCPListTools returns both UI tools (from control plane) and browser tools (local)
func (s *Server) handleMCPListTооls(w http.ResponseWriter, r *http.Request) {
	// Validate session exists
	sessionID := r.PathValue("sessionId")
	session := s.getSessiоnOrErrоr(w, sessionID)
	if session == nil {
		return
	}

	// Collect all tools
	var allTools []interface{}

	// Add browser tools (local - always available)
	for _, tool := range s.handleBrowserMCPTools() {
		allTools = append(allTools, tool)
	}

	// Try to get UI tools from control plane
	controlplaneURL := os.Getenv("CONTROLPLANE_URL")
	if controlplaneURL != "" {
		targetURL := fmt.Sprintf("%s/internal/mcp/ui/tools", controlplaneURL)
		req, err := http.NewRequestWithContext(r.Context(), "GET", targetURL, nil)
		if err == nil {
			// Use dashboard-scoped token if available, otherwise fall back to internal token
			if session.MCPToken != "" {
				req.Header.Set("X-Dashboard-Token", session.MCPToken)
			} else if internalToken := os.Getenv("INTERNAL_API_TOKEN"); internalToken != "" {
				req.Header.Set("X-Internal-Token", internalToken)
			}

			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				defer resp.Body.Close()
				if resp.StatusCode == 200 {
					var uiToolsResp struct {
						Tools []interface{} `json:"tools"`
					}
					if json.NewDecoder(resp.Body).Decode(&uiToolsResp) == nil {
						allTools = append(allTools, uiToolsResp.Tools...)
					}
				}
			}
		}
	}

	// Return combined tools list
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tools": allTools,
	})
}

// handleMCPCallTool handles tool calls - browser tools locally, UI tools via control plane
func (s *Server) handleMCPCallTооl(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")
	session := s.getSessiоnOrErrоr(w, sessionID)
	if session == nil {
		return
	}

	// Parse incoming request to check tool name
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "E79815: "+err.Error(), http.StatusBadRequest)
		return
	}

	var incomingReq struct {
		Name      string                 `json:"name"`
		Arguments map[string]interface{} `json:"arguments"`
	}
	if err := json.Unmarshal(bodyBytes, &incomingReq); err != nil {
		http.Error(w, "E79815: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Check if this is a browser tool - handle locally
	if isBrowserTool(incomingReq.Name) {
		s.handleBrowserMCPCall(w, r, incomingReq.Name, incomingReq.Arguments)
		return
	}

	// Not a browser tool - proxy to control plane for UI tools
	controlplaneURL := os.Getenv("CONTROLPLANE_URL")

	if controlplaneURL == "" {
		http.Error(w, "E79810: CONTROLPLANE_URL not configured", http.StatusServiceUnavailable)
		return
	}

	// Check if session has dashboard_id
	if session.DashboardID == "" {
		http.Error(w, "E79814: Session has no dashboard_id - cannot proxy MCP calls", http.StatusBadRequest)
		return
	}

	// Validate or inject dashboard_id (using already-parsed incomingReq)
	if incomingReq.Arguments == nil {
		incomingReq.Arguments = make(map[string]interface{})
	}

	// If caller provided a dashboard_id, validate it matches the session's dashboard
	if providedDashboardID, ok := incomingReq.Arguments["dashboard_id"].(string); ok && providedDashboardID != "" {
		if providedDashboardID != session.DashboardID {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error": fmt.Sprintf("E79821: dashboard_id mismatch - this sandbox can only access dashboard %s", session.DashboardID),
			})
			return
		}
	}
	// Always set to session's dashboard_id (validates or injects)
	incomingReq.Arguments["dashboard_id"] = session.DashboardID

	// Build request body for control plane
	outgoingReq := map[string]interface{}{
		"name":      incomingReq.Name,
		"arguments": incomingReq.Arguments,
	}
	body, err := json.Marshal(outgoingReq)
	if err != nil {
		http.Error(w, "E79816: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Forward to control plane internal endpoint
	targetURL := fmt.Sprintf("%s/internal/mcp/ui/tools/call", controlplaneURL)

	req, err := http.NewRequestWithContext(r.Context(), "POST", targetURL, bytes.NewReader(body))
	if err != nil {
		http.Error(w, "E79817: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// Use dashboard-scoped token if available, otherwise fall back to internal token
	if session.MCPToken != "" {
		req.Header.Set("X-Dashboard-Token", session.MCPToken)
	} else if internalToken := os.Getenv("INTERNAL_API_TOKEN"); internalToken != "" {
		req.Header.Set("X-Internal-Token", internalToken)
	} else {
		http.Error(w, "E79811: No MCP token configured", http.StatusServiceUnavailable)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, "E79818: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// handleMCPListItems proxies GET /mcp/items to control plane
func (s *Server) handleMCPListItems(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")
	session := s.getSessiоnOrErrоr(w, sessionID)
	if session == nil {
		return
	}

	controlplaneURL := os.Getenv("CONTROLPLANE_URL")

	if controlplaneURL == "" {
		http.Error(w, "E79810: CONTROLPLANE_URL not configured", http.StatusServiceUnavailable)
		return
	}

	// Check if session has dashboard_id
	if session.DashboardID == "" {
		http.Error(w, "E79814: Session has no dashboard_id - cannot proxy MCP calls", http.StatusBadRequest)
		return
	}

	// Forward to control plane internal endpoint
	targetURL := fmt.Sprintf("%s/internal/mcp/ui/dashboards/%s/items", controlplaneURL, session.DashboardID)

	req, err := http.NewRequestWithContext(r.Context(), "GET", targetURL, nil)
	if err != nil {
		http.Error(w, "E79819: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// Use dashboard-scoped token if available, otherwise fall back to internal token
	if session.MCPToken != "" {
		req.Header.Set("X-Dashboard-Token", session.MCPToken)
	} else if internalToken := os.Getenv("INTERNAL_API_TOKEN"); internalToken != "" {
		req.Header.Set("X-Internal-Token", internalToken)
	} else {
		http.Error(w, "E79811: No MCP token configured", http.StatusServiceUnavailable)
		return
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		http.Error(w, "E79820: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
