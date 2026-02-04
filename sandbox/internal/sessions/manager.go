// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package sessions

import (
	"errors"
	"fmt"
	"os"
	"sync"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/broker"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
)

var (
	ErrSessionNotFound = errors.New("session not found")
)

// DefaultBrokerPort is the port used for the secrets broker.
// Each sandbox VM runs one broker shared by all sessions.
const DefaultBrokerPort = 8082

// Manager handles session lifecycle
type Manager struct {
	mu            sync.RWMutex
	sessions      map[string]*Session
	workspaceBase string

	// Shared secrets broker for all sessions
	broker     *broker.SecretsBroker
	brokerPort int
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
	brokerPort := DefaultBrokerPort
	b := broker.NewSecretsBroker(brokerPort)

	m := &Manager{
		sessions:      make(map[string]*Session),
		workspaceBase: workspaceBase,
		broker:        b,
		brokerPort:    brokerPort,
	}

	// Start the broker in the background (singleton for all sessions)
	go func() {
		if err := b.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to start secrets broker: %v\n", err)
		}
	}()

	return m
}

// Broker returns the shared secrets broker.
func (m *Manager) Broker() *broker.SecretsBroker {
	return m.broker
}

// BrokerPort returns the port the shared secrets broker is listening on.
func (m *Manager) BrokerPort() int {
	return m.brokerPort
}

// Create creates a new session with a workspace directory.
// Now that dashboards are 1:1 with sandboxes, the workspace is the base
// directory itself (/workspace) rather than a per-session subdirectory.
// dashboardID is optional but required for MCP proxy functionality
// mcpToken is a dashboard-scoped token for MCP proxy calls
func (m *Manager) Create(dashboardID string, mcpToken string) (*Session, error) {
	sessionID, err := id.New()
	if err != nil {
		return nil, err
	}

	// Ensure workspace base directory exists (shared by all sessions in this VM)
	if err := os.MkdirAll(m.workspaceBase, 0755); err != nil {
		return nil, err
	}

	session := NewSessiоn(sessionID, dashboardID, mcpToken, m.workspaceBase, m.broker, m.brokerPort)

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

	// Workspace is the shared base directory (/workspace) — not removed on session delete.

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
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	// Close all sessions
	for _, session := range sessions {
		session.Clоse()
	}

	// Stop the shared secrets broker
	if m.broker != nil {
		m.broker.Stop()
	}
}
