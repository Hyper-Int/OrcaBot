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

	"github.com/hyper-ai-inc/hyper-backend/internal/pty"
	"github.com/hyper-ai-inc/hyper-backend/internal/sessions"
	"github.com/gorilla/websocket"
)

func setupTurnTestServer(t *testing.T) (*httptest.Server, *sessions.Manager, func()) {
	dir, err := os.MkdirTemp("", "turn-test-*")
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

func dialWithUser(t *testing.T, server *httptest.Server, sessionID, ptyID, userID string) *websocket.Conn {
	url := "ws" + strings.TrimPrefix(server.URL, "http") +
		"/sessions/" + sessionID + "/ptys/" + ptyID + "/ws?user_id=" + userID
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("failed to connect as %s: %v", userID, err)
	}
	return conn
}

func sendControl(t *testing.T, conn *websocket.Conn, msg ControlMessage) {
	data, _ := json.Marshal(msg)
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("failed to send control message: %v", err)
	}
}

func waitForControlEvent(t *testing.T, conn *websocket.Conn, eventType string, timeout time.Duration) *pty.ControlEvent {
	conn.SetReadDeadline(time.Now().Add(timeout))
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("failed to read message waiting for %s: %v", eventType, err)
		}
		if msgType == websocket.TextMessage {
			var event pty.ControlEvent
			if err := json.Unmarshal(data, &event); err == nil {
				if event.Type == eventType {
					return &event
				}
			}
		}
	}
}

func TestTurnTakingTakeControl(t *testing.T) {
	server, sm, cleanup := setupTurnTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	ptyInfo, _ := session.CreatePTY("")

	// Connect as user1
	conn1 := dialWithUser(t, server, session.ID, ptyInfo.ID, "user1")
	defer conn1.Close()

	// Should receive initial control_state
	event := waitForControlEvent(t, conn1, "control_state", 2*time.Second)
	if event.Controller != "" {
		t.Errorf("expected no initial controller, got %s", event.Controller)
	}

	// Take control
	sendControl(t, conn1, ControlMessage{Type: "take_control"})

	// Should receive control_taken
	event = waitForControlEvent(t, conn1, "control_taken", 2*time.Second)
	if event.Controller != "user1" {
		t.Errorf("expected controller to be user1, got %s", event.Controller)
	}
}

func TestTurnTakingOnlyControllerCanWrite(t *testing.T) {
	server, sm, cleanup := setupTurnTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	ptyInfo, _ := session.CreatePTY("")

	// Connect user1 (controller) and user2 (observer)
	conn1 := dialWithUser(t, server, session.ID, ptyInfo.ID, "user1")
	defer conn1.Close()
	conn2 := dialWithUser(t, server, session.ID, ptyInfo.ID, "user2")
	defer conn2.Close()

	// Wait for initial state
	waitForControlEvent(t, conn1, "control_state", 2*time.Second)
	waitForControlEvent(t, conn2, "control_state", 2*time.Second)

	// user1 takes control
	sendControl(t, conn1, ControlMessage{Type: "take_control"})
	waitForControlEvent(t, conn1, "control_taken", 2*time.Second)
	waitForControlEvent(t, conn2, "control_taken", 2*time.Second)

	// user1 (controller) writes - should work
	err := conn1.WriteMessage(websocket.BinaryMessage, []byte("echo controller_test\n"))
	if err != nil {
		t.Fatalf("controller write failed: %v", err)
	}

	// user2 (observer) writes - should be silently dropped
	err = conn2.WriteMessage(websocket.BinaryMessage, []byte("echo observer_should_not_work\n"))
	if err != nil {
		t.Fatalf("observer write failed: %v", err)
	}

	// Read output - should only see controller's command
	var received []byte
	conn1.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, data, err := conn1.ReadMessage()
		if err != nil {
			break
		}
		received = append(received, data...)
		if bytes.Contains(received, []byte("controller_test")) {
			break
		}
	}

	if !bytes.Contains(received, []byte("controller_test")) {
		t.Error("expected to see controller's output")
	}
	if bytes.Contains(received, []byte("observer_should_not_work")) {
		t.Error("observer's command should not have been executed")
	}
}

