// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: mcp-integration-v23-mcp-secret

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
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/statecache"
)

func init() {
	log.Printf("[mcp-server] REVISION: mcp-integration-v23-mcp-secret loaded at %s", time.Now().Format(time.RFC3339))
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

// validateIntegrationAuth validates the per-PTY MCP secret and looks up the stored
// integration token. The bridge sends X-MCP-Secret (a per-PTY random nonce) as
// proof-of-possession; the integration token itself never leaves server memory.
func validateIntegrationAuth(w http.ResponseWriter, r *http.Request, session interface {
	GetIntegrationToken(string) string
	GetMCPSecret(string) string
}) (ptyID, token string, ok bool) {
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

	// Validate MCP secret (proof-of-possession: prevents cross-PTY impersonation)
	mcpSecret := r.Header.Get("X-MCP-Secret")
	storedSecret := session.GetMCPSecret(ptyID)
	if storedSecret == "" || subtle.ConstantTimeCompare([]byte(mcpSecret), []byte(storedSecret)) != 1 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": "E79839: Invalid MCP authentication",
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
	// IMPORTANT: Use empty slice (not nil) so JSON encodes as [] not null.
	// MCP clients (Gemini) validate that "tools" is an array.
	allTools := make([]interface{}, 0)

	// Look up integration token by pty_id from server memory (broker pattern).
	// The bridge only sends pty_id — the token never leaves this process.
	// Validate MCP secret to prevent cross-PTY impersonation.
	ptyID := r.URL.Query().Get("pty_id")
	if ptyID != "" {
		mcpSecret := r.Header.Get("X-MCP-Secret")
		storedSecret := session.GetMCPSecret(ptyID)
		secretValid := storedSecret != "" && subtle.ConstantTimeCompare([]byte(mcpSecret), []byte(storedSecret)) == 1

		storedToken := session.GetIntegrationToken(ptyID)

		if storedToken != "" && secretValid {
			gatewayClient := mcp.NewGatewayClient()
			integrations, err := gatewayClient.ListIntegrations(ptyID, storedToken)
			if err != nil {
				log.Printf("[mcp-tools] ListTools: ERROR listing integrations: %v", err)
			} else if integrations == nil {
				log.Printf("[mcp-tools] ListTools: ERROR integrations response is nil")
			} else {
				var activeProviders []string
				for _, integration := range integrations.Integrations {
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
		}
	}

	// Add agent state tools (tasks & memory) - ALWAYS available
	agentStateTools := mcp.GetAllAgentStateTools()
	for _, tool := range agentStateTools {
		allTools = append(allTools, map[string]interface{}{
			"name":        tool.Name,
			"description": tool.Description,
			"inputSchema": json.RawMessage(tool.InputSchema),
		})
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
		_, integrationToken, tokenOk := validateIntegrationAuth(w, r, session)
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

	// Check if this is an agent state tool (tasks/memory) - route to gateway
	if mcp.IsAgentStateTool(incomingReq.Name) {
		s.handleAgentStateToolCall(w, r, incomingReq.Name, incomingReq.Arguments)
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
	_, integrationToken, ok := validateIntegrationAuth(w, r, session)
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

// handleAgentStateToolCall handles task and memory tool calls via the gateway
// Agent state tools (tasks/memory) are "always available" - they don't require integration
// attachment or X-Integration-Token. They use the session's MCP token for auth.
func (s *Server) handleAgentStateToolCall(w http.ResponseWriter, r *http.Request, toolName string, args map[string]interface{}) {
	sessionID := r.PathValue("sessionId")
	session := s.getSessiоnOrErrоr(w, sessionID)
	if session == nil {
		return
	}

	// Agent state tools are always available. Session-scoped operations use the
	// stored PTY token (broker pattern — token stays in server memory).
	// Validate MCP secret to prevent cross-PTY impersonation.
	var authToken string
	var authType mcp.AuthType = mcp.AuthTypeDashboardToken // Default to dashboard token
	ptyID := r.URL.Query().Get("pty_id")
	if ptyID != "" {
		mcpSecret := r.Header.Get("X-MCP-Secret")
		storedSecret := session.GetMCPSecret(ptyID)
		secretValid := storedSecret != "" && subtle.ConstantTimeCompare([]byte(mcpSecret), []byte(storedSecret)) == 1

		if secretValid {
			storedToken := session.GetIntegrationToken(ptyID)
			if storedToken != "" {
				authToken = storedToken
				authType = mcp.AuthTypePtyToken
			}
		}
		// If secret invalid or no stored token, fall through to dashboard token
	}

	// Fall back to session MCP token (dashboard-scoped)
	if authToken == "" {
		if session.MCPToken != "" {
			authToken = session.MCPToken
			authType = mcp.AuthTypeDashboardToken
			// When using dashboard token, session-scoped operations are not possible.
			// Strip sessionScoped flag to make behavior explicit and prevent silent failures.
			if sessionScoped, ok := args["sessionScoped"].(bool); ok && sessionScoped {
				log.Printf("[mcp] WARNING: sessionScoped=true requested but no PTY token proof; creating dashboard-wide instead (provide X-Integration-Token for session scope)")
				delete(args, "sessionScoped")
			}
		} else {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error":   true,
				"message": "E79843: No authentication token available for agent state calls",
			})
			return
		}
	}

	// Get provider and action for this tool
	provider := mcp.GetAgentStateToolProvider(toolName)
	action := mcp.GetAgentStateToolAction(toolName)
	if provider == "" || action == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":   true,
			"message": fmt.Sprintf("E79842: Unknown agent state tool: %s", toolName),
		})
		return
	}

	// REVISION: state-cache-v3-wired
	// Check cache for read operations (cache hit saves a round-trip)
	cache := session.GetStateCache()
	const cacheMaxAge = 30 * time.Second // Consider cache fresh for 30s

	if cache != nil && cache.IsFresh(cacheMaxAge) {
		if cached := s.tryServeCachedResponse(w, action, args, cache); cached {
			return
		}
	}

	// Call the agent state gateway with appropriate auth type
	gatewayClient := mcp.NewGatewayClient()
	executeReq := mcp.ExecuteRequest{
		Action: action,
		Args:   args,
	}

	resp, err := gatewayClient.ExecuteAgentStateWithAuth(provider, authToken, authType, executeReq)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"content": []map[string]interface{}{
				{"type": "text", "text": fmt.Sprintf("Error: %v", err)},
			},
			"isError": true,
		})
		return
	}

	// Update cache with successful response
	if cache != nil {
		s.updateCache(cache, action, args, resp)
	}

	// Format the response as JSON text for MCP
	w.Header().Set("Content-Type", "application/json")
	var resultText string

	// Marshal the response to JSON
	respJSON, err := json.MarshalIndent(resp, "", "  ")
	if err != nil {
		resultText = fmt.Sprintf("Error formatting response: %v", err)
	} else {
		resultText = string(respJSON)
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

// tryServeCachedResponse attempts to serve a response from cache for read operations.
// Returns true if response was served from cache, false if cache miss.
// REVISION: state-cache-v6-session-id
func (s *Server) tryServeCachedResponse(w http.ResponseWriter, action string, args map[string]interface{}, cache *statecache.Cache) bool {
	// SECURITY: Never serve session-scoped data from cache.
	// The cache is dashboard-level; session-scoped data must always go to the gateway
	// to ensure proper PTY isolation. Without this check, PTY A's session-scoped memory
	// could leak to PTY B via the shared cache.
	if isSessionScoped(args) {
		log.Printf("[mcp] Skipping cache for %s (sessionScoped=true)", action)
		return false
	}

	switch action {
	case "tasks.list":
		// Skip cache if any filters are present - cache stores unfiltered data
		if hasTaskFilters(args) {
			log.Printf("[mcp] Skipping cache for tasks.list (filters present)")
			return false
		}
		// Get cached tasks and filter appropriately
		allTasks := cache.GetTasks()
		includeCompleted, _ := args["includeCompleted"].(bool)

		// Filter out session-scoped tasks (they belong to specific PTYs) and
		// completed/cancelled tasks (unless explicitly requested)
		// REVISION: state-cache-v6-session-id
		filteredTasks := make([]statecache.TaskEntry, 0, len(allTasks))
		for _, task := range allTasks {
			// Skip session-scoped tasks - they should never be served from dashboard cache
			if isTaskSessionScoped(&task) {
				continue
			}
			// Skip completed/cancelled tasks unless includeCompleted=true
			if !includeCompleted && isTaskCompleted(&task) {
				continue
			}
			filteredTasks = append(filteredTasks, task)
		}

		log.Printf("[mcp] Serving tasks.list from cache (%d tasks, filtered from %d)", len(filteredTasks), len(allTasks))
		s.sendCachedResponse(w, map[string]interface{}{"tasks": filteredTasks})
		return true

	case "tasks.get":
		taskID, ok := args["taskId"].(string)
		if !ok || taskID == "" {
			return false
		}
		task, found := cache.GetTask(taskID)
		if !found {
			return false
		}
		// SECURITY: Never serve session-scoped tasks from cache
		// The task might belong to a different PTY
		if isTaskSessionScoped(&task) {
			log.Printf("[mcp] Skipping cache for tasks.get (task %s is session-scoped)", taskID)
			return false
		}
		log.Printf("[mcp] Serving tasks.get from cache (task %s)", taskID)
		s.sendCachedResponse(w, map[string]interface{}{"task": task})
		return true

	case "memory.get":
		key, ok := args["key"].(string)
		if !ok || key == "" {
			return false
		}
		entry, found := cache.GetMemory(key)
		if !found {
			return false
		}
		log.Printf("[mcp] Serving memory.get from cache (key %s)", key)
		// Match gateway response shape: {memory: {...}}
		s.sendCachedResponse(w, map[string]interface{}{
			"memory": map[string]interface{}{
				"key":        key,
				"value":      entry.Value,
				"memoryType": entry.MemoryType,
				"updatedAt":  entry.UpdatedAt,
			},
		})
		return true

	case "memory.list":
		// Skip cache if any filters are present - cache stores unfiltered data
		if hasMemoryFilters(args) {
			log.Printf("[mcp] Skipping cache for memory.list (filters present)")
			return false
		}
		memories := cache.GetAllMemory()
		log.Printf("[mcp] Serving memory.list from cache (%d entries)", len(memories))
		// Convert to array format expected by clients
		memoryList := make([]map[string]interface{}, 0, len(memories))
		for k, v := range memories {
			memoryList = append(memoryList, map[string]interface{}{
				"key":        k,
				"value":      v.Value,
				"memoryType": v.MemoryType,
				"updatedAt":  v.UpdatedAt,
			})
		}
		s.sendCachedResponse(w, map[string]interface{}{"memories": memoryList})
		return true
	}

	return false // Not a cacheable action
}

// hasTaskFilters returns true if the args contain any task filters
func hasTaskFilters(args map[string]interface{}) bool {
	filterKeys := []string{"status", "includeCompleted", "ownerAgent", "priority", "sessionScoped"}
	for _, key := range filterKeys {
		if v, ok := args[key]; ok && v != nil {
			// Check for non-empty/non-default values
			switch val := v.(type) {
			case string:
				if val != "" {
					return true
				}
			case bool:
				// includeCompleted=true is a filter (default is false)
				if key == "includeCompleted" && val {
					return true
				}
				// sessionScoped=true is a filter
				if key == "sessionScoped" && val {
					return true
				}
			case float64, int:
				return true // any priority filter
			default:
				return true
			}
		}
	}
	return false
}

// hasMemoryFilters returns true if the args contain any memory filters
func hasMemoryFilters(args map[string]interface{}) bool {
	filterKeys := []string{"memoryType", "tags", "prefix", "sessionScoped"}
	for _, key := range filterKeys {
		if v, ok := args[key]; ok && v != nil {
			switch val := v.(type) {
			case string:
				if val != "" {
					return true
				}
			case []interface{}:
				if len(val) > 0 {
					return true
				}
			case bool:
				if key == "sessionScoped" && val {
					return true
				}
			default:
				return true
			}
		}
	}
	return false
}

// sendCachedResponse sends a cached response in MCP format
func (s *Server) sendCachedResponse(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	respJSON, _ := json.MarshalIndent(data, "", "  ")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"content": []map[string]interface{}{
			{
				"type": "text",
				"text": string(respJSON),
			},
		},
	})
}

