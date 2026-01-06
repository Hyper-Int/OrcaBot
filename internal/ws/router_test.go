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

	"github.com/hyper-ai-inc/hyper-backend/internal/sessions"
	"github.com/gorilla/websocket"
)

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

func TestWebSocketConnect(t *testing.T) {
	server, sm, cleanup := setupTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	pty, _ := session.CreatePTY("")

	url := wsURL(server, session.ID, pty.ID)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()
}

func TestWebSocketConnectNonExistentSession(t *testing.T) {
	server, _, cleanup := setupTestServer(t)
	defer cleanup()

	url := wsURL(server, "nonexistent", "pty")
	_, resp, err := websocket.DefaultDialer.Dial(url, nil)
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
	_, resp, err := websocket.DefaultDialer.Dial(url, nil)
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
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	// Take control first (required for writing)
	takeControlMsg, _ := json.Marshal(ControlMessage{Type: "take_control"})
	err = conn.WriteMessage(websocket.TextMessage, takeControlMsg)
	if err != nil {
		t.Fatalf("failed to take control: %v", err)
	}

	// Small delay to let the control request be processed
	time.Sleep(50 * time.Millisecond)

	// Send command as binary
	err = conn.WriteMessage(websocket.BinaryMessage, []byte("echo hello_ws_test\n"))
	if err != nil {
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
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	// Send resize as JSON text message
	msg := ControlMessage{
		Type: "resize",
		Cols: 120,
		Rows: 40,
	}
	data, _ := json.Marshal(msg)
	err = conn.WriteMessage(websocket.TextMessage, data)
	if err != nil {
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

	conn1, _, err := websocket.DefaultDialer.Dial(url1, nil)
	if err != nil {
		t.Fatalf("failed to connect client1: %v", err)
	}
	defer conn1.Close()

	conn2, _, err := websocket.DefaultDialer.Dial(url2, nil)
	if err != nil {
		t.Fatalf("failed to connect client2: %v", err)
	}
	defer conn2.Close()

	// Give time for both to register
	time.Sleep(100 * time.Millisecond)

	// Client1 takes control first
	takeControlMsg, _ := json.Marshal(ControlMessage{Type: "take_control"})
	err = conn1.WriteMessage(websocket.TextMessage, takeControlMsg)
	if err != nil {
		t.Fatalf("failed to take control: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	// Send from client1 (who has control)
	err = conn1.WriteMessage(websocket.BinaryMessage, []byte("echo multiclient\n"))
	if err != nil {
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
