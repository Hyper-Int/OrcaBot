// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// Package sessions manages session lifecycle.
//
// A Session represents a single sandbox instance - an isolated execution environment
// running on a Fly Machine. Each session has its own:
//   - Workspace directory (/workspace/<session-id>)
//   - Set of PTYs (pseudo-terminals)
//   - Optional coding agent (Claude Code, Codex CLI)
//
// Sessions are ephemeral and single-tenant. When a session is deleted, all associated
// resources (PTYs, agent, workspace files) are cleaned up.
package sessions

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/agent"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/browser"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/fs"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/pty"
)

var (
	ErrPTYNotFound = errors.New("pty not found")
	ErrAgentExists = errors.New("agent already exists")
	ErrNoAgent     = errors.New("no agent in session")
)

// AgentType represents the type of coding agent
type AgentType string

const (
	AgentTypeClaude AgentType = "claude"
	AgentTypeCodex  AgentType = "codex"
)

// PTYInfo contains PTY metadata
type PTYInfo struct {
	ID  string
	Hub *pty.Hub
}

// Session represents a sandbox instance with PTYs and an optional agent.
// Each session maps 1:1 to a Fly Machine and owns all resources within it.
type Session struct {
	ID          string
	DashboardID string // The dashboard this session belongs to (for MCP proxy)
	MCPToken    string // Dashboard-scoped token for MCP proxy calls (replaces INTERNAL_API_TOKEN)

	mu        sync.RWMutex
	ptys      map[string]*PTYInfo
	agent     *agent.Controller
	workspace *fs.Workspace
	browser   *browser.Controller
}

// NewSession creates a new session with workspace at the given root
func NewSessiоn(id string, dashboardID string, mcpToken string, workspaceRoot string) *Session {
	return &Session{
		ID:          id,
		DashboardID: dashboardID,
		MCPToken:    mcpToken,
		ptys:        make(map[string]*PTYInfo),
		workspace:   fs.NewWоrkspace(workspaceRoot),
	}
}

// Workspace returns the session's filesystem workspace
func (s *Session) Wоrkspace() *fs.Workspace {
	return s.workspace
}

func (s *Session) StartBrowser() (browser.Status, error) {
	s.mu.Lock()
	if s.browser == nil {
		s.browser = browser.NewController(s.workspace.Root())
	}
	browserCtrl := s.browser
	s.mu.Unlock()

	return browserCtrl.Start()
}

func (s *Session) StopBrowser() {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl != nil {
		browserCtrl.Stop()
	}
}

func (s *Session) BrowserStatus() browser.Status {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return browser.Status{Running: false}
	}
	return browserCtrl.Status()
}

func (s *Session) OpenBrowserURL(target string) error {
	s.mu.Lock()
	if s.browser == nil {
		s.browser = browser.NewController(s.workspace.Root())
	}
	browserCtrl := s.browser
	s.mu.Unlock()

	if status := browserCtrl.Status(); !status.Running {
		if _, err := browserCtrl.Start(); err != nil {
			return err
		}
	}

	return browserCtrl.OpenURL(target)
}

// BrowserScreenshot captures a screenshot and saves it to the given path
func (s *Session) BrowserScreenshot(outputPath string) (string, error) {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return "", fmt.Errorf("browser not started")
	}
	return browserCtrl.Screenshot(outputPath)
}

// BrowserClick clicks an element by CSS selector
func (s *Session) BrowserClick(selector string) error {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return fmt.Errorf("browser not started")
	}
	return browserCtrl.Click(selector)
}

// BrowserType types text into an element by CSS selector
func (s *Session) BrowserType(selector string, text string) error {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return fmt.Errorf("browser not started")
	}
	return browserCtrl.Type(selector, text)
}

// BrowserEvaluate executes JavaScript and returns the result
func (s *Session) BrowserEvaluate(script string) (string, error) {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return "", fmt.Errorf("browser not started")
	}
	return browserCtrl.Evaluate(script)
}

// BrowserGetContent returns the visible text content of the page
func (s *Session) BrowserGetContent() (string, error) {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return "", fmt.Errorf("browser not started")
	}
	return browserCtrl.GetContent()
}

