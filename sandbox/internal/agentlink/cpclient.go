// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: agent-link-v2-status-detail

package agentlink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/cpauth"
)

// CPClient calls the control plane's agent-link routes with the dashboard-scoped
// token (cpauth), never INTERNAL_API_TOKEN directly.
type CPClient struct {
	BaseURL string
	HTTP    *http.Client
}

// NewCPClient for the control plane at baseURL (CONTROLPLANE_URL).
func NewCPClient(baseURL string) *CPClient {
	return &CPClient{BaseURL: strings.TrimSuffix(baseURL, "/"), HTTP: &http.Client{Timeout: 20 * time.Second}}
}

func (c *CPClient) do(ctx context.Context, dashboardID, method, path string, body, out any) error {
	if c.BaseURL == "" {
		return fmt.Errorf("no CONTROLPLANE_URL")
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if err := cpauth.Apply(req, dashboardID); err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		// The full URL: which control plane answered is often the problem.
		return fmt.Errorf("%s %s%s: %d %s", method, c.BaseURL, path, resp.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func (c *CPClient) Config(ctx context.Context, dashboardID string) (Config, error) {
	var cfg Config
	err := c.do(ctx, dashboardID, http.MethodGet, "/internal/dashboards/"+url.PathEscape(dashboardID)+"/agent-link/config", nil, &cfg)
	return cfg, err
}

func (c *CPClient) ApproveDevice(ctx context.Context, dashboardID, code string) error {
	return c.do(ctx, dashboardID, http.MethodPost, "/internal/dashboards/"+url.PathEscape(dashboardID)+"/agent-link/approve-device",
		map[string]string{"code": code}, nil)
}

func (c *CPClient) TerminalAgents(ctx context.Context, dashboardID, ptyID string) ([]Agent, error) {
	var out struct {
		Agents []Agent `json:"agents"`
	}
	err := c.do(ctx, dashboardID, http.MethodGet,
		"/internal/dashboards/"+url.PathEscape(dashboardID)+"/terminals/"+url.PathEscape(ptyID)+"/agents", nil, &out)
	return out.Agents, err
}
