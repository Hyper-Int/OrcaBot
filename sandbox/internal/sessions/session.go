// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: session-v22-pool-empty-mcp-env

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
	"regexp"
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

const sessionRevision = "session-v22-pool-empty-mcp-env"

// Allow UUID-style IDs and internal random IDs while rejecting shell metacharacters.
// This protects shell-interpolated call sites (e.g. Claude apiKeyHelper command).
var ptyIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func init() {
	log.Printf("[session] REVISION: %s loaded at %s", sessionRevision, time.Now().Format(time.RFC3339))
}

// applyEgressProxyEnv injects proxy vars when the egress proxy is globally enabled
// (ORCABOT_EGRESS_PROXY_URL set by main.go via EGRESS_PROXY_ENABLED=true).
// Per-session opt-in has been removed; the env var is the single gate.
func applyEgressProxyEnv(envVars map[string]string) {
	proxyURL := strings.TrimSpace(os.Getenv("ORCABOT_EGRESS_PROXY_URL"))
	if proxyURL == "" {
		delete(envVars, "HTTP_PROXY")
		delete(envVars, "HTTPS_PROXY")
		delete(envVars, "http_proxy")
		delete(envVars, "https_proxy")
		delete(envVars, "NO_PROXY")
		delete(envVars, "no_proxy")
		return
	}
	envVars["HTTP_PROXY"] = proxyURL
	envVars["HTTPS_PROXY"] = proxyURL
	envVars["http_proxy"] = proxyURL
	envVars["https_proxy"] = proxyURL
	// 127.0.0.0/8 covers the full IPv4 loopback range (consistent with iptables ! -d 127.0.0.0/8).
	// curl and wget honour CIDR notation; the proxy-side isLocalhost() uses net.IP.IsLoopback()
	// as the authoritative gate for clients that send non-127.0.0.1 loopback addresses.
	// REVISION: session-v22-pool-empty-mcp-env
	envVars["NO_PROXY"] = "127.0.0.0/8,::1,localhost"
	envVars["no_proxy"] = "127.0.0.0/8,::1,localhost"
}

