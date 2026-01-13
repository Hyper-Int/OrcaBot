package sessions

import (
	"os"
	"testing"
)

func setupTestManager(t *testing.T) (*Manager, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "manager-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	return NewManagerWithWorkspace(dir), func() { os.RemoveAll(dir) }
}

func TestManagerCreate(t *testing.T) {
	m, cleanup := setupTestManager(t)
	defer cleanup()

	session, err := m.Create()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if session.ID == "" {
		t.Error("expected non-empty session ID")
	}

	// Verify we can retrieve it
	retrieved, err := m.Get(session.ID)
	if err != nil {
		t.Fatalf("failed to get session: %v", err)
	}
	if retrieved.ID != session.ID {
		t.Errorf("expected ID %s, got %s", session.ID, retrieved.ID)
	}
}

func TestManagerDelete(t *testing.T) {
	m, cleanup := setupTestManager(t)
	defer cleanup()

	session, _ := m.Create()

	err := m.Delete(session.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify it's gone
	_, err = m.Get(session.ID)
	if err == nil {
		t.Error("expected error getting deleted session")
	}
}

func TestManagerDeleteNonExistent(t *testing.T) {
	m, cleanup := setupTestManager(t)
	defer cleanup()

	err := m.Delete("nonexistent")
	if err == nil {
		t.Error("expected error deleting nonexistent session")
	}
}

func TestManagerGetNonExistent(t *testing.T) {
	m, cleanup := setupTestManager(t)
	defer cleanup()

	_, err := m.Get("nonexistent")
	if err == nil {
		t.Error("expected error getting nonexistent session")
	}
}

func TestManagerConcurrentAccess(t *testing.T) {
	m, cleanup := setupTestManager(t)
	defer cleanup()

	// Create multiple sessions concurrently
	done := make(chan bool)
	for i := 0; i < 100; i++ {
		go func() {
			session, err := m.Create()
			if err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			_, err = m.Get(session.ID)
			if err != nil {
				t.Errorf("failed to get session: %v", err)
			}
			done <- true
		}()
	}

	for i := 0; i < 100; i++ {
		<-done
	}
}
