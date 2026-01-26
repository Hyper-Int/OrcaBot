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
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/agent"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/browser"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/fs"
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
	ID string

	mu        sync.RWMutex
	ptys      map[string]*PTYInfo
	agent     *agent.Controller
	workspace *fs.Workspace
	browser   *browser.Controller
}

// NewSession creates a new session with workspace at the given root
func NewSessiоn(id string, workspaceRoot string) *Session {
	return &Session{
		ID:        id,
		ptys:      make(map[string]*PTYInfo),
		workspace: fs.NewWоrkspace(workspaceRoot),
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

// CreatePTY creates a new PTY in this session.
// If creatorID is provided, they are automatically assigned control.
// If command is empty, the default shell is used.
func (s *Session) CreatePTY(creatorID string, command string) (*PTYInfo, error) {
	envVars := loadEnvFile(filepath.Join(s.workspace.Root(), ".env"))
	if _, ok := envVars["HISTCONTROL"]; !ok {
		envVars["HISTCONTROL"] = "ignorespace"
	}
	envVars["ORCABOT_SESSION_ID"] = s.ID
	// Make ~ resolve to the session workspace so attached assets are UI-manageable.
	envVars["HOME"] = s.workspace.Root()
	if token := os.Getenv("SANDBOX_INTERNAL_TOKEN"); token != "" {
		envVars["ORCABOT_INTERNAL_TOKEN"] = token
	}
	envVars["BROWSER"] = "/usr/local/bin/xdg-open"
	envVars["XDG_OPEN"] = "/usr/local/bin/xdg-open"
	envVars["CHROME_BIN"] = "/usr/bin/chromium"
	p, err := pty.NewWithCommandEnv(command, 80, 24, s.workspace.Root(), envVars)
	if err != nil {
		return nil, err
	}

	hub := pty.NewHub(p, creatorID)

	// Register cleanup callback for when hub auto-stops (idle timeout, PTY closed)
	ptyID := p.ID
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
