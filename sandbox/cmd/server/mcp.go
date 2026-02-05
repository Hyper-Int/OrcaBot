// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: mcp-integration-v10-drivesync-notify

package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
)

func init() {
	log.Printf("[mcp-server] REVISION: mcp-integration-v10-drivesync-notify loaded at %s", time.Now().Format(time.RFC3339))
}

// browserToolToAction maps browser MCP tool names to gateway action names
// used by enforcePolicy() in the control plane
var browserToolToAction = map[string]string{
	"browser_start":       "browser.lifecycle",   // Lifecycle actions bypass URL checks
	"browser_stop":        "browser.lifecycle",   // (no page interaction)
	"browser_status":      "browser.lifecycle",
	"browser_navigate":    "browser.navigate",
	"browser_screenshot":  "browser.screenshot",
	"browser_click":       "browser.click",
	"browser_type":        "browser.type",
	"browser_get_content": "browser.extractText",
	"browser_get_html":    "browser.extractText",
	"browser_get_url":     "browser.extractText",
	"browser_get_title":   "browser.extractText",
	"browser_wait":        "browser.navigate",    // Wait is read-only, gate on navigate
	"browser_evaluate":    "browser.executeJs",
	"browser_scroll":      "browser.scroll",
}

// MCP proxy handlers - forward MCP requests to the control plane
// This allows agents in terminals to access MCP UI tools without
// needing to know about authentication tokens.

// validateIntegrationToken validates the caller's integration token against the stored token.
// The caller must provide X-Integration-Token header matching the token stored for their pty_id.
// This prevents cross-PTY impersonation within the same sandbox.
func validateIntegrationToken(w http.ResponseWriter, r *http.Request, session interface{ GetIntegrationToken(string) string }) (ptyID, token string, ok bool) {
	ptyID = r.URL.Query().Get("pty_id")
	if ptyID == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": "E79838: pty_id query parameter required",
		})
		return "", "", false
	}

	callerToken := r.Header.Get("X-Integration-Token")
	if callerToken == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": "E79839: X-Integration-Token header required",
		})
		return "", "", false
	}

	storedToken := session.GetIntegrationToken(ptyID)
	if storedToken == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": "E79831: No integration token available for this terminal",
		})
		return "", "", false
	}

	// Constant-time comparison to prevent timing attacks
	if subtle.ConstantTimeCompare([]byte(callerToken), []byte(storedToken)) != 1 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": "E79840: Integration token mismatch",
		})
		return "", "", false
	}

	return ptyID, storedToken, true
}

