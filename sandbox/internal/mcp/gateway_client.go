// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: gateway-client-v4-multi-auth
package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

func init() {
	log.Printf("[gateway-client] REVISION: gateway-client-v4-multi-auth loaded at %s", time.Now().Format(time.RFC3339))
}

// AuthType indicates how to authenticate with the control plane
type AuthType int

const (
	// AuthTypePtyToken uses Bearer Authorization with PTY token (integration token)
	AuthTypePtyToken AuthType = iota
	// AuthTypeDashboardToken uses X-Dashboard-Token header
	AuthTypeDashboardToken
)

// GatewayClient handles communication with the control plane integration gateway
type GatewayClient struct {
	controlPlaneURL string
	httpClient      *http.Client
}

// NewGatewayClient creates a new gateway client
func NewGatewayClient() *GatewayClient {
	url := os.Getenv("CONTROLPLANE_URL")
	if url == "" {
		url = "http://localhost:8787"
	}
	return &GatewayClient{
		controlPlaneURL: url,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Integration represents an attached integration
type Integration struct {
	Provider       string `json:"provider"`
	ActivePolicyID string `json:"activePolicyId,omitempty"`
	AccountEmail   string `json:"accountEmail,omitempty"`
}

// IntegrationsResponse is the response from the integrations listing endpoint
type IntegrationsResponse struct {
	Integrations []Integration `json:"integrations"`
}

// ExecuteRequest is sent to the gateway execute endpoint.
// NOTE: No context field - enforcement context is derived server-side from args
// to prevent the sandbox from spoofing policy-relevant fields.
type ExecuteRequest struct {
	Action string                 `json:"action"`
	Args   map[string]interface{} `json:"args"`
}

// ExecuteResponse is returned from the gateway execute endpoint
type ExecuteResponse struct {
	Allowed          bool            `json:"allowed"`
	Decision         string          `json:"decision"` // "allowed", "denied", "filtered"
	Reason           string          `json:"reason,omitempty"`
	FilteredResponse json.RawMessage `json:"filteredResponse,omitempty"`
	PolicyID         string          `json:"policyId,omitempty"`
	PolicyVersion    int             `json:"policyVersion,omitempty"`

	// Error fields (when request fails)
	Error string `json:"error,omitempty"`
}

// ListIntegrations returns the integrations attached to a terminal
func (c *GatewayClient) ListIntegrations(ptyID, integrationToken string) (*IntegrationsResponse, error) {
	if integrationToken == "" {
		return nil, fmt.Errorf("no integration token available")
	}

	url := fmt.Sprintf("%s/internal/terminals/%s/integrations", c.controlPlaneURL, ptyID)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+integrationToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp ExecuteResponse
		json.NewDecoder(resp.Body).Decode(&errResp)
		if errResp.Error != "" {
			return nil, fmt.Errorf("%s: %s", errResp.Error, errResp.Reason)
		}
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result IntegrationsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// Execute calls the gateway execute endpoint
func (c *GatewayClient) Execute(provider, integrationToken string, req ExecuteRequest) (*ExecuteResponse, error) {
	if integrationToken == "" {
		return nil, fmt.Errorf("no integration token available")
	}

	url := fmt.Sprintf("%s/internal/gateway/%s/execute", c.controlPlaneURL, provider)

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Authorization", "Bearer "+integrationToken)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	var result ExecuteResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	// Return the response regardless of status code
	// The caller should check result.Allowed and result.Error
	return &result, nil
}

// AgentStateResponse is returned from the agent state gateway endpoints
type AgentStateResponse struct {
	// Success fields
	Tasks    []map[string]interface{} `json:"tasks,omitempty"`
	Task     map[string]interface{}   `json:"task,omitempty"`
	Memories []map[string]interface{} `json:"memories,omitempty"`
	Memory   map[string]interface{}   `json:"memory,omitempty"`
	Deleted  bool                     `json:"deleted,omitempty"`

	// Error fields
	Error string `json:"error,omitempty"`
}

// ExecuteAgentState calls the agent state gateway (tasks or memory)
// Deprecated: Use ExecuteAgentStateWithAuth instead
func (c *GatewayClient) ExecuteAgentState(provider, integrationToken string, req ExecuteRequest) (*AgentStateResponse, error) {
	return c.ExecuteAgentStateWithAuth(provider, integrationToken, AuthTypePtyToken, req)
}

// ExecuteAgentStateWithAuth calls the agent state gateway with specified auth type
func (c *GatewayClient) ExecuteAgentStateWithAuth(provider, token string, authType AuthType, req ExecuteRequest) (*AgentStateResponse, error) {
	if token == "" {
		return nil, fmt.Errorf("no token available")
	}

	url := fmt.Sprintf("%s/internal/gateway/%s/execute", c.controlPlaneURL, provider)

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Set auth header based on type
	switch authType {
	case AuthTypePtyToken:
		httpReq.Header.Set("Authorization", "Bearer "+token)
	case AuthTypeDashboardToken:
		httpReq.Header.Set("X-Dashboard-Token", token)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	var result AgentStateResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if result.Error != "" {
		return nil, fmt.Errorf("%s", result.Error)
	}

	return &result, nil
}
