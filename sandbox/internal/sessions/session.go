// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: session-v7-bridge-wrapper

// Package sessions manages session lifecycle.
//
// A Session represents a single sandbox instance - an isolated execution environment
// running on a Fly Machine. Each session has its own:
//   - Workspace directory (/workspace) — shared across all sessions in the VM
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
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/agent"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/agenthooks"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/broker"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/browser"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/drivesync"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/fs"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/pty"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/statecache"
)

const sessionRevision = "session-v7-bridge-wrapper"

func init() {
	log.Printf("[session] REVISION: %s loaded at %s", sessionRevision, time.Now().Format(time.RFC3339))
}

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
//
// SECURITY CRITICAL: Each dashboard gets exactly ONE session/VM. This isolation
// is essential because:
//   - The secrets broker (localhost:8082) holds decrypted API keys for this dashboard
//   - Output redaction uses this session's secret values
//   - Domain approvals are scoped to secrets owned by the dashboard's user
//
// If sessions were ever shared across dashboards, secrets from one dashboard
// would leak to agents/users in another. The control plane enforces this via
// the dashboard_sandboxes table's PRIMARY KEY constraint.
type Session struct {
	ID          string
	DashboardID string // The dashboard this session belongs to (for MCP proxy)
	MCPToken    string // Dashboard-scoped token for MCP proxy calls (replaces INTERNAL_API_TOKEN)

	mu        sync.RWMutex
	ptys      map[string]*PTYInfo
	agent     *agent.Controller
	workspace *fs.Workspace
	browser   *browser.Controller

	// Secrets broker for secure API key handling
	broker     *broker.SecretsBroker
	brokerPort int

	// Secrets tracking for output redaction
	secrets   map[string]string // name -> value (for redaction)
	secretsMu sync.RWMutex

	// Integration tokens for policy gateway authentication (per-PTY)
	// REVISION: integration-tokens-v1-storage
	integrationTokens   map[string]string // ptyID -> JWT token
	integrationTokensMu sync.RWMutex

	// Per-PTY MCP auth nonces: proof-of-possession for localhost MCP requests
	// REVISION: mcp-secret-v1-nonce
	mcpSecrets   map[string]string // ptyID -> random nonce
	mcpSecretsMu sync.RWMutex

	// Execution IDs for schedule/recipe tracking (per-PTY)
	// REVISION: server-side-cron-v1-execution-tracking
	executionIDs   map[string]string // ptyID -> schedule_execution ID
	executionIDsMu sync.RWMutex

	// Drive sync: per-dashboard bidirectional sync with Google Drive
	// REVISION: drivesync-v1
	driveSyncer       *drivesync.Syncer
	driveSyncRefCount int // number of terminals with Drive attached
	driveSyncMu       sync.Mutex

	// Per-PTY integration tracking: used to detect attach/detach of Drive
	knownProviders   map[string]map[string]bool // ptyID -> set of provider names
	knownProvidersMu sync.Mutex

	// State cache for tasks/memory (reduces control plane round-trips)
	// REVISION: state-cache-v3-wired
	stateCache *statecache.Cache
}