// handleMCPListTools returns browser tools (local), UI tools (from control plane),
// and integration tools (based on attached integrations)
func (s *Server) handleMCPListTооls(w http.ResponseWriter, r *http.Request) {
	// Validate session exists
	sessionID := r.PathValue("sessionId")
	session := s.getSessiоnOrErrоr(w, sessionID)
	if session == nil {
		return
	}

	// Collect all tools - gated by integration attachment (no edge = no tool)
	var allTools []interface{}

	// Validate caller's integration token to prevent cross-PTY impersonation.
	// For tool listing, missing token just means no integration tools (soft fail).
	// Mismatched token is still an error (suspicious).
	ptyID := r.URL.Query().Get("pty_id")
	log.Printf("[mcp-tools] ListTools: pty_id=%q present=%v", ptyID, ptyID != "")
	if ptyID != "" {
		callerToken := r.Header.Get("X-Integration-Token")
		storedToken := session.GetIntegrationToken(ptyID)
		log.Printf("[mcp-tools] ListTools: callerToken set=%v (len=%d), storedToken set=%v (len=%d)",
			callerToken != "", len(callerToken), storedToken != "", len(storedToken))

		// Only proceed if both tokens exist and match
		tokenValid := callerToken != "" && storedToken != "" &&
			subtle.ConstantTimeCompare([]byte(callerToken), []byte(storedToken)) == 1
		log.Printf("[mcp-tools] ListTools: tokenValid=%v", tokenValid)

		if callerToken != "" && storedToken != "" && !tokenValid {
			// Token mismatch - suspicious, deny
			log.Printf("[mcp-tools] ListTools: ERROR token mismatch for pty_id=%s", ptyID)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error":   true,
				"message": "E79840: Integration token mismatch",
			})
			return
		}

		if tokenValid {
			gatewayClient := mcp.NewGatewayClient()
			integrations, err := gatewayClient.ListIntegrations(ptyID, storedToken)
			if err != nil {
				log.Printf("[mcp-tools] ListTools: ERROR listing integrations: %v", err)
			} else if integrations == nil {
				log.Printf("[mcp-tools] ListTools: integrations response is nil")
			} else {
				log.Printf("[mcp-tools] ListTools: got %d integrations from gateway", len(integrations.Integrations))
				var activeProviders []string
				for i, integration := range integrations.Integrations {
					log.Printf("[mcp-tools] ListTools: integration[%d] provider=%s activePolicyId=%q",
						i, integration.Provider, integration.ActivePolicyID)
					// Only add tools if there's an active policy
					if integration.ActivePolicyID != "" {
						activeProviders = append(activeProviders, integration.Provider)
						if integration.Provider == "browser" {
							// Browser tools are handled locally but still gated by attachment
							for _, tool := range s.handleBrowserMCPTools() {
								allTools = append(allTools, tool)
							}
						} else {
							providerTools := mcp.GetToolsForProvider(integration.Provider)
							log.Printf("[mcp-tools] ListTools: adding %d tools for provider=%s",
								len(providerTools), integration.Provider)
							for _, tool := range providerTools {
								allTools = append(allTools, map[string]interface{}{
									"name":        tool.Name,
									"description": tool.Description,
									"inputSchema": json.RawMessage(tool.InputSchema),
								})
							}
						}
					}
				}

				// Notify session of current integrations for Drive sync management.
				// This detects attach/detach of google_drive and triggers sync start/stop.
				session.NotifyIntegrations(ptyID, activeProviders, storedToken)
			}
		} else {
			log.Printf("[mcp-tools] ListTools: skipping integration tools (tokenValid=false)")
		}
	} else {
		log.Printf("[mcp-tools] ListTools: no pty_id, skipping integration tools")
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

	// Check if this is a browser tool - enforce policy via gateway, then execute locally
	if isBrowserTool(incomingReq.Name) {
		// Validate caller's integration token (prevents cross-PTY impersonation)
		_, integrationToken, tokenOk := validateIntegrationToken(w, r, session)
		if !tokenOk {
			return
		}

		// Map tool name to gateway action for policy enforcement
		browserAction, actionOk := browserToolToAction[incomingReq.Name]
		if !actionOk {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error":   true,
				"message": fmt.Sprintf("E79841: Unknown browser tool: %s", incomingReq.Name),
			})
			return
		}

		// Build args for gateway enforcement. For tools that interact with the current
		// page (not navigate/start/stop/status), inject the browser's current URL so
		// the gateway can enforce URL allowlist. Without this, only browser_navigate
		// would be checked and a redirect or link-click could move to a disallowed domain.
		gatewayArgs := make(map[string]interface{})
		for k, v := range incomingReq.Arguments {
			gatewayArgs[k] = v
		}
		needsURLCheck := incomingReq.Name != "browser_navigate" &&
			incomingReq.Name != "browser_start" &&
			incomingReq.Name != "browser_stop" &&
			incomingReq.Name != "browser_status"
		if needsURLCheck {
			if currentURL, urlErr := session.BrowserGetURL(); urlErr == nil && currentURL != "" {
				gatewayArgs["url"] = currentURL
			}
		}

		// Call gateway for full policy enforcement (attachment check, capability check,
		// URL allowlist, rate limits, audit logging). The gateway returns allowed/denied
		// for browser without trying to execute an API call.
		gatewayClient := mcp.NewGatewayClient()
		executeReq := mcp.ExecuteRequest{
			Action: browserAction,
			Args:   gatewayArgs,
		}

		resp, err := gatewayClient.Execute("browser", integrationToken, executeReq)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error":   true,
				"message": fmt.Sprintf("E79836: Failed to check browser policy: %v", err),
			})
			return
		}

		// Check for gateway errors
		if resp.Error != "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error":   true,
				"code":    resp.Error,
				"message": fmt.Sprintf("Browser policy error (%s): %s", resp.Error, resp.Reason),
			})
			return
		}

		// Check policy enforcement result
		if !resp.Allowed {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error":    true,
				"message":  fmt.Sprintf("Browser policy denied: %s", resp.Reason),
				"decision": resp.Decision,
				"policyId": resp.PolicyID,
			})
			return
		}

		// Policy allows - execute browser tool locally
		s.handleBrowserMCPCall(w, r, incomingReq.Name, incomingReq.Arguments)
		return
	}

	// Check if this is an integration tool - route to gateway
	if mcp.IsIntegrationTool(incomingReq.Name) {
		s.handleIntegrationToolCall(w, r, incomingReq.Name, incomingReq.Arguments)
		return
	}

	// Not a browser or integration tool - proxy to control plane for UI tools
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