var (
	ErrPTYNotFound  = errors.New("pty not found")
	ErrInvalidPTYID = errors.New("invalid pty id")
	ErrAgentExists  = errors.New("agent already exists")
	ErrNoAgent      = errors.New("no agent in session")
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

	// Gemini→OpenRouter translation shim port (one shim per VM). Set by the
	// manager in Create; 0 means the shim is unavailable (Gemini OpenRouter off).
	geminiShimPort int

	// Egress proxy port: when >0, browser controller routes Chromium through the proxy.
	// REVISION: browser-v7-proxy-server
	egressProxyPort int

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

	// Per-PTY dedicated tokens for Claude apiKeyHelper endpoint.
	// Separate from mcpSecrets so they can only be used for one purpose.
	// REVISION: claude-api-key-token-v1
	apiKeyTokens   map[string]string // ptyID -> random token
	apiKeyTokensMu sync.RWMutex

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
// egressProxyPort: when >0, the browser controller routes all Chromium traffic
// through that port so redirects/subresources are subject to egress approval.
// REVISION: browser-v7-proxy-server
func NewSessiоn(id string, dashboardID string, mcpToken string, workspaceRoot string, sharedBroker *broker.SecretsBroker, brokerPort int, egressProxyPort int) *Session {
	s := &Session{
		ID:                id,
		DashboardID:       dashboardID,
		MCPToken:          mcpToken,
		ptys:              make(map[string]*PTYInfo),
		workspace:         fs.NewWоrkspace(workspaceRoot),
		broker:            sharedBroker,
		brokerPort:        brokerPort,
		egressProxyPort:   egressProxyPort,
		secrets:           make(map[string]string),
		integrationTokens: make(map[string]string), // REVISION: integration-tokens-v1-storage
		mcpSecrets:        make(map[string]string), // REVISION: mcp-secret-v1-nonce
		apiKeyTokens:      make(map[string]string), // REVISION: claude-api-key-token-v1
		executionIDs:      make(map[string]string), // REVISION: server-side-cron-v1-execution-tracking
		knownProviders:    make(map[string]map[string]bool),
		stateCache:        statecache.NewCache(workspaceRoot),
	}

	// Wire up broker callback to notify control plane of pending domain approvals
	// The callback receives sessionID from the broker (stored in provider config)
	if s.broker != nil {
		s.broker.SetOnApprovalNeeded(func(sessionID, secretName, domain string) {
			go notifyApprovalNeeded(sessionID, secretName, domain)
		})
	}

	// Initialize state cache: load from disk and sync from server
	// REVISION: state-cache-v3-wired
	if err := s.stateCache.Load(); err != nil {
		log.Printf("[session] Failed to load state cache: dashboardID=%s session=%s err=%v", s.DashboardID, s.ID, err)
	}

	// Sync from server in background if we have a token
	if mcpToken != "" {
		go func() {
			controlPlaneURL := os.Getenv("CONTROLPLANE_URL")
			if controlPlaneURL != "" {
				if err := s.stateCache.SyncFromServer(mcpToken, controlPlaneURL); err != nil {
					log.Printf("[session] Failed to sync state cache: dashboardID=%s session=%s err=%v", s.DashboardID, s.ID, err)
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

// GeminiShimPort returns the port of the Gemini→OpenRouter translation shim, or 0.
func (s *Session) GeminiShimPort() int {
	return s.geminiShimPort
}

// Workspace returns the session's filesystem workspace
func (s *Session) Wоrkspace() *fs.Workspace {
	return s.workspace
}

func (s *Session) StartBrowser() (browser.Status, error) {
	s.mu.Lock()
	if s.browser == nil {
		s.browser = browser.NewControllerWithEgress(s.workspace.Root(), s.egressProxyPort)
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
		s.browser = browser.NewControllerWithEgress(s.workspace.Root(), s.egressProxyPort)
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
// Thin wrapper over CreatePTYWithOptions (the canonical entry point) for the
// no-options path used by tests and the no-opts branch of handleCreatePTY. This
// keeps a single PTY-creation code path so behaviour (e.g. clearing a stale
// OpenRouter model from .claude/settings.local.json) can't drift between them.
// REVISION: model-selection-v3-createpty-delegates
func (s *Session) CreatePTY(creatorID string, command string, workingDir string) (*PTYInfo, error) {
	return s.CreatePTYWithOptions(CreatePTYOptions{
		CreatorID:  creatorID,
		Command:    command,
		WorkingDir: workingDir,
	})
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
	// Verify directory exists. Per-dashboard isolation is handled by rooting the whole
	// session at /workspace/<dashboardID> (see manager.Create), so an arbitrary missing
	// sub-path here is a genuine bad path (e.g. a typo) and must still error — we do NOT
	// auto-create arbitrary user-supplied dirs.
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

// CreatePTYOptions bundles optional parameters for PTY creation.
type CreatePTYOptions struct {
	CreatorID        string
	Command          string
	PtyID            string
	IntegrationToken string
	WorkingDir       string
	ModelSelection   *ModelSelection
}

// CreatePTYWithOptions is the canonical PTY creation entry point. CreatePTY is
// a thin wrapper for the no-options path used by tests.
// REVISION: model-selection-v1-openrouter
func (s *Session) CreatePTYWithOptions(opts CreatePTYOptions) (*PTYInfo, error) {
	creatorID := opts.CreatorID
	command := opts.Command
	ptyID := opts.PtyID
	integrationToken := opts.IntegrationToken
	workingDir := opts.WorkingDir
	modelSelection := opts.ModelSelection
	// Use provided ID or generate new one
	var err error
	if ptyID == "" {
		ptyID, err = id.New()
		if err != nil {
			return nil, fmt.Errorf("failed to generate PTY ID: %w", err)
		}
	} else if !ptyIDPattern.MatchString(ptyID) {
		return nil, fmt.Errorf("%w: must match %s", ErrInvalidPTYID, ptyIDPattern.String())
	}

	// Per-PTY MCP auth nonce: only generated in non-pool mode.
	var mcpSecret string
	if pty.GetPool() == nil {
		var secretErr error
		mcpSecret, secretErr = id.New()
		if secretErr != nil {
			return nil, fmt.Errorf("failed to generate MCP secret: %w", secretErr)
		}
		s.mcpSecretsMu.Lock()
		s.mcpSecrets[ptyID] = mcpSecret
		s.mcpSecretsMu.Unlock()
	}

	// Detect agent type BEFORE modifying command with cd prefix
	// This ensures MCP settings and hooks are still generated correctly
	agentType := mcp.DetectAgentType(command)

	// Codex ignores OPENAI_BASE_URL/OPENAI_MODEL; route OpenRouter via CLI flags.
	// Must run before the cd prefix so the flags attach to the codex invocation.
	// REVISION: model-selection-v4-codex-cli-flags
	if agentType == mcp.AgentTypeCodex {
		command = buildCodexOpenRouterCommand(command, modelSelection, s.ID, s.BrokerPort())
	}

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
	envVars["DASHBOARD_ID"] = s.DashboardID
	// Claude Code refuses --dangerously-skip-permissions (the "Skip Permissions"
	// toggle) when running as root unless IS_SANDBOX=1. Orcabot PTYs run as root
	// inside an isolated single-tenant VM, so declaring the sandbox is correct —
	// without it, enabling Skip Permissions makes Claude exit instantly, which the
	// reconnect logic turns into a PTY restart loop.
	if agentType == mcp.AgentTypeClaude {
		envVars["IS_SANDBOX"] = "1"
		// REVISION: claude-no-altscreen-v1
		// Force Claude Code's classic inline renderer instead of the full-screen
		// alternate-screen TUI (and skip its one-time "use full screen?" prompt).
		// The alt-screen takeover is disruptive inside the xterm.js terminal block;
		// this env forces classic mode regardless of any saved `tui` setting.
		envVars["CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"] = "1"
	}
	// HOME resolves to a dedicated dir INSIDE the workspace, not the workspace root
	// itself. Keeping ~ under the workspace keeps agent home-dir files self-contained
	// and (being dot-hidden) out of the file sidebar, while cwd stays the workspace
	// project dir. Crucially cwd must NOT equal HOME: opencode's file picker (fff)
	// refuses to run when the project dir IS the home dir ("Can not run certain FFF
	// features in a file system root or home directories"), which sent opencode into a
	// re-init/crash loop. Agent MCP/config is enforced via HOME-independent overrides
	// (GEMINI_CLI_SYSTEM_SETTINGS_PATH, /etc/codex/config.toml, project .mcp.json), so
	// the ~-fallback moving here is harmless.
	homeDir := filepath.Join(s.workspace.Root(), ".home")
	if err := os.MkdirAll(homeDir, 0o2775); err != nil {
		log.Printf("[session] failed to create HOME dir %s: %v (falling back to workspace root)", homeDir, err)
		homeDir = s.workspace.Root()
	} else {
		// Force group-write + setgid past umask so the pty-NNN users (gid=sandbox) can
		// write, and nested files inherit the sandbox group.
		_ = os.Chmod(homeDir, 0o2775)
	}
	envVars["HOME"] = homeDir
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
	// When pool is active, do NOT set ORCABOT_MCP_SECRET in the PTY environment.
	// The privileged Unix socket uses kernel SO_PEERCRED for auth — no secret needed.
	// The secret is still stored in s.mcpSecrets[ptyID] for use by the socket proxy.
	// REVISION: session-v15-uid-pool-unix-socket
	if pty.GetPool() == nil {
		envVars["ORCABOT_MCP_SECRET"] = mcpSecret
	}

	// Inject integration token for policy gateway authentication
	if integrationToken != "" {
		envVars["ORCABOT_INTEGRATION_TOKEN"] = integrationToken
	}

	applyEgressProxyEnv(envVars)

	// Apply per-harness OpenRouter env vars when requested. Must come after agentType is
	// known (above) and before the PTY spawns. No-op when modelSelection is nil or default.
	// REVISION: model-selection-v1-openrouter
	applyOpenRouterEnv(envVars, agentType, modelSelection, s.ID, s.BrokerPort(), s.GeminiShimPort())

	// Custom endpoint (Ollama / vLLM / self-hosted / cloud BYO): install a broker
	// customprovider config pointing at the user URL (with the brokered key, if any),
	// then wire the harness env. The broker's built-in forwarding handles the rest.
	// REVISION: model-selection-v6-custom-endpoint
	if modelSelection.IsCustom() {
		key := ""
		if modelSelection.SecretName != "" {
			key = s.broker.GetCustomSecretValue(s.ID, modelSelection.SecretName)
		}
		headerName, headerFormat := "", ""
		if key != "" {
			headerName, headerFormat = "Authorization", "Bearer %s"
		}
		s.broker.SetConfig(broker.ConfigKey(s.ID, customProviderName), &broker.ProviderConfig{
			Name:          customProviderName,
			TargetBaseURL: rewriteCustomBaseURLForDesktop(modelSelection.BaseURL),
			HeaderName:    headerName,
			HeaderFormat:  headerFormat,
			SecretValue:   key,
			SessionID:     s.ID,
		})
		applyCustomEndpointEnv(envVars, agentType, modelSelection, s.ID, s.BrokerPort(), s.GeminiShimPort())
	}

	// Per-PTY config directory: non-pool mode only. Same rationale as CreatePTY.
	// REVISION: session-v22-pool-empty-mcp-env
	if pty.GetPool() == nil {
		orcabotPtyDir := filepath.Join(s.workspace.Root(), ".orcabot", "pty", ptyID)
		if err := os.MkdirAll(orcabotPtyDir, 0750); err == nil {
			os.WriteFile(filepath.Join(orcabotPtyDir, "mcp-url"), []byte(envVars["ORCABOT_MCP_URL"]+"\n"), 0644)
			os.WriteFile(filepath.Join(orcabotPtyDir, "pty-id"), []byte(ptyID+"\n"), 0644)
			os.WriteFile(filepath.Join(orcabotPtyDir, "mcp-secret"), []byte(mcpSecret+"\n"), 0600)
			wrapperScript := fmt.Sprintf("#!/bin/sh\nexec mcp-bridge --mcp-url=%s --pty-id=%s\n",
				envVars["ORCABOT_MCP_URL"], ptyID)
			os.WriteFile(filepath.Join(orcabotPtyDir, "run-bridge"), []byte(wrapperScript), 0755)
		}
	}

	// Allocate pool slot BEFORE writing any workspace config files.
	// Same ordering invariant as CreatePTY — see comment there for rationale.
	// REVISION: session-v22-pool-empty-mcp-env
	cleanupSecretsWithToken := func() {
		s.integrationTokensMu.Lock()
		delete(s.integrationTokens, ptyID)
		s.integrationTokensMu.Unlock()
		s.mcpSecretsMu.Lock()
		delete(s.mcpSecrets, ptyID)
		s.mcpSecretsMu.Unlock()
		s.apiKeyTokensMu.Lock()
		delete(s.apiKeyTokens, ptyID)
		s.apiKeyTokensMu.Unlock()
	}
	var poolSlot *pty.SlotEntry
	if pool := pty.GetPool(); pool != nil {
		var allocErr error
		poolSlot, allocErr = pool.Allocate()
		if allocErr != nil {
			cleanupSecretsWithToken()
			return nil, fmt.Errorf("PTY pool exhausted: %w", allocErr)
		}
		poolSlot.PTYID = ptyID
	}

	// Generate MCP settings file only for the specific agent being launched
	// Use pre-computed agentType (detected before cd prefix was added to command)
	if agentType != mcp.AgentTypeUnknown {
		userTools := s.fetchUserMCPTools()
		// Pool mode: empty mcpEnv — same rationale as CreatePTY.
		// REVISION: session-v22-pool-empty-mcp-env
		mcpEnv := map[string]string{}
		if pty.GetPool() == nil {
			mcpEnv["ORCABOT_SESSION_ID"] = s.ID
			mcpEnv["ORCABOT_MCP_URL"] = envVars["ORCABOT_MCP_URL"]
			mcpEnv["MCP_LOCAL_PORT"] = mcpPort
			mcpEnv["ORCABOT_PTY_ID"] = ptyID
			mcpEnv["ORCABOT_MCP_SECRET"] = mcpSecret
			mcpEnv["ORCABOT_BRIDGE_COMMAND"] = filepath.Join(s.workspace.Root(), ".orcabot", "pty", ptyID, "run-bridge")
		}
		if err := mcp.GenerateSettingsForAgent(s.workspace.Root(), agentType, userTools, mcpEnv); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to generate MCP settings for %s: %v\n", agentType, err)
		}

		// Generate agent stop hooks so we can detect when the agent finishes
		if err := agenthooks.GenerateHooksForAgent(s.workspace.Root(), agentType, s.ID, ptyID); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to generate stop hooks for %s: %v\n", agentType, err)
		}

		// For Claude Code: pick the right Anthropic credential path.
		// REVISION: model-selection-v1-openrouter
		//
		//   OpenRouter selected → broker (openrouter-anthropic) injects Bearer at
		//     URL boundary; ANTHROPIC_BASE_URL was set above. Write the model id
		//     into settings.local.json and strip any leftover apiKeyHelper.
		//   Default + ANTHROPIC_API_KEY brokered → standard apiKeyHelper flow.
		//   Default + no brokered Anthropic key → nothing to do.
		if agentType == mcp.AgentTypeClaude {
			switch {
			case modelSelection.IsOpenRouter():
				if err := agenthooks.SetClaudeModelForOpenRouter(s.workspace.Root(), modelSelection.Model); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to set Claude OpenRouter model: %v\n", err)
				}
			case modelSelection.IsCustom():
				// Custom endpoint via the /av1 shim: the shim takes the model from the
				// URL, so don't write a model id. Pass "" to strip any leftover
				// apiKeyHelper so the placeholder key + shim ANTHROPIC_BASE_URL stand.
				if err := agenthooks.SetClaudeModelForOpenRouter(s.workspace.Root(), ""); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to clear Claude apiKeyHelper for custom: %v\n", err)
				}
			default:
				// Default provider — wipe any leftover OpenRouter model id so the
				// native Anthropic endpoint doesn't see provider-prefixed ids.
				if err := agenthooks.ClearClaudeOpenRouterModel(s.workspace.Root()); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to clear OpenRouter model: %v\n", err)
				}
			}
			// apiKeyHelper is for NATIVE Claude only — not OpenRouter, not custom
			// (both inject auth at the broker URL boundary).
			if !modelSelection.IsOpenRouter() && !modelSelection.IsCustom() && s.broker.GetAnthropicKey(s.ID) != "" {
				if pty.GetPool() != nil {
					if err := agenthooks.SetClaudeApiKeyHelperUnixSocket(s.workspace.Root()); err != nil {
						fmt.Fprintf(os.Stderr, "Warning: failed to set Claude apiKeyHelper (unix-socket): %v\n", err)
					}
					delete(envVars, "ANTHROPIC_API_KEY")
				} else {
					apiKeyToken, tokenErr := id.New()
					if tokenErr == nil {
						s.apiKeyTokensMu.Lock()
						s.apiKeyTokens[ptyID] = apiKeyToken
						s.apiKeyTokensMu.Unlock()
						if err := agenthooks.SetClaudeApiKeyHelper(s.workspace.Root(), s.ID, ptyID, apiKeyToken); err != nil {
							fmt.Fprintf(os.Stderr, "Warning: failed to set Claude apiKeyHelper: %v\n", err)
						}
						delete(envVars, "ANTHROPIC_API_KEY")
					}
				}
			}
		}

		// Gemini CLI overwrites ~/.gemini/settings.json on startup, losing our hooks
		// and UI settings. Point it to a system override file (highest precedence).
		if agentType == mcp.AgentTypeGemini {
			envVars["GEMINI_CLI_SYSTEM_SETTINGS_PATH"] = filepath.Join(s.workspace.Root(), ".orcabot", "gemini-system-settings.json")

			// OpenRouter / custom routing relies on the CLI's GATEWAY auth honoring
			// the shim URL in GOOGLE_GEMINI_BASE_URL. Set the gateway auth fields when
			// OpenRouter or a custom endpoint is selected; clear them otherwise so
			// native auth returns.
			// REVISION: gemini-shim-v1-openrouter-bridge
			if modelSelection.IsOpenRouter() || modelSelection.IsCustom() {
				if err := agenthooks.SetGeminiOpenRouterAuth(s.workspace.Root()); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to set Gemini OpenRouter auth: %v\n", err)
				}
			} else {
				if err := agenthooks.ClearGeminiOpenRouterAuth(s.workspace.Root()); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to clear Gemini OpenRouter auth: %v\n", err)
				}
			}
		}
	}

	// Spawn PTY. Pool slot was allocated before workspace config writes above.
	// REVISION: session-v22-pool-empty-mcp-env
	var p *pty.PTY
	if poolSlot != nil {
		p, err = pty.NewWithCommandEnvIDSlot(poolSlot, s.ID, command, 80, 24, actualWorkDir, envVars)
		if err != nil {
			if pool := pty.GetPool(); pool != nil {
				pool.Release(poolSlot.UID)
			}
			cleanupSecretsWithToken()
			return nil, err
		}
	} else {
		p, err = pty.NewWithCommandEnvID(ptyID, command, 80, 24, actualWorkDir, envVars)
		if err != nil {
			cleanupSecretsWithToken()
			return nil, err
		}
	}

	hub := pty.NewHub(p, creatorID)
	hub.SetWorkspaceRoot(s.workspace.Root())
	hub.SetSecretValues(s.GetSecretValues())

	hub.SetOnStop(func() {
		s.mu.Lock()
		delete(s.ptys, ptyID)
		s.mu.Unlock()
		// Also clean up integration token, MCP secret, and api key token
		s.integrationTokensMu.Lock()
		delete(s.integrationTokens, ptyID)
		s.integrationTokensMu.Unlock()
		s.mcpSecretsMu.Lock()
		delete(s.mcpSecrets, ptyID)
		s.mcpSecretsMu.Unlock()
		s.apiKeyTokensMu.Lock()
		delete(s.apiKeyTokens, ptyID)
		s.apiKeyTokensMu.Unlock()
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

// GetApiKeyToken returns the dedicated Claude apiKeyHelper token for a PTY.
// Returns "" if none was generated (PTY has no brokered Anthropic key).
// REVISION: claude-api-key-token-v1
func (s *Session) GetApiKeyToken(ptyID string) string {
	s.apiKeyTokensMu.RLock()
	defer s.apiKeyTokensMu.RUnlock()
	return s.apiKeyTokens[ptyID]
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
	log.Printf("[session] Drive integration attached: dashboardID=%s session=%s refCount=%d", s.DashboardID, s.ID, s.driveSyncRefCount)

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

	log.Printf("[session] Drive sync started: dashboardID=%s session=%s", s.DashboardID, s.ID)
}

// OnDriveIntegrationDetached decrements the Drive sync reference count.
// When the count reaches zero, sync is stopped and /workspace/drive/ is removed.
func (s *Session) OnDriveIntegrationDetached() {
	s.driveSyncMu.Lock()
	defer s.driveSyncMu.Unlock()

	if s.driveSyncRefCount > 0 {
		s.driveSyncRefCount--
	}
	log.Printf("[session] Drive integration detached: dashboardID=%s session=%s refCount=%d", s.DashboardID, s.ID, s.driveSyncRefCount)

	if s.driveSyncRefCount == 0 && s.driveSyncer != nil {
		s.driveSyncer.Stop()
		s.driveSyncer = nil
		log.Printf("[session] Drive sync stopped and cleaned up: dashboardID=%s session=%s", s.DashboardID, s.ID)
	}
}

// broadcastDriveSyncEvent sends a drive_sync event to all connected PTY hubs.
func (s *Session) broadcastDriveSyncEvent(event drivesync.SyncEvent) {
	data, err := json.Marshal(event)
	if err != nil {
		log.Printf("[session] failed to marshal drive sync event: dashboardID=%s session=%s err=%v", s.DashboardID, s.ID, err)
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
		log.Printf("[session] Drive integration attached via PTY %s: dashboardID=%s session=%s", ptyID, s.DashboardID, s.ID)
		go s.OnDriveIntegrationAttached(ptyToken)
	}

	// Detect detached Drive
	if !curr["google_drive"] && prev["google_drive"] {
		log.Printf("[session] Drive integration detached via PTY %s: dashboardID=%s session=%s", ptyID, s.DashboardID, s.ID)
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
