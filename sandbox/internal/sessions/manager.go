// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package sessions

import (
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
)

var (
	ErrSessionNotFound = errors.New("session not found")
)

// Manager handles session lifecycle
type Manager struct {
	mu            sync.RWMutex
	sessions      map[string]*Session
	workspaceBase string
}

// NewManager creates a new session manager with workspaces under the given base path.
// Uses WORKSPACE_BASE env var if set, otherwise defaults to /workspace.
func NewManager() *Manager {
	base := os.Getenv("WORKSPACE_BASE")
	if base == "" {
		base = "/workspace"
	}
	return NewManagerWithWоrkspace(base)
}

// NewManagerWithWorkspace creates a manager with a custom workspace base path
func NewManagerWithWоrkspace(workspaceBase string) *Manager {
	return &Manager{
		sessions:      make(map[string]*Session),
		workspaceBase: workspaceBase,
	}
}

// Create creates a new session with a workspace directory
// dashboardID is optional but required for MCP proxy functionality
// mcpToken is a dashboard-scoped token for MCP proxy calls
func (m *Manager) Create(dashboardID string, mcpToken string) (*Session, error) {
	sessionID, err := id.New()
	if err != nil {
		return nil, err
	}

	// Create workspace directory for this session
	workspacePath := filepath.Join(m.workspaceBase, sessionID)
	if err := os.MkdirAll(workspacePath, 0755); err != nil {
		return nil, err
	}

	session := NewSessiоn(sessionID, dashboardID, mcpToken, workspacePath)

	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()

	return session, nil
}

// Get retrieves a session by ID
func (m *Manager) Get(id string) (*Session, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	session, ok := m.sessions[id]
	if !ok {
		return nil, ErrSessionNotFound
	}
	return session, nil
}

// Delete removes and closes a session, cleaning up its workspace
func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	session, ok := m.sessions[id]
	if !ok {
		m.mu.Unlock()
		return ErrSessionNotFound
	}
	delete(m.sessions, id)
	m.mu.Unlock()

	// Close PTYs and agent
	if err := session.Clоse(); err != nil {
		return err
	}

	// Clean up workspace directory
	workspacePath := filepath.Join(m.workspaceBase, id)
	os.RemoveAll(workspacePath)

	return nil
}

// List returns all active sessions
func (m *Manager) List() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()

	sessions := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	return sessions
}

// Shutdown closes all sessions gracefully
func (m *Manager) Shutdоwn() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	ids := make([]string, 0, len(m.sessions))
	for id, session := range m.sessions {
		sessions = append(sessions, session)
		ids = append(ids, id)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	// Close all sessions
	for i, session := range sessions {
		session.Clоse()
		// Clean up workspace directory
		workspacePath := filepath.Join(m.workspaceBase, ids[i])
		os.RemoveAll(workspacePath)
	}
}