// handleIntegrationToolCall routes integration tool calls (gmail_*, github_*, etc.) to the gateway
func (s *Server) handleIntegrationToolCall(w http.ResponseWriter, r *http.Request, toolName string, args map[string]interface{}) {
	sessionID := r.PathValue("sessionId")
	session := s.getSessiоnOrErrоr(w, sessionID)
	if session == nil {
		return
	}

	// Validate caller's integration token (prevents cross-PTY impersonation)
	_, integrationToken, ok := validateIntegrationToken(w, r, session)
	if !ok {
		return
	}

	// Get provider and action for this tool
	provider := mcp.GetProviderForTool(toolName)
	action := mcp.GetActionForTool(toolName)
	if provider == "" || action == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": fmt.Sprintf("E79832: Unknown integration tool: %s", toolName),
		})
		return
	}

	// Call the gateway - context is derived server-side from args for security
	gatewayClient := mcp.NewGatewayClient()
	executeReq := mcp.ExecuteRequest{
		Action: action,
		Args:   args,
	}

	resp, err := gatewayClient.Execute(provider, integrationToken, executeReq)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"content": []map[string]interface{}{
				{"type": "text", "text": fmt.Sprintf("Error: Gateway unavailable: %v", err)},
			},
			"isError": true,
		})
		return
	}

	// Check for gateway/API errors (distinct from policy denials)
	if resp.Error != "" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"content": []map[string]interface{}{
				{"type": "text", "text": fmt.Sprintf("Error: %s - %s", resp.Error, resp.Reason)},
			},
			"isError": true,
		})
		return
	}

	// Check if the request was denied by policy
	if !resp.Allowed {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"content": []map[string]interface{}{
				{"type": "text", "text": fmt.Sprintf("Policy denied: %s", resp.Reason)},
			},
			"isError": true,
		})
		return
	}

	// Return the filtered response in MCP content format.
	// MCP tool call responses must use {"content": [{"type": "text", "text": "..."}]}
	// so that MCP clients (Claude Code, Gemini, etc.) can parse the result.
	w.Header().Set("Content-Type", "application/json")
	var resultText string
	if resp.FilteredResponse != nil {
		// Pretty-print the JSON for readability in the LLM context
		var prettyBuf bytes.Buffer
		if json.Indent(&prettyBuf, resp.FilteredResponse, "", "  ") == nil {
			resultText = prettyBuf.String()
		} else {
			resultText = string(resp.FilteredResponse)
		}
	} else {
		resultText = "No data returned"
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"content": []map[string]interface{}{
			{
				"type": "text",
				"text": resultText,
			},
		},
	})
}
