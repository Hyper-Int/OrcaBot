package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/hyper-ai-inc/hyper-backend/internal/sessions"
	"github.com/hyper-ai-inc/hyper-backend/internal/ws"
	"github.com/gorilla/websocket"
)

func setupTestManager(t *testing.T) (*sessions.Manager, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "hyper-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	return sessions.NewManagerWithWorkspace(dir), func() { os.RemoveAll(dir) }
}

// TestFullSessionLifecycle tests the complete flow:
// 1. Create session
// 2. Create PTY
// 3. Connect via WebSocket
// 4. Send command and receive output
// 5. Resize terminal
// 6. Disconnect
// 7. Delete PTY
// 8. Delete session
func TestFullSessionLifecycle(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	// 1. Create session
	resp := httpPost(t, ts.URL+"/sessions", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create session: expected 201, got %d", resp.StatusCode)
	}

	var sessionResp struct {
		ID string `json:"id"`
	}
	json.NewDecoder(resp.Body).Decode(&sessionResp)
	resp.Body.Close()
	sessionID := sessionResp.ID

	t.Logf("Created session: %s", sessionID)

	// 2. Create PTY
	resp = httpPost(t, ts.URL+"/sessions/"+sessionID+"/ptys", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create pty: expected 201, got %d", resp.StatusCode)
	}

	var ptyResp struct {
		ID string `json:"id"`
	}
	json.NewDecoder(resp.Body).Decode(&ptyResp)
	resp.Body.Close()
	ptyID := ptyResp.ID

	t.Logf("Created PTY: %s", ptyID)

	// 3. Connect via WebSocket (with user_id for turn-taking)
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/sessions/" + sessionID + "/ptys/" + ptyID + "/ws?user_id=test-user"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("websocket connect failed: %v", err)
	}

	t.Log("Connected via WebSocket")

	// Take control first (required for writing)
	takeControlMsg := ws.ControlMessage{Type: "take_control"}
	msgBytes, _ := json.Marshal(takeControlMsg)
	err = conn.WriteMessage(websocket.TextMessage, msgBytes)
	if err != nil {
		t.Fatalf("take control failed: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	// 4. Send command and receive output
	err = conn.WriteMessage(websocket.BinaryMessage, []byte("echo integration_test_marker\n"))
	if err != nil {
		t.Fatalf("write failed: %v", err)
	}

	var received []byte
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read failed: %v", err)
		}
		received = append(received, data...)
		if bytes.Contains(received, []byte("integration_test_marker")) {
			break
		}
	}

	t.Log("Command executed and output received")

	// 5. Resize terminal
	resizeMsg := ws.ControlMessage{
		Type: "resize",
		Cols: 100,
		Rows: 50,
	}
	msgBytes, _ = json.Marshal(resizeMsg)
	err = conn.WriteMessage(websocket.TextMessage, msgBytes)
	if err != nil {
		t.Fatalf("resize failed: %v", err)
	}

	t.Log("Terminal resized")

	// 6. Disconnect WebSocket
	conn.Close()

	t.Log("WebSocket disconnected")

	// 7. Verify PTY list
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/ptys")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list ptys: expected 200, got %d", resp.StatusCode)
	}

	var listResp struct {
		PTYs []struct {
			ID string `json:"id"`
		} `json:"ptys"`
	}
	json.NewDecoder(resp.Body).Decode(&listResp)
	resp.Body.Close()

	if len(listResp.PTYs) != 1 {
		t.Fatalf("expected 1 PTY, got %d", len(listResp.PTYs))
	}

	// 8. Delete session (should clean up PTY too)
	resp = httpDelete(t, ts.URL+"/sessions/"+sessionID)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete session: expected 204, got %d", resp.StatusCode)
	}

	t.Log("Session deleted")

	// 9. Verify session is gone
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/ptys")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 after deletion, got %d", resp.StatusCode)
	}

	t.Log("Integration test completed successfully")
}