// BrowserGetHTML returns the full HTML of the page
func (s *Session) BrowserGetHTML() (string, error) {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return "", fmt.Errorf("browser not started")
	}
	return browserCtrl.GetHTML()
}

// BrowserGetURL returns the current page URL
func (s *Session) BrowserGetURL() (string, error) {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return "", fmt.Errorf("browser not started")
	}
	return browserCtrl.GetCurrentURL()
}

// BrowserGetTitle returns the page title
func (s *Session) BrowserGetTitle() (string, error) {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return "", fmt.Errorf("browser not started")
	}
	return browserCtrl.GetTitle()
}

// BrowserWaitForSelector waits for an element to appear
func (s *Session) BrowserWaitForSelector(selector string, timeoutSec int) error {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return fmt.Errorf("browser not started")
	}
	timeout := time.Duration(timeoutSec) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return browserCtrl.WaitForSelector(selector, timeout)
}

// BrowserNavigate navigates to a URL using CDP
func (s *Session) BrowserNavigate(url string) error {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return fmt.Errorf("browser not started")
	}
	return browserCtrl.Navigate(url)
}

// BrowserScroll scrolls the page
func (s *Session) BrowserScroll(x, y int) error {
	s.mu.Lock()
	browserCtrl := s.browser
	s.mu.Unlock()

	if browserCtrl == nil {
		return fmt.Errorf("browser not started")
	}
	return browserCtrl.Scroll(x, y)
}