// updateCache updates the cache based on the action and response
// REVISION: state-cache-v6-session-id
func (s *Server) updateCache(cache *statecache.Cache, action string, args map[string]interface{}, resp *mcp.AgentStateResponse) {
	if resp == nil || cache == nil {
		return
	}

	// SECURITY: Never cache session-scoped data.
	// The cache is dashboard-level; storing session-scoped data would cause it to
	// leak to other PTYs in the same dashboard.
	if isSessionScoped(args) {
		log.Printf("[mcp] Skipping cache update for %s (sessionScoped=true)", action)
		return
	}

	switch action {
	case "tasks.list":
		// Only cache unfiltered task lists
		if hasTaskFilters(args) {
			return
		}
		// Update full task list, but skip session-scoped tasks
		if resp.Tasks != nil {
			tasks := make([]statecache.TaskEntry, 0, len(resp.Tasks))
			for _, t := range resp.Tasks {
				if entry := taskMapToEntry(t); entry != nil {
					// Skip session-scoped tasks - they belong to specific PTYs
					if isTaskSessionScoped(entry) {
						continue
					}
					tasks = append(tasks, *entry)
				}
			}
			cache.SetTasks(tasks)
		}

	case "tasks.create", "tasks.update", "tasks.get":
		// Update single task in cache, but skip session-scoped tasks
		if resp.Task != nil {
			if entry := taskMapToEntry(resp.Task); entry != nil {
				// SECURITY: Don't cache session-scoped tasks
				// The task's sessionId field indicates it belongs to a specific PTY
				if isTaskSessionScoped(entry) {
					log.Printf("[mcp] Skipping cache for task %s (session-scoped)", entry.ID)
					return
				}
				cache.UpdateTask(*entry)
			}
		}

	case "tasks.delete":
		if taskID, ok := args["taskId"].(string); ok && resp.Deleted {
			cache.DeleteTask(taskID)
		}

	case "memory.list":
		// Only cache unfiltered memory lists
		if hasMemoryFilters(args) {
			return
		}
		// Could update memory cache here, but memory.list responses may be large
		// For now, just skip - memory.get will populate cache on demand

	case "memory.set", "memory.get":
		if resp.Memory != nil {
			if entry := memoryMapToEntry(resp.Memory); entry != nil {
				if key, ok := resp.Memory["key"].(string); ok && key != "" {
					cache.SetMemory(key, *entry)
				}
			}
		}

	case "memory.delete":
		if key, ok := args["key"].(string); ok && resp.Deleted {
			cache.DeleteMemory(key)
		}
	}

	// Save cache to disk asynchronously
	go func() {
		if err := cache.Save(); err != nil {
			log.Printf("[mcp] Failed to save cache: %v", err)
		}
	}()
}