// TestMultiplePTYsPerSession tests creating multiple PTYs
func TestMultiplePTYsPerSession(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	// Create session
	resp := httpPost(t, ts.URL+"/sessions", nil)
	var sessionResp struct{ ID string }
	json.NewDecoder(resp.Body).Decode(&sessionResp)
	resp.Body.Close()
	sessionID := sessionResp.ID

	// Create 3 PTYs
	ptyIDs := make([]string, 3)
	for i := 0; i < 3; i++ {
		resp = httpPost(t, ts.URL+"/sessions/"+sessionID+"/ptys", nil)
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("create pty %d: expected 201, got %d", i, resp.StatusCode)
		}
		var ptyResp struct{ ID string }
		json.NewDecoder(resp.Body).Decode(&ptyResp)
		resp.Body.Close()
		ptyIDs[i] = ptyResp.ID
	}

	// Verify all 3 exist
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/ptys")
	var listResp struct {
		PTYs []struct{ ID string } `json:"ptys"`
	}
	json.NewDecoder(resp.Body).Decode(&listResp)
	resp.Body.Close()

	if len(listResp.PTYs) != 3 {
		t.Fatalf("expected 3 PTYs, got %d", len(listResp.PTYs))
	}

	// Connect to each PTY via WebSocket
	for _, ptyID := range ptyIDs {
		wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/sessions/" + sessionID + "/ptys/" + ptyID + "/ws"
		conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatalf("websocket connect to %s failed: %v", ptyID, err)
		}
		conn.Close()
	}

	// Cleanup
	httpDelete(t, ts.URL+"/sessions/"+sessionID)
}

// TestConcurrentSessions tests multiple concurrent sessions
func TestConcurrentSessions(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	const numSessions = 5
	sessionIDs := make([]string, numSessions)

	// Create sessions concurrently
	done := make(chan int, numSessions)
	for i := 0; i < numSessions; i++ {
		go func(idx int) {
			resp := httpPost(t, ts.URL+"/sessions", nil)
			var sessionResp struct{ ID string }
			json.NewDecoder(resp.Body).Decode(&sessionResp)
			resp.Body.Close()
			sessionIDs[idx] = sessionResp.ID
			done <- idx
		}(i)
	}

	// Wait for all
	for i := 0; i < numSessions; i++ {
		<-done
	}

	// Verify all sessions exist
	for _, id := range sessionIDs {
		resp := httpGet(t, ts.URL+"/sessions/"+id+"/ptys")
		if resp.StatusCode != http.StatusOK {
			t.Errorf("session %s not found", id)
		}
		resp.Body.Close()
	}

	// Cleanup
	for _, id := range sessionIDs {
		httpDelete(t, ts.URL+"/sessions/"+id)
	}
}

// Helper functions
func httpPost(t *testing.T, url string, body []byte) *http.Response {
	t.Helper()
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s failed: %v", url, err)
	}
	return resp
}

func httpGet(t *testing.T, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s failed: %v", url, err)
	}
	return resp
}

func httpDelete(t *testing.T, url string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("DELETE", url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE %s failed: %v", url, err)
	}
	return resp
}

// TestAgentLifecycle tests the complete agent flow:
// 1. Create session
// 2. Start agent
// 3. Get agent status
// 4. Connect via WebSocket
// 5. Pause agent
// 6. Resume agent
// 7. Stop agent
// 8. Delete session
func TestAgentLifecycle(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	// 1. Create session
	resp := httpPost(t, ts.URL+"/sessions", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create session: expected 201, got %d", resp.StatusCode)
	}
	var sessionResp struct{ ID string }
	json.NewDecoder(resp.Body).Decode(&sessionResp)
	resp.Body.Close()
	sessionID := sessionResp.ID

	t.Logf("Created session: %s", sessionID)

	// 2. Start agent
	resp = httpPost(t, ts.URL+"/sessions/"+sessionID+"/agent", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("start agent: expected 201, got %d", resp.StatusCode)
	}
	var agentResp struct {
		ID    string `json:"id"`
		State string `json:"state"`
	}
	json.NewDecoder(resp.Body).Decode(&agentResp)
	resp.Body.Close()

	t.Logf("Started agent: %s, state: %s", agentResp.ID, agentResp.State)

	if agentResp.State != "running" {
		t.Errorf("expected state 'running', got '%s'", agentResp.State)
	}

	// 3. Get agent status
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/agent")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get agent: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 4. Connect via WebSocket
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/sessions/" + sessionID + "/agent/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("websocket connect failed: %v", err)
	}

	t.Log("Connected to agent via WebSocket")

	// Send a command
	err = conn.WriteMessage(websocket.BinaryMessage, []byte("echo agent_test\n"))
	if err != nil {
		t.Fatalf("write failed: %v", err)
	}

	// Read output
	var received []byte
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		received = append(received, data...)
		if bytes.Contains(received, []byte("agent_test")) {
			break
		}
	}
	conn.Close()

	t.Log("Agent executed command")

	// 5. Pause agent
	resp = httpPost(t, ts.URL+"/sessions/"+sessionID+"/agent/pause", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pause agent: expected 200, got %d", resp.StatusCode)
	}
	json.NewDecoder(resp.Body).Decode(&agentResp)
	resp.Body.Close()

	if agentResp.State != "paused" {
		t.Errorf("expected state 'paused', got '%s'", agentResp.State)
	}

	t.Log("Agent paused")

	// 6. Resume agent
	resp = httpPost(t, ts.URL+"/sessions/"+sessionID+"/agent/resume", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("resume agent: expected 200, got %d", resp.StatusCode)
	}
	json.NewDecoder(resp.Body).Decode(&agentResp)
	resp.Body.Close()

	if agentResp.State != "running" {
		t.Errorf("expected state 'running', got '%s'", agentResp.State)
	}

	t.Log("Agent resumed")

	// 7. Stop agent
	resp = httpPost(t, ts.URL+"/sessions/"+sessionID+"/agent/stop", nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("stop agent: expected 204, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	t.Log("Agent stopped")

	// Verify agent is gone
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/agent")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 after stop, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// 8. Delete session
	resp = httpDelete(t, ts.URL+"/sessions/"+sessionID)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete session: expected 204, got %d", resp.StatusCode)
	}

	t.Log("Agent lifecycle test completed successfully")
}

