package sessions

import (
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/google/uuid"
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

// NewManager creates a new session manager with workspaces under the given base path
func NewManager() *Manager {
	return NewManagerWithWorkspace("/workspace")
}

// NewManagerWithWorkspace creates a manager with a custom workspace base path
func NewManagerWithWorkspace(workspaceBase string) *Manager {
	return &Manager{
		sessions:      make(map[string]*Session),
		workspaceBase: workspaceBase,
	}
}

// Create creates a new session with a workspace directory
func (m *Manager) Create() (*Session, error) {
	id := uuid.New().String()

	// Create workspace directory for this session
	workspacePath := filepath.Join(m.workspaceBase, id)
	if err := os.MkdirAll(workspacePath, 0755); err != nil {
		return nil, err
	}

	session := NewSession(id, workspacePath)

	m.mu.Lock()
	m.sessions[id] = session
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
	if err := session.Close(); err != nil {
		return err
	}

	// Clean up workspace directory
	workspacePath := filepath.Join(m.workspaceBase, id)
	os.RemoveAll(workspacePath)

	return nil
}

// List returns all session IDs
func (m *Manager) List() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	ids := make([]string, 0, len(m.sessions))
	for id := range m.sessions {
		ids = append(ids, id)
	}
	return ids
}

// Shutdown closes all sessions gracefully
func (m *Manager) Shutdown() {
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
		session.Close()
		// Clean up workspace directory
		workspacePath := filepath.Join(m.workspaceBase, ids[i])
		os.RemoveAll(workspacePath)
	}
}