// fetchUserMCPTools fetches the user's MCP tools from the control plane
func (s *Session) fetchUserMCPTools() []mcp.MCPTool {
	if s.DashboardID == "" {
		return nil
	}

	controlplaneURL := os.Getenv("CONTROLPLANE_URL")
	internalToken := os.Getenv("INTERNAL_API_TOKEN")
	if controlplaneURL == "" || internalToken == "" {
		return nil
	}

	url := fmt.Sprintf("%s/internal/dashboards/%s/mcp-tools", controlplaneURL, s.DashboardID)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("X-Internal-Token", internalToken)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil
	}

	var result struct {
		Tools []struct {
			Name        string                 `json:"name"`
			Description string                 `json:"description"`
			ServerURL   string                 `json:"serverUrl"`
			Transport   string                 `json:"transport"`
			Config      map[string]interface{} `json:"config"`
		} `json:"tools"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil
	}

	tools := make([]mcp.MCPTool, len(result.Tools))
	for i, t := range result.Tools {
		tools[i] = mcp.MCPTool{
			Name:        t.Name,
			Description: t.Description,
			ServerURL:   t.ServerURL,
			Transport:   t.Transport,
			Config:      t.Config,
		}
	}
	return tools
}

// CreatePTY creates a new PTY in this session.
// If creatorID is provided, they are automatically assigned control.
// If command is empty, the default shell is used.
func (s *Session) CreatePTY(creatorID string, command string) (*PTYInfo, error) {
	// Pre-generate PTY ID so we can include it in environment variables
	ptyID, err := id.New()
	if err != nil {
		return nil, fmt.Errorf("failed to generate PTY ID: %w", err)
	}

	envVars := loadEnvFile(filepath.Join(s.workspace.Root(), ".env"))
	if _, ok := envVars["HISTCONTROL"]; !ok {
		envVars["HISTCONTROL"] = "ignorespace"
	}
	envVars["ORCABOT_SESSION_ID"] = s.ID
	envVars["ORCABOT_PTY_ID"] = ptyID
	// Make ~ resolve to the session workspace so attached assets are UI-manageable.
	envVars["HOME"] = s.workspace.Root()
	// Point agents to the localhost-only MCP server (no auth required)
	mcpPort := os.Getenv("MCP_LOCAL_PORT")
	if mcpPort == "" {
		mcpPort = "8081"
	}
	envVars["MCP_LOCAL_PORT"] = mcpPort
	envVars["ORCABOT_MCP_URL"] = "http://localhost:" + mcpPort + "/sessions/" + s.ID + "/mcp"
	envVars["BROWSER"] = "/usr/local/bin/xdg-open"
	envVars["XDG_OPEN"] = "/usr/local/bin/xdg-open"
	envVars["CHROME_BIN"] = "/usr/bin/chromium"

	// Generate MCP settings file only for the specific agent being launched
	// This allows agents to discover the orcabot MCP server and user's MCP tools
	if agentType := mcp.DetectAgentType(command); agentType != mcp.AgentTypeUnknown {
		userTools := s.fetchUserMCPTools()
		if err := mcp.GenerateSettingsForAgent(s.workspace.Root(), agentType, userTools); err != nil {
			// Log but don't fail - settings generation is not critical for PTY creation
			fmt.Fprintf(os.Stderr, "Warning: failed to generate MCP settings for %s: %v\n", agentType, err)
		}
	}

	p, err := pty.NewWithCommandEnvID(ptyID, command, 80, 24, s.workspace.Root(), envVars)
	if err != nil {
		return nil, err
	}

	hub := pty.NewHub(p, creatorID)

	// Register cleanup callback for when hub auto-stops (idle timeout, PTY closed)
	hub.SetOnStop(func() {
		s.mu.Lock()
		delete(s.ptys, ptyID)
		s.mu.Unlock()
	})

	go hub.Run()

	info := &PTYInfo{
		ID:  p.ID,
		Hub: hub,
	}

	s.mu.Lock()
	s.ptys[p.ID] = info
	s.mu.Unlock()

	return info, nil
}

func loadEnvFile(path string) map[string]string {
	content, err := os.ReadFile(path)
	if err != nil {
		return map[string]string{}
	}
	lines := strings.Split(string(content), "\n")
	env := map[string]string{}
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		key, value, ok := strings.Cut(trimmed, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if (value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		if key != "" {
			env[key] = value
		}
	}
	return env
}

// GetPTY retrieves a PTY by ID
func (s *Session) GetPTY(id string) (*PTYInfo, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	info, ok := s.ptys[id]
	if !ok {
		return nil, ErrPTYNotFound
	}
	return info, nil
}

// GetHub retrieves the Hub for a PTY by ID, or nil if not found
func (s *Session) GetHub(id string) *pty.Hub {
	s.mu.RLock()
	defer s.mu.RUnlock()

	info, ok := s.ptys[id]
	if !ok {
		return nil
	}
	return info.Hub
}

// ListPTYs returns all PTYs in this session
func (s *Session) ListPTYs() []*PTYInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	ptys := make([]*PTYInfo, 0, len(s.ptys))
	for _, info := range s.ptys {
		ptys = append(ptys, info)
	}
	return ptys
}

// DeletePTY removes and closes a PTY
func (s *Session) DeletePTY(id string) error {
	s.mu.Lock()
	info, ok := s.ptys[id]
	if !ok {
		s.mu.Unlock()
		return ErrPTYNotFound
	}
	delete(s.ptys, id)
	s.mu.Unlock()

	info.Hub.Stop()
	return nil
}

// Close shuts down all PTYs and agent in this session
func (s *Session) Clоse() error {
	s.mu.Lock()
	ptys := make([]*PTYInfo, 0, len(s.ptys))
	for _, info := range s.ptys {
		ptys = append(ptys, info)
	}
	s.ptys = make(map[string]*PTYInfo)
	agentCtrl := s.agent
	s.agent = nil
	s.mu.Unlock()

	for _, info := range ptys {
		info.Hub.Stop()
	}

	if agentCtrl != nil {
		agentCtrl.Stоp()
	}

	if s.browser != nil {
		s.browser.Stop()
	}

	return nil
}

// StartAgent creates and starts an agent in this session
func (s *Session) StartAgent(agentType AgentType) (*agent.Controller, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.agent != nil {
		return nil, ErrAgentExists
	}

	ac, err := agent.NewCоntrоller(s.ID+"-agent", "", 80, 24)
	if err != nil {
		return nil, err
	}

	s.agent = ac
	return ac, nil
}

// GetAgent returns the session's agent controller
func (s *Session) GetAgent() (*agent.Controller, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.agent == nil {
		return nil, ErrNoAgent
	}
	return s.agent, nil
}

// HasAgent returns true if the session has an agent
func (s *Session) HasAgent() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.agent != nil
}

// StopAgent stops and removes the agent
func (s *Session) StоpAgent() error {
	s.mu.Lock()
	agentCtrl := s.agent
	s.agent = nil
	s.mu.Unlock()

	if agentCtrl == nil {
		return ErrNoAgent
	}

	return agentCtrl.Stоp()
}