// NewSession creates a new session with workspace at the given root.
// The broker is shared across all sessions in this sandbox.
func NewSessiоn(id string, dashboardID string, mcpToken string, workspaceRoot string, sharedBroker *broker.SecretsBroker, brokerPort int) *Session {
	s := &Session{
		ID:                id,
		DashboardID:       dashboardID,
		MCPToken:          mcpToken,
		ptys:              make(map[string]*PTYInfo),
		workspace:         fs.NewWоrkspace(workspaceRoot),
		broker:            sharedBroker,
		brokerPort:        brokerPort,
		secrets:           make(map[string]string),
		integrationTokens: make(map[string]string), // REVISION: integration-tokens-v1-storage
		mcpSecrets:        make(map[string]string), // REVISION: mcp-secret-v1-nonce
		executionIDs:      make(map[string]string), // REVISION: server-side-cron-v1-execution-tracking
		knownProviders:    make(map[string]map[string]bool),
		stateCache:        statecache.NewCache(workspaceRoot),
	}

	// Wire up broker callback to notify control plane of pending domain approvals
	// The callback receives sessionID from the broker (stored in provider config)
	s.broker.SetOnApprovalNeeded(func(sessionID, secretName, domain string) {
		go notifyApprovalNeeded(sessionID, secretName, domain)
	})

	// Initialize state cache: load from disk and sync from server
	// REVISION: state-cache-v3-wired
	if err := s.stateCache.Load(); err != nil {
		log.Printf("[session] Failed to load state cache: %v", err)
	}

	// Sync from server in background if we have a token
	if mcpToken != "" {
		go func() {
			controlPlaneURL := os.Getenv("CONTROLPLANE_URL")
			if controlPlaneURL != "" {
				if err := s.stateCache.SyncFromServer(mcpToken, controlPlaneURL); err != nil {
					log.Printf("[session] Failed to sync state cache: %v", err)
				}
			}
		}()
	}

	return s
}

// notifyApprovalNeeded sends a pending approval request to the control plane.
func notifyApprovalNeeded(sessionID, secretName, domain string) {
	controlplaneURL := os.Getenv("CONTROLPLANE_URL")
	internalToken := os.Getenv("INTERNAL_API_TOKEN")
	if controlplaneURL == "" || internalToken == "" {
		fmt.Fprintf(os.Stderr, "Warning: cannot notify approval needed - missing CONTROLPLANE_URL or INTERNAL_API_TOKEN\n")
		return
	}

	url := fmt.Sprintf("%s/internal/sessions/%s/approval-request", controlplaneURL, sessionID)

	payload := struct {
		SecretName string `json:"secretName"`
		Domain     string `json:"domain"`
	}{
		SecretName: secretName,
		Domain:     domain,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to marshal approval request: %v\n", err)
		return
	}

	req, err := http.NewRequest("POST", url, strings.NewReader(string(body)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to create approval request: %v\n", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", internalToken)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to send approval request: %v\n", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Warning: approval request returned status %d\n", resp.StatusCode)
	}
}

// Broker returns the session's secrets broker for configuration.
func (s *Session) Broker() *broker.SecretsBroker {
	return s.broker
}

