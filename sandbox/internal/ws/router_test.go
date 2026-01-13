package ws

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
)

const testAPIToken = "test-api-token-12345"

func init() {
	// Set auth environment variables for tests
	os.Setenv("SANDBOX_INTERNAL_TOKEN", testAPIToken)
	os.Setenv("ALLOWED_ORIGINS", "http://localhost:*,http://127.0.0.1:*")
}

func setupTestServer(t *testing.T) (*httptest.Server, *sessions.Manager, func()) {
	dir, err := os.MkdirTemp("", "ws-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}

	sm := sessions.NewManagerWithWorkspace(dir)
	router := NewRouter(sm)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /sessions/{sessionId}/ptys/{ptyId}/ws", router.HandleWebSocket)

	server := httptest.NewServer(mux)
	return server, sm, func() {
		server.Close()
		os.RemoveAll(dir)
	}
}

func wsURL(server *httptest.Server, sessionId, ptyId string) string {
	return wsURLWithUser(server, sessionId, ptyId, "")
}

func wsURLWithUser(server *httptest.Server, sessionId, ptyId, userID string) string {
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/sessions/" + sessionId + "/ptys/" + ptyId + "/ws"
	if userID != "" {
		url += "?user_id=" + userID
	}
	return url
}

func wsDialWithAuth(t *testing.T, url, origin string) *websocket.Conn {
	t.Helper()
	headers := http.Header{}
	headers.Set("Origin", origin)
	conn, _, err := websocket.DefaultDialer.Dial(url, headers)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	return conn
}

func TestWebSocketConnect(t *testing.T) {
	server, sm, cleanup := setupTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	pty, _ := session.CreatePTY("")

	url := wsURL(server, session.ID, pty.ID)
	conn := wsDialWithAuth(t, url, server.URL)
	defer conn.Close()
}

func TestWebSocketConnectNonExistentSession(t *testing.T) {
	server, _, cleanup := setupTestServer(t)
	defer cleanup()

	url := wsURL(server, "nonexistent", "pty")
	headers := http.Header{}
	headers.Set("Origin", server.URL)
	_, resp, err := websocket.DefaultDialer.Dial(url, headers)
	if err == nil {
		t.Fatal("expected connection to fail")
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
}

func TestWebSocketConnectNonExistentPTY(t *testing.T) {
	server, sm, cleanup := setupTestServer(t)
	defer cleanup()

	session, _ := sm.Create()

	url := wsURL(server, session.ID, "nonexistent")
	headers := http.Header{}
	headers.Set("Origin", server.URL)
	_, resp, err := websocket.DefaultDialer.Dial(url, headers)
	if err == nil {
		t.Fatal("expected connection to fail")
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
}

func TestWebSocketSendReceive(t *testing.T) {
	server, sm, cleanup := setupTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	pty, _ := session.CreatePTY("")

	// Connect with user_id so we can take control
	url := wsURLWithUser(server, session.ID, pty.ID, "test-user")
	conn := wsDialWithAuth(t, url, server.URL)
	defer conn.Close()

	// Take control first (required for writing)
	takeControlMsg, _ := json.Marshal(ControlMessage{Type: "take_control"})
	if err := conn.WriteMessage(websocket.TextMessage, takeControlMsg); err != nil {
		t.Fatalf("failed to take control: %v", err)
	}

	// Small delay to let the control request be processed
	time.Sleep(50 * time.Millisecond)

	// Send command as binary
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("echo hello_ws_test\n")); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Read output
	var received []byte
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("failed to read: %v", err)
		}
		received = append(received, data...)
		if bytes.Contains(received, []byte("hello_ws_test")) {
			break
		}
	}
}

func TestWebSocketResize(t *testing.T) {
	server, sm, cleanup := setupTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	pty, _ := session.CreatePTY("")

	url := wsURL(server, session.ID, pty.ID)
	conn := wsDialWithAuth(t, url, server.URL)
	defer conn.Close()

	// Send resize as JSON text message
	msg := ControlMessage{
		Type: "resize",
		Cols: 120,
		Rows: 40,
	}
	data, _ := json.Marshal(msg)
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("failed to send resize: %v", err)
	}

	// Give time for resize to be processed
	time.Sleep(100 * time.Millisecond)
}

func TestWebSocketMultipleClients(t *testing.T) {
	server, sm, cleanup := setupTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	pty, _ := session.CreatePTY("")

	// Connect two clients with different user IDs
	url1 := wsURLWithUser(server, session.ID, pty.ID, "user1")
	url2 := wsURLWithUser(server, session.ID, pty.ID, "user2")

	conn1 := wsDialWithAuth(t, url1, server.URL)
	defer conn1.Close()

	conn2 := wsDialWithAuth(t, url2, server.URL)
	defer conn2.Close()

	// Give time for both to register
	time.Sleep(100 * time.Millisecond)

	// Client1 takes control first
	takeControlMsg, _ := json.Marshal(ControlMessage{Type: "take_control"})
	if err := conn1.WriteMessage(websocket.TextMessage, takeControlMsg); err != nil {
		t.Fatalf("failed to take control: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	// Send from client1 (who has control)
	if err := conn1.WriteMessage(websocket.BinaryMessage, []byte("echo multiclient\n")); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Both should receive
	checkReceived := func(name string, conn *websocket.Conn) {
		var received []byte
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				t.Errorf("%s: failed to read: %v", name, err)
				return
			}
			received = append(received, data...)
			if bytes.Contains(received, []byte("multiclient")) {
				return
			}
		}
	}

	done := make(chan bool, 2)
	go func() { checkReceived("client1", conn1); done <- true }()
	go func() { checkReceived("client2", conn2); done <- true }()

	<-done
	<-done
}