func TestTurnTakingRequestAndGrant(t *testing.T) {
	server, sm, cleanup := setupTurnTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	ptyInfo, _ := session.CreatePTY("")

	conn1 := dialWithUser(t, server, session.ID, ptyInfo.ID, "user1")
	defer conn1.Close()
	conn2 := dialWithUser(t, server, session.ID, ptyInfo.ID, "user2")
	defer conn2.Close()

	// Wait for initial state
	waitForControlEvent(t, conn1, "control_state", 2*time.Second)
	waitForControlEvent(t, conn2, "control_state", 2*time.Second)

	// user1 takes control
	sendControl(t, conn1, ControlMessage{Type: "take_control"})
	waitForControlEvent(t, conn1, "control_taken", 2*time.Second)
	waitForControlEvent(t, conn2, "control_taken", 2*time.Second)

	// user2 requests control
	sendControl(t, conn2, ControlMessage{Type: "request_control"})

	// Both should receive control_requested
	event := waitForControlEvent(t, conn1, "control_requested", 2*time.Second)
	if event.From != "user2" {
		t.Errorf("expected request from user2, got %s", event.From)
	}
	waitForControlEvent(t, conn2, "control_requested", 2*time.Second)

	// user1 grants control to user2
	sendControl(t, conn1, ControlMessage{Type: "grant_control", To: "user2"})

	// Both should receive control_granted
	event = waitForControlEvent(t, conn1, "control_granted", 2*time.Second)
	if event.Controller != "user2" {
		t.Errorf("expected controller to be user2, got %s", event.Controller)
	}
	event = waitForControlEvent(t, conn2, "control_granted", 2*time.Second)
	if event.Controller != "user2" {
		t.Errorf("expected controller to be user2, got %s", event.Controller)
	}
}

func TestTurnTakingRevokeControl(t *testing.T) {
	server, sm, cleanup := setupTurnTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	ptyInfo, _ := session.CreatePTY("")

	conn1 := dialWithUser(t, server, session.ID, ptyInfo.ID, "user1")
	defer conn1.Close()

	waitForControlEvent(t, conn1, "control_state", 2*time.Second)

	// Take control
	sendControl(t, conn1, ControlMessage{Type: "take_control"})
	waitForControlEvent(t, conn1, "control_taken", 2*time.Second)

	// Revoke control
	sendControl(t, conn1, ControlMessage{Type: "revoke_control"})
	event := waitForControlEvent(t, conn1, "control_revoked", 2*time.Second)
	if event.From != "user1" {
		t.Errorf("expected revoke from user1, got %s", event.From)
	}
}

func TestTurnTakingNonControllerCannotGrant(t *testing.T) {
	server, sm, cleanup := setupTurnTestServer(t)
	defer cleanup()

	session, _ := sm.Create()
	ptyInfo, _ := session.CreatePTY("")

	conn1 := dialWithUser(t, server, session.ID, ptyInfo.ID, "user1")
	defer conn1.Close()
	conn2 := dialWithUser(t, server, session.ID, ptyInfo.ID, "user2")
	defer conn2.Close()
	conn3 := dialWithUser(t, server, session.ID, ptyInfo.ID, "user3")
	defer conn3.Close()

	// Wait for initial states
	waitForControlEvent(t, conn1, "control_state", 2*time.Second)
	waitForControlEvent(t, conn2, "control_state", 2*time.Second)
	waitForControlEvent(t, conn3, "control_state", 2*time.Second)

	// user1 takes control
	sendControl(t, conn1, ControlMessage{Type: "take_control"})
	waitForControlEvent(t, conn1, "control_taken", 2*time.Second)
	waitForControlEvent(t, conn2, "control_taken", 2*time.Second)
	waitForControlEvent(t, conn3, "control_taken", 2*time.Second)

	// user3 requests control
	sendControl(t, conn3, ControlMessage{Type: "request_control"})
	waitForControlEvent(t, conn1, "control_requested", 2*time.Second)

	// user2 tries to grant (should fail - not controller)
	sendControl(t, conn2, ControlMessage{Type: "grant_control", To: "user3"})

	// Give time for any response
	time.Sleep(100 * time.Millisecond)

	// Verify user1 is still controller
	if !ptyInfo.Hub.IsController("user1") {
		t.Error("user1 should still be controller")
	}
}