// BrokerPort returns the port the secrets broker is listening on.
func (s *Session) BrokerPort() int {
	return s.brokerPort
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
// If workingDir is provided, the PTY starts in that subdirectory of the workspace.
// REVISION: working-dir-v2-fix-agent-detection
func (s *Session) CreatePTY(creatorID string, command string, workingDir string) (*PTYInfo, error) {
	// Pre-generate PTY ID so we can include it in environment variables
	ptyID, err := id.New()
	if err != nil {
		return nil, fmt.Errorf("failed to generate PTY ID: %w", err)
	}

	// Generate per-PTY MCP auth nonce (proof-of-possession for localhost MCP requests)
	// REVISION: mcp-secret-v1-nonce
	mcpSecret, err := id.New()
	if err != nil {
		return nil, fmt.Errorf("failed to generate MCP secret: %w", err)
	}
	s.mcpSecretsMu.Lock()
	s.mcpSecrets[ptyID] = mcpSecret
	s.mcpSecretsMu.Unlock()

	// Detect agent type BEFORE modifying command with cd prefix
	// This ensures hooks are still generated correctly
	agentType := mcp.DetectAgentType(command)

	// Compute and validate working directory
	actualWorkDir := s.workspace.Root()
	if workingDir != "" {
		actualWorkDir, err = s.resolveWorkingDir(workingDir)
		if err != nil {
			return nil, err
		}
		// For agent commands, prefix with cd to ensure correct working directory
		// This fixes agents like Codex that don't respect inherited PTY cwd
		if command != "" && agentType != mcp.AgentTypeUnknown {
			command = fmt.Sprintf("cd %q && %s", actualWorkDir, command)
		}
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
	// Set DISPLAY so CLIs that check for a graphical environment (e.g., Gemini CLI's
	// shouldAttemptBrowserLaunch) will attempt xdg-open instead of falling back to
	// "copy this URL" mode. The value doesn't need a real X server — our xdg-open
	// wrapper intercepts the call and routes it to the browser block.
	envVars["DISPLAY"] = ":0"
	envVars["ORCABOT_MCP_SECRET"] = mcpSecret

	// Write MCP config to per-PTY files so mcp-bridge can discover them
	// even when agents (like Codex) don't forward env vars to subprocesses.
	// REVISION: mcp-files-v4-wrapper-script
	orcabotPtyDir := filepath.Join(s.workspace.Root(), ".orcabot", "pty", ptyID)
	if err := os.MkdirAll(orcabotPtyDir, 0700); err == nil {
		os.WriteFile(filepath.Join(orcabotPtyDir, "mcp-url"), []byte(envVars["ORCABOT_MCP_URL"]+"\n"), 0644)
		os.WriteFile(filepath.Join(orcabotPtyDir, "pty-id"), []byte(ptyID+"\n"), 0644)
		os.WriteFile(filepath.Join(orcabotPtyDir, "mcp-secret"), []byte(mcpSecret+"\n"), 0600)
		// Compatibility pointer for agents that don't pass PTY ID to subprocesses.
		os.WriteFile(filepath.Join(s.workspace.Root(), ".orcabot", "pty-id"), []byte(ptyID+"\n"), 0644)
		// Per-PTY wrapper script: embeds MCP config in the command itself.
		// This is the most reliable mechanism — the `command` field is universally
		// supported by all MCP clients, unlike args/env which some clients don't forward.
		wrapperScript := fmt.Sprintf("#!/bin/sh\nexec mcp-bridge --mcp-url=%s --pty-id=%s --mcp-secret=%s\n",
			envVars["ORCABOT_MCP_URL"], ptyID, mcpSecret)
		os.WriteFile(filepath.Join(orcabotPtyDir, "run-bridge"), []byte(wrapperScript), 0755)
	}

	// Generate MCP settings for the specific agent being launched (if detected).
	// IMPORTANT: Do NOT use GenerateSettings (all agents) here — that overwrites
	// ALL agent settings files (Gemini, Claude, Codex, etc.) with this PTY's
	// credentials, breaking MCP secret auth for already-running agents.
	// REVISION: mcp-settings-v1-no-overwrite-all
	userTools := s.fetchUserMCPTools()
	mcpEnv := map[string]string{
		"ORCABOT_SESSION_ID":      s.ID,
		"ORCABOT_MCP_URL":         envVars["ORCABOT_MCP_URL"],
		"MCP_LOCAL_PORT":           mcpPort,
		"ORCABOT_PTY_ID":           ptyID,
		"ORCABOT_MCP_SECRET":       mcpSecret,
		"ORCABOT_BRIDGE_COMMAND":   filepath.Join(orcabotPtyDir, "run-bridge"),
	}
	if agentType != mcp.AgentTypeUnknown {
		if err := mcp.GenerateSettingsForAgent(s.workspace.Root(), agentType, userTools, mcpEnv); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to generate MCP settings for %s: %v\n", agentType, err)
		}
	}

	// Generate agent stop hooks only for the specific agent being launched
	// (hooks are agent-specific and should only be created when needed)
	// Use pre-computed agentType (detected before cd prefix was added to command)
	if agentType != mcp.AgentTypeUnknown {
		if err := agenthooks.GenerateHooksForAgent(s.workspace.Root(), agentType, s.ID, ptyID); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to generate stop hooks for %s: %v\n", agentType, err)
		}

		// Gemini CLI overwrites ~/.gemini/settings.json on startup, losing our hooks
		// and UI settings. Point it to a system override file (highest precedence).
		if agentType == mcp.AgentTypeGemini {
			envVars["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = filepath.Join(s.workspace.Root(), ".orcabot", "gemini-system-settings.json")
		}
	}

	p, err := pty.NewWithCommandEnvID(ptyID, command, 80, 24, actualWorkDir, envVars)
	if err != nil {
		return nil, err
	}

	hub := pty.NewHub(p, creatorID)
	hub.SetWorkspaceRoot(s.workspace.Root())

	// Set secret values for output redaction
	hub.SetSecretValues(s.GetSecretValues())

	// Register cleanup callback for when hub auto-stops (idle timeout, PTY closed)
	hub.SetOnStop(func() {
		s.mu.Lock()
		delete(s.ptys, ptyID)
		s.mu.Unlock()
		// Clean up MCP secret
		s.mcpSecretsMu.Lock()
		delete(s.mcpSecrets, ptyID)
		s.mcpSecretsMu.Unlock()
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

// resolveWorkingDir validates and resolves a working directory path.
// Returns the full path within the workspace, or an error if invalid.
// REVISION: working-dir-v2-strip-leading-slash
func (s *Session) resolveWorkingDir(workingDir string) (string, error) {
	// Strip leading slashes to be lenient with user input (e.g., "/test" -> "test")
	workingDir = strings.TrimLeft(workingDir, "/")
	if workingDir == "" {
		return s.workspace.Root(), nil
	}
	// Security: validate path is within workspace (no traversal attacks)
	cleaned := filepath.Clean(workingDir)
	if strings.HasPrefix(cleaned, "..") {
		return "", fmt.Errorf("invalid working directory: must be relative path within workspace")
	}
	actualWorkDir := filepath.Join(s.workspace.Root(), cleaned)
	// Verify directory exists
	info, err := os.Stat(actualWorkDir)
	if os.IsNotExist(err) {
		return "", fmt.Errorf("working directory does not exist: %s", workingDir)
	}
	if err != nil {
		return "", fmt.Errorf("failed to stat working directory: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("working directory is not a directory: %s", workingDir)
	}
	return actualWorkDir, nil
}

// CreatePTYWithToken creates a new PTY with an optional pre-generated ID and integration token.
// REVISION: working-dir-v2-fix-agent-detection
// If ptyID is provided, it will be used instead of generating a new one.
// If integrationToken is provided, it will be stored and injected into the PTY environment.
func (s *Session) CreatePTYWithToken(creatorID, command, ptyID, integrationToken, workingDir string) (*PTYInfo, error) {
	// Use provided ID or generate new one
	var err error
	if ptyID == "" {
		ptyID, err = id.New()
		if err != nil {
			return nil, fmt.Errorf("failed to generate PTY ID: %w", err)
		}
	}

	// Generate per-PTY MCP auth nonce (proof-of-possession for localhost MCP requests)
	// REVISION: mcp-secret-v1-nonce
	mcpSecret, err := id.New()
	if err != nil {
		return nil, fmt.Errorf("failed to generate MCP secret: %w", err)
	}
	s.mcpSecretsMu.Lock()
	s.mcpSecrets[ptyID] = mcpSecret
	s.mcpSecretsMu.Unlock()

	// Detect agent type BEFORE modifying command with cd prefix
	// This ensures MCP settings and hooks are still generated correctly
	agentType := mcp.DetectAgentType(command)

	// Compute and validate working directory
	actualWorkDir := s.workspace.Root()
	if workingDir != "" {
		actualWorkDir, err = s.resolveWorkingDir(workingDir)
		if err != nil {
			return nil, err
		}
		// For agent commands, prefix with cd to ensure correct working directory
		// This fixes agents like Codex that don't respect inherited PTY cwd
		if command != "" && agentType != mcp.AgentTypeUnknown {
			command = fmt.Sprintf("cd %q && %s", actualWorkDir, command)
		}
	}

	// Store integration token if provided
	if integrationToken != "" {
		s.integrationTokensMu.Lock()
		s.integrationTokens[ptyID] = integrationToken
		s.integrationTokensMu.Unlock()
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
	// Set DISPLAY so CLIs that check for a graphical environment attempt xdg-open
	envVars["DISPLAY"] = ":0"
	envVars["ORCABOT_MCP_SECRET"] = mcpSecret

	// Inject integration token for policy gateway authentication
	if integrationToken != "" {
		envVars["ORCABOT_INTEGRATION_TOKEN"] = integrationToken
	}

	// Write MCP config to per-PTY files so mcp-bridge can discover them
	// even when agents (like Codex) don't forward env vars to subprocesses.
	// REVISION: mcp-files-v4-wrapper-script
	orcabotPtyDir := filepath.Join(s.workspace.Root(), ".orcabot", "pty", ptyID)
	if err := os.MkdirAll(orcabotPtyDir, 0700); err == nil {
		os.WriteFile(filepath.Join(orcabotPtyDir, "mcp-url"), []byte(envVars["ORCABOT_MCP_URL"]+"\n"), 0644)
		os.WriteFile(filepath.Join(orcabotPtyDir, "pty-id"), []byte(ptyID+"\n"), 0644)
		os.WriteFile(filepath.Join(orcabotPtyDir, "mcp-secret"), []byte(mcpSecret+"\n"), 0600)
		// Compatibility pointer for agents that don't pass PTY ID to subprocesses.
		os.WriteFile(filepath.Join(s.workspace.Root(), ".orcabot", "pty-id"), []byte(ptyID+"\n"), 0644)
		// Per-PTY wrapper script: embeds MCP config in the command itself.
		// This is the most reliable mechanism — the `command` field is universally
		// supported by all MCP clients, unlike args/env which some clients don't forward.
		wrapperScript := fmt.Sprintf("#!/bin/sh\nexec mcp-bridge --mcp-url=%s --pty-id=%s --mcp-secret=%s\n",
			envVars["ORCABOT_MCP_URL"], ptyID, mcpSecret)
		os.WriteFile(filepath.Join(orcabotPtyDir, "run-bridge"), []byte(wrapperScript), 0755)
	}

	// Generate MCP settings file only for the specific agent being launched
	// Use pre-computed agentType (detected before cd prefix was added to command)
	if agentType != mcp.AgentTypeUnknown {
		userTools := s.fetchUserMCPTools()
		mcpEnv := map[string]string{
			"ORCABOT_SESSION_ID":      s.ID,
			"ORCABOT_MCP_URL":         envVars["ORCABOT_MCP_URL"],
			"MCP_LOCAL_PORT":           mcpPort,
			"ORCABOT_PTY_ID":           ptyID,
			"ORCABOT_MCP_SECRET":       mcpSecret,
			"ORCABOT_BRIDGE_COMMAND":   filepath.Join(orcabotPtyDir, "run-bridge"),
		}
		if err := mcp.GenerateSettingsForAgent(s.workspace.Root(), agentType, userTools, mcpEnv); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to generate MCP settings for %s: %v\n", agentType, err)
		}

		// Generate agent stop hooks so we can detect when the agent finishes
		// The hooks will call back to our localhost endpoint to trigger WebSocket events
		if err := agenthooks.GenerateHooksForAgent(s.workspace.Root(), agentType, s.ID, ptyID); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to generate stop hooks for %s: %v\n", agentType, err)
		}

		// Gemini CLI overwrites ~/.gemini/settings.json on startup, losing our hooks
		// and UI settings. Point it to a system override file (highest precedence).
		if agentType == mcp.AgentTypeGemini {
			envVars["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = filepath.Join(s.workspace.Root(), ".orcabot", "gemini-system-settings.json")
		}
	}

	p, err := pty.NewWithCommandEnvID(ptyID, command, 80, 24, actualWorkDir, envVars)
	if err != nil {
		return nil, err
	}

	hub := pty.NewHub(p, creatorID)
	hub.SetWorkspaceRoot(s.workspace.Root())
	hub.SetSecretValues(s.GetSecretValues())

	hub.SetOnStop(func() {
		s.mu.Lock()
		delete(s.ptys, ptyID)
		s.mu.Unlock()
		// Also clean up integration token and MCP secret
		s.integrationTokensMu.Lock()
		delete(s.integrationTokens, ptyID)
		s.integrationTokensMu.Unlock()
		s.mcpSecretsMu.Lock()
		delete(s.mcpSecrets, ptyID)
		s.mcpSecretsMu.Unlock()
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

// GetIntegrationToken returns the integration token for a PTY.
// REVISION: integration-tokens-v1-getter
func (s *Session) GetIntegrationToken(ptyID string) string {
	s.integrationTokensMu.RLock()
	defer s.integrationTokensMu.RUnlock()
	return s.integrationTokens[ptyID]
}

// GetMCPSecret returns the MCP auth nonce for a PTY.
// REVISION: mcp-secret-v1-nonce
func (s *Session) GetMCPSecret(ptyID string) string {
	s.mcpSecretsMu.RLock()
	defer s.mcpSecretsMu.RUnlock()
	return s.mcpSecrets[ptyID]
}

// GetStateCache returns the state cache for tasks/memory.
// REVISION: state-cache-v3-getter
func (s *Session) GetStateCache() *statecache.Cache {
	return s.stateCache
}

// SetExecutionID associates a schedule execution ID with a PTY.
// REVISION: server-side-cron-v1-execution-tracking
func (s *Session) SetExecutionID(ptyID, executionID string) {
	s.executionIDsMu.Lock()
	defer s.executionIDsMu.Unlock()
	s.executionIDs[ptyID] = executionID
}

// GetExecutionID returns the schedule execution ID for a PTY (empty string if none).
// REVISION: server-side-cron-v1-execution-tracking
func (s *Session) GetExecutionID(ptyID string) string {
	s.executionIDsMu.RLock()
	defer s.executionIDsMu.RUnlock()
	return s.executionIDs[ptyID]
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
		// Strip "export " prefix if present
		if strings.HasPrefix(trimmed, "export ") {
			trimmed = strings.TrimPrefix(trimmed, "export ")
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
				// Unescape common escape sequences from double-quoted values
				value = strings.ReplaceAll(value, `\$`, `$`)
				value = strings.ReplaceAll(value, `\"`, `"`)
				value = strings.ReplaceAll(value, "\\`", "`")
				value = strings.ReplaceAll(value, `\\`, `\`)
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

	// Notify that this PTY's integrations are gone (triggers Drive sync detach if needed)
	s.NotifyIntegrations(id, nil, "")

	return nil
}

// Close shuts down all PTYs and agent in this session.
// Note: The secrets broker is shared and managed by the Manager, not stopped here.
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

	// Stop Drive sync if running
	s.driveSyncMu.Lock()
	if s.driveSyncer != nil {
		s.driveSyncer.Stop()
		s.driveSyncer = nil
		s.driveSyncRefCount = 0
	}
	s.driveSyncMu.Unlock()

	return nil
}

// ============================================
// Drive Sync Management
// ============================================

// OnDriveIntegrationAttached starts or increments the Drive sync reference count.
// Called when a terminal attaches a Google Drive integration.
// The ptyToken is used for gateway authentication.
func (s *Session) OnDriveIntegrationAttached(ptyToken string) {
	s.driveSyncMu.Lock()
	defer s.driveSyncMu.Unlock()

	s.driveSyncRefCount++
	log.Printf("[session] Drive integration attached (refCount=%d)", s.driveSyncRefCount)

	if s.driveSyncer != nil {
		// Already running — update the token so we don't use a stale one
		s.driveSyncer.UpdateToken(ptyToken)
		return
	}

	// Create a gateway client for the syncer
	gateway := mcp.NewGatewayClient()

	// Create event callback that broadcasts to all connected hubs
	onEvent := func(event drivesync.SyncEvent) {
		s.broadcastDriveSyncEvent(event)
	}

	syncer := drivesync.New(s.workspace.Root(), gateway, ptyToken, onEvent)
	s.driveSyncer = syncer
	syncer.Start()

	log.Printf("[session] Drive sync started")
}

// OnDriveIntegrationDetached decrements the Drive sync reference count.
// When the count reaches zero, sync is stopped and /workspace/drive/ is removed.
func (s *Session) OnDriveIntegrationDetached() {
	s.driveSyncMu.Lock()
	defer s.driveSyncMu.Unlock()

	if s.driveSyncRefCount > 0 {
		s.driveSyncRefCount--
	}
	log.Printf("[session] Drive integration detached (refCount=%d)", s.driveSyncRefCount)

	if s.driveSyncRefCount == 0 && s.driveSyncer != nil {
		s.driveSyncer.Stop()
		s.driveSyncer = nil
		log.Printf("[session] Drive sync stopped and cleaned up")
	}
}

// broadcastDriveSyncEvent sends a drive_sync event to all connected PTY hubs.
func (s *Session) broadcastDriveSyncEvent(event drivesync.SyncEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[session] failed to marshal drive sync event: %v", err)
		return
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, info := range s.ptys {
		info.Hub.BroadcastRawJSON(data)
	}
}

// NotifyIntegrations is called by the MCP server when it fetches the current
// list of integrations for a PTY. It compares with the previously known set
// and triggers Drive sync attach/detach as needed.
func (s *Session) NotifyIntegrations(ptyID string, providers []string, ptyToken string) {
	s.knownProvidersMu.Lock()
	defer s.knownProvidersMu.Unlock()

	prev := s.knownProviders[ptyID]
	if prev == nil {
		prev = make(map[string]bool)
	}

	curr := make(map[string]bool)
	for _, p := range providers {
		curr[p] = true
	}

	// Detect newly attached Drive
	if curr["google_drive"] && !prev["google_drive"] {
		log.Printf("[session] Drive integration attached via PTY %s", ptyID)
		go s.OnDriveIntegrationAttached(ptyToken)
	}

	// Detect detached Drive
	if !curr["google_drive"] && prev["google_drive"] {
		log.Printf("[session] Drive integration detached via PTY %s", ptyID)
		go s.OnDriveIntegrationDetached()
	}

	s.knownProviders[ptyID] = curr
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

// SetSecrets stores secret values for output redaction.
// This should be called when secrets are applied to the session.
func (s *Session) SetSecrets(secrets map[string]string) {
	s.secretsMu.Lock()
	defer s.secretsMu.Unlock()
	s.secrets = secrets

	// Update redaction values in all existing hubs
	values := s.getSecretValuesLocked()
	s.mu.RLock()
	for _, info := range s.ptys {
		info.Hub.SetSecretValues(values)
	}
	s.mu.RUnlock()
}

// GetSecretValues returns secret values for redaction (min 8 chars).
func (s *Session) GetSecretValues() []string {
	s.secretsMu.RLock()
	defer s.secretsMu.RUnlock()
	return s.getSecretValuesLocked()
}

// getSecretValuesLocked returns secret values (caller must hold secretsMu).
func (s *Session) getSecretValuesLocked() []string {
	values := make([]string, 0, len(s.secrets))
	for _, v := range s.secrets {
		if len(v) >= 8 { // Only redact non-trivial values
			values = append(values, v)
		}
	}
	return values
}
