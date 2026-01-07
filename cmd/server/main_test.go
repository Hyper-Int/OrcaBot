package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func init() {
	// Set auth environment variables for tests
	os.Setenv("SANDBOX_INTERNAL_TOKEN", "test-api-token-12345")
	os.Setenv("ALLOWED_ORIGINS", "http://localhost:*,http://127.0.0.1:*")
}

func setAuthHeader(req *http.Request) {
	req.Header.Set("Authorization", "Bearer test-api-token-12345")
}

func TestHealthEndpoint(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp["status"] != "ok" {
		t.Errorf("expected status 'ok', got '%s'", resp["status"])
	}
}

func TestCreateSession(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	req := httptest.NewRequest("POST", "/sessions", nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected status 201, got %d", w.Code)
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp["id"] == "" {
		t.Error("expected non-empty session id")
	}
}

func TestDeleteSession(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	// Create a session first
	session, err := sm.Create()
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}

	req := httptest.NewRequest("DELETE", "/sessions/"+session.ID, nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("expected status 204, got %d", w.Code)
	}

	// Verify session is gone
	_, err = sm.Get(session.ID)
	if err == nil {
		t.Error("expected session to be deleted")
	}
}

func TestDeleteNonExistentSession(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	req := httptest.NewRequest("DELETE", "/sessions/nonexistent", nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}
}

func TestListPTYs(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	session, _ := sm.Create()

	req := httptest.NewRequest("GET", "/sessions/"+session.ID+"/ptys", nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp struct {
		PTYs []struct {
			ID string `json:"id"`
		} `json:"ptys"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if len(resp.PTYs) != 0 {
		t.Errorf("expected 0 ptys, got %d", len(resp.PTYs))
	}
}

func TestCreatePTY(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	session, _ := sm.Create()

	req := httptest.NewRequest("POST", "/sessions/"+session.ID+"/ptys", nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Errorf("expected status 201, got %d", w.Code)
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp["id"] == "" {
		t.Error("expected non-empty pty id")
	}

	// Verify PTY is listed
	req = httptest.NewRequest("GET", "/sessions/"+session.ID+"/ptys", nil)
	setAuthHeader(req)
	w = httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	var listResp struct {
		PTYs []struct {
			ID string `json:"id"`
		} `json:"ptys"`
	}
	json.Unmarshal(w.Body.Bytes(), &listResp)
	if len(listResp.PTYs) != 1 {
		t.Errorf("expected 1 pty, got %d", len(listResp.PTYs))
	}
}

func TestCreatePTYNonExistentSession(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	req := httptest.NewRequest("POST", "/sessions/nonexistent/ptys", nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}
}

func TestDeletePTY(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	session, _ := sm.Create()
	pty, _ := session.CreatePTY("")

	req := httptest.NewRequest("DELETE", "/sessions/"+session.ID+"/ptys/"+pty.ID, nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("expected status 204, got %d", w.Code)
	}

	// Verify PTY is gone
	_, err := session.GetPTY(pty.ID)
	if err == nil {
		t.Error("expected PTY to be deleted")
	}

	// Verify list is empty
	req = httptest.NewRequest("GET", "/sessions/"+session.ID+"/ptys", nil)
	setAuthHeader(req)
	w = httptest.NewRecorder()
	server.Handler().ServeHTTP(w, req)

	var listResp struct {
		PTYs []struct{ ID string } `json:"ptys"`
	}
	json.Unmarshal(w.Body.Bytes(), &listResp)
	if len(listResp.PTYs) != 0 {
		t.Errorf("expected 0 ptys after delete, got %d", len(listResp.PTYs))
	}
}

func TestDeletePTYNonExistentSession(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	req := httptest.NewRequest("DELETE", "/sessions/nonexistent/ptys/somePty", nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}
}

func TestDeletePTYNonExistent(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	session, _ := sm.Create()

	req := httptest.NewRequest("DELETE", "/sessions/"+session.ID+"/ptys/nonexistent", nil)
	setAuthHeader(req)
	w := httptest.NewRecorder()

	server.Handler().ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", w.Code)
	}
}