// TestAgentDoubleStart tests that starting an agent twice returns conflict
func TestAgentDoubleStart(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	// Create session
	resp := httpPost(t, ts.URL+"/sessions", nil)
	var sessionResp struct{ ID string }
	json.NewDecoder(resp.Body).Decode(&sessionResp)
	resp.Body.Close()
	sessionID := sessionResp.ID

	// Start agent first time
	resp = httpPost(t, ts.URL+"/sessions/"+sessionID+"/agent", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("first start: expected 201, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Start agent second time - should conflict
	resp = httpPost(t, ts.URL+"/sessions/"+sessionID+"/agent", nil)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("second start: expected 409, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Cleanup
	httpPost(t, ts.URL+"/sessions/"+sessionID+"/agent/stop", nil)
	httpDelete(t, ts.URL+"/sessions/"+sessionID)
}

// TestAgentNotFound tests agent endpoints when no agent exists
func TestAgentNotFound(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	// Create session
	resp := httpPost(t, ts.URL+"/sessions", nil)
	var sessionResp struct{ ID string }
	json.NewDecoder(resp.Body).Decode(&sessionResp)
	resp.Body.Close()
	sessionID := sessionResp.ID

	// Get agent - should 404
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/agent")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("get agent: expected 404, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Pause agent - should 404
	resp = httpPost(t, ts.URL+"/sessions/"+sessionID+"/agent/pause", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("pause agent: expected 404, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Cleanup
	httpDelete(t, ts.URL+"/sessions/"+sessionID)
}

// TestFilesystemLifecycle tests the complete filesystem flow:
// 1. Create session
// 2. Write a file
// 3. Read the file
// 4. List files
// 5. Get file stats
// 6. Delete the file
// 7. Verify file is gone
func TestFilesystemLifecycle(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	// 1. Create session
	resp := httpPost(t, ts.URL+"/sessions", nil)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create session: expected 201, got %d", resp.StatusCode)
	}
	var sessionResp struct{ ID string }
	json.NewDecoder(resp.Body).Decode(&sessionResp)
	resp.Body.Close()
	sessionID := sessionResp.ID

	t.Logf("Created session: %s", sessionID)

	// 2. Write a file
	fileContent := []byte("Hello, filesystem test!")
	resp = httpPut(t, ts.URL+"/sessions/"+sessionID+"/file?path=/test.txt", fileContent)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("write file: expected 201, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	t.Log("File written")

	// 3. Read the file
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/file?path=/test.txt")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("read file: expected 200, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != string(fileContent) {
		t.Errorf("expected content %q, got %q", string(fileContent), string(body))
	}

	t.Log("File read")

	// 4. List files
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/files")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list files: expected 200, got %d", resp.StatusCode)
	}
	var listResp struct {
		Files []struct {
			Name  string `json:"name"`
			IsDir bool   `json:"is_dir"`
		} `json:"files"`
	}
	json.NewDecoder(resp.Body).Decode(&listResp)
	resp.Body.Close()

	if len(listResp.Files) != 1 || listResp.Files[0].Name != "test.txt" {
		t.Errorf("expected 1 file named 'test.txt', got %+v", listResp.Files)
	}

	t.Log("Files listed")

	// 5. Get file stats
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/file/stat?path=/test.txt")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stat file: expected 200, got %d", resp.StatusCode)
	}
	var statResp struct {
		Name  string `json:"name"`
		Size  int64  `json:"size"`
		IsDir bool   `json:"is_dir"`
	}
	json.NewDecoder(resp.Body).Decode(&statResp)
	resp.Body.Close()

	if statResp.Name != "test.txt" || statResp.Size != int64(len(fileContent)) {
		t.Errorf("unexpected stat: %+v", statResp)
	}

	t.Log("File stat retrieved")

	// 6. Delete the file
	resp = httpDelete(t, ts.URL+"/sessions/"+sessionID+"/file?path=/test.txt")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete file: expected 204, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	t.Log("File deleted")

	// 7. Verify file is gone
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/file?path=/test.txt")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("read deleted file: expected 404, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	t.Log("Filesystem lifecycle test completed successfully")

	// Cleanup
	httpDelete(t, ts.URL+"/sessions/"+sessionID)
}

// TestFilesystemNestedDirectories tests creating and reading nested directories
func TestFilesystemNestedDirectories(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	// Create session
	resp := httpPost(t, ts.URL+"/sessions", nil)
	var sessionResp struct{ ID string }
	json.NewDecoder(resp.Body).Decode(&sessionResp)
	resp.Body.Close()
	sessionID := sessionResp.ID

	// Write file in nested directory (should create dirs automatically)
	resp = httpPut(t, ts.URL+"/sessions/"+sessionID+"/file?path=/a/b/c/nested.txt", []byte("nested content"))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("write nested file: expected 201, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// List /a directory
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/files?path=/a")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list /a: expected 200, got %d", resp.StatusCode)
	}
	var listResp struct {
		Files []struct {
			Name  string `json:"name"`
			IsDir bool   `json:"is_dir"`
		} `json:"files"`
	}
	json.NewDecoder(resp.Body).Decode(&listResp)
	resp.Body.Close()

	if len(listResp.Files) != 1 || listResp.Files[0].Name != "b" || !listResp.Files[0].IsDir {
		t.Errorf("expected directory 'b', got %+v", listResp.Files)
	}

	// Read the nested file
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/file?path=/a/b/c/nested.txt")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("read nested file: expected 200, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "nested content" {
		t.Errorf("expected 'nested content', got %q", string(body))
	}

	// Cleanup
	httpDelete(t, ts.URL+"/sessions/"+sessionID)
}