// isSessionScoped returns true if the args indicate session-scoped operation
func isSessionScoped(args map[string]interface{}) bool {
	if v, ok := args["sessionScoped"].(bool); ok && v {
		return true
	}
	return false
}

// taskMapToEntry converts a map[string]interface{} to a TaskEntry
// REVISION: state-cache-v7-full-task-schema
func taskMapToEntry(m map[string]interface{}) *statecache.TaskEntry {
	if m == nil {
		return nil
	}

	entry := &statecache.TaskEntry{}

	if v, ok := m["id"].(string); ok {
		entry.ID = v
	}
	if v, ok := m["dashboardId"].(string); ok {
		entry.DashboardID = v
	}
	// SessionID can be null (dashboard-wide) or string (session-scoped)
	if v, ok := m["sessionId"].(string); ok && v != "" {
		entry.SessionID = &v
	}
	// ParentID can be null (top-level) or string (subtask)
	if v, ok := m["parentId"].(string); ok && v != "" {
		entry.ParentID = &v
	}
	if v, ok := m["subject"].(string); ok {
		entry.Subject = v
	}
	if v, ok := m["description"].(string); ok {
		entry.Description = v
	}
	if v, ok := m["status"].(string); ok {
		entry.Status = v
	}
	if v, ok := m["priority"].(float64); ok {
		entry.Priority = int(v)
	}
	if v, ok := m["ownerAgent"].(string); ok {
		entry.OwnerAgent = v
	}
	if v, ok := m["metadata"].(map[string]interface{}); ok {
		entry.Metadata = v
	}
	// BlockedBy and Blocks are arrays of task IDs
	if v, ok := m["blockedBy"].([]interface{}); ok {
		entry.BlockedBy = interfaceSliceToStrings(v)
	}
	if v, ok := m["blocks"].([]interface{}); ok {
		entry.Blocks = interfaceSliceToStrings(v)
	}
	if v, ok := m["createdAt"].(string); ok {
		entry.CreatedAt = v
	}
	if v, ok := m["updatedAt"].(string); ok {
		entry.UpdatedAt = v
	}
	if v, ok := m["startedAt"].(string); ok && v != "" {
		entry.StartedAt = &v
	}
	if v, ok := m["completedAt"].(string); ok && v != "" {
		entry.CompletedAt = &v
	}

	return entry
}

// interfaceSliceToStrings converts []interface{} to []string
func interfaceSliceToStrings(slice []interface{}) []string {
	result := make([]string, 0, len(slice))
	for _, v := range slice {
		if s, ok := v.(string); ok {
			result = append(result, s)
		}
	}
	return result
}

// isTaskSessionScoped returns true if the task has a non-nil sessionId
func isTaskSessionScoped(task *statecache.TaskEntry) bool {
	return task != nil && task.SessionID != nil
}

// isTaskCompleted returns true if the task status is completed or cancelled
func isTaskCompleted(task *statecache.TaskEntry) bool {
	if task == nil {
		return false
	}
	return task.Status == "completed" || task.Status == "cancelled"
}

// memoryMapToEntry converts a map[string]interface{} to a MemoryEntry
func memoryMapToEntry(m map[string]interface{}) *statecache.MemoryEntry {
	if m == nil {
		return nil
	}

	entry := &statecache.MemoryEntry{}

	if v, ok := m["value"]; ok {
		entry.Value = v
	}
	if v, ok := m["memoryType"].(string); ok {
		entry.MemoryType = v
	}
	if v, ok := m["updatedAt"].(string); ok {
		entry.UpdatedAt = v
	}

	return entry
}
