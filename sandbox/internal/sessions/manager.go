// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package sessions

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/broker"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/geminishim"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
)

var (
	ErrSessionNotFound = errors.New("session not found")
)

// DefaultBrokerPort is the port used for the secrets broker.
// Each sandbox VM runs one broker shared by all sessions.
const DefaultBrokerPort = 8082

// DefaultGeminiShimPort is the port for the Gemini→OpenRouter translation shim.
// Each sandbox VM runs one shim shared by all sessions (see internal/geminishim).
const DefaultGeminiShimPort = 8086

// Manager handles session lifecycle
type Manager struct {
	mu            sync.RWMutex
	sessions      map[string]*Session
	workspaceBase string

	// Shared secrets broker for all sessions
	broker     *broker.SecretsBroker
	brokerPort int

	// Shared Gemini→OpenRouter translation shim (one per VM).
	geminiShimPort int

	// Egress proxy port: forwarded to sessions so Chromium is proxied when >0.
	// Set via SetEgressProxyPort before any sessions are created.
	// REVISION: browser-v7-proxy-server
	egressProxyPort int
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
		sessions:       make(map[string]*Session),
		workspaceBase:  workspaceBase,
		broker:         b,
		brokerPort:     brokerPort,
		geminiShimPort: DefaultGeminiShimPort,
	}

	// Start the broker in the background (singleton for all sessions)
	go func() {
		if err := b.Start(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintf(os.Stderr, "Warning: failed to start secrets broker: %v\n", err)
		}
	}()

	// Start the Gemini→OpenRouter translation shim (singleton for all sessions).
	// It forwards translated requests through the broker so the OpenRouter key
	// is injected server-side and never reaches the Gemini CLI.
	shim := geminishim.New(DefaultGeminiShimPort, brokerPort)
	go func() {
		if err := shim.Start(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintf(os.Stderr, "Warning: failed to start gemini shim: %v\n", err)
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

// SetEgressProxyPort configures the egress proxy port forwarded to all sessions
// created after this call. Call once from main() when EGRESS_PROXY_ENABLED=true.
// REVISION: browser-v7-proxy-server
func (m *Manager) SetEgressProxyPort(port int) {
	m.mu.Lock()
	m.egressProxyPort = port
	m.mu.Unlock()
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

	session := NewSessiоn(sessionID, dashboardID, mcpToken, m.workspaceBase, m.broker, m.brokerPort, m.egressProxyPort)
	session.geminiShimPort = m.geminiShimPort

	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()

	// REVISION: browser-prewarm-v1
	// Pre-warm chromium in the background so the browser is ready (~instant) when the
	// user or an agent first opens it, instead of paying chromium's ~25s cold boot on
	// demand. One sandbox session per VM, so this warms one browser per VM. On by
	// default; set BROWSER_PREWARM=false to disable (saves ~250-350MB idle RAM/VM).
	// A short delay yields CPU to the initial terminal/agent launch first (chromium
	// boot is heavy and the VM has only 2 vCPUs).
	if browserPrewarmEnabled() {
		go func(s *Session) {
			time.Sleep(3 * time.Second)
			// Skip if the session was deleted during the delay, so we don't start an
			// orphan chromium on a torn-down session (Session.Close stops the browser,
			// but only if it was already created).
			if _, err := m.Get(s.ID); err != nil {
				return
			}
			if _, err := s.StartBrowser(); err != nil {
				log.Printf("[browser][prewarm] session %s: failed: %v", s.ID, err)
			} else {
				log.Printf("[browser][prewarm] session %s: started", s.ID)
			}
		}(session)
	}

	return session, nil
}

// browserPrewarmEnabled reports whether chromium should be pre-warmed at session
// creation. Defaults to ON; BROWSER_PREWARM=false/0/no/off disables it.
func browserPrewarmEnabled() bool {
	switch strings.TrimSpace(strings.ToLower(os.Getenv("BROWSER_PREWARM"))) {
	case "false", "0", "no", "off":
		return false
	default:
		return true
	}
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