// TestFilesystemPathTraversal tests that path traversal is blocked
func TestFilesystemPathTraversal(t *testing.T) {
	sm, cleanup := setupTestManager(t)
	defer cleanup()
	server := NewServer(sm)

	ts := httptest.NewServer(server.Handler())
	defer ts.Close()

	// Create session
	resp := httpPost(t, ts.URL+"/sessions", nil)
	var sessionResp struct{ ID string }
	json.NewDecoder(resp.Body).Decode(&sessionResp)
	resp.Body.Close()
	sessionID := sessionResp.ID

	// Try to read /etc/passwd via path traversal
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/file?path=/../../../etc/passwd")
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("read traversal: expected 400, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Try to write outside workspace
	resp = httpPut(t, ts.URL+"/sessions/"+sessionID+"/file?path=/../../../tmp/evil.txt", []byte("bad"))
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("write traversal: expected 400, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Try to list outside workspace
	resp = httpGet(t, ts.URL+"/sessions/"+sessionID+"/files?path=/../../../etc")
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("list traversal: expected 400, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Cleanup
	httpDelete(t, ts.URL+"/sessions/"+sessionID)

	t.Log("Path traversal protection verified")
}

func httpPut(t *testing.T, url string, body []byte) *http.Response {
	t.Helper()
	req, _ := http.NewRequest("PUT", url, bytes.NewReader(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT %s failed: %v", url, err)
	}
	return resp
}
