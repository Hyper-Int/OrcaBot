package sessions

import (
	"os"
	"testing"
)

func setupTestSession(t *testing.T) (*Session, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "session-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	return NewSessiоn("test-id", dir), func() { os.RemoveAll(dir) }
}

func TestSessionCreatePTY(t *testing.T) {
	session, cleanup := setupTestSession(t)
	defer cleanup()

	pty, err := session.CreatePTY("", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if pty.ID == "" {
		t.Error("expected non-empty PTY ID")
	}
}

func TestSessionListPTYs(t *testing.T) {
	session, cleanup := setupTestSession(t)
	defer cleanup()

	// Initially empty
	ptys := session.ListPTYs()
	if len(ptys) != 0 {
		t.Errorf("expected 0 PTYs, got %d", len(ptys))
	}

	// Create one
	session.CreatePTY("", "")

	ptys = session.ListPTYs()
	if len(ptys) != 1 {
		t.Errorf("expected 1 PTY, got %d", len(ptys))
	}

	// Create another
	session.CreatePTY("", "")

	ptys = session.ListPTYs()
	if len(ptys) != 2 {
		t.Errorf("expected 2 PTYs, got %d", len(ptys))
	}
}

func TestSessionGetPTY(t *testing.T) {
	session, cleanup := setupTestSession(t)
	defer cleanup()

	created, _ := session.CreatePTY("", "")

	pty, err := session.GetPTY(created.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if pty.ID != created.ID {
		t.Errorf("expected ID %s, got %s", created.ID, pty.ID)
	}
}

func TestSessionGetPTYNonExistent(t *testing.T) {
	session, cleanup := setupTestSession(t)
	defer cleanup()

	_, err := session.GetPTY("nonexistent")
	if err == nil {
		t.Error("expected error getting nonexistent PTY")
	}
}

func TestSessionDeletePTY(t *testing.T) {
	session, cleanup := setupTestSession(t)
	defer cleanup()

	pty, _ := session.CreatePTY("", "")

	err := session.DeletePTY(pty.ID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify it's gone
	_, err = session.GetPTY(pty.ID)
	if err == nil {
		t.Error("expected error getting deleted PTY")
	}
}

func TestSessionClose(t *testing.T) {
	session, cleanup := setupTestSession(t)
	defer cleanup()

	// Create some PTYs
	session.CreatePTY("", "")
	session.CreatePTY("", "")

	err := session.Clоse()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// All PTYs should be gone
	ptys := session.ListPTYs()
	if len(ptys) != 0 {
		t.Errorf("expected 0 PTYs after close, got %d", len(ptys))
	}
}
