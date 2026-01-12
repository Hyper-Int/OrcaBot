package ws

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hyper-ai-inc/hyper-backend/internal/pty"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 64 * 1024
)

// ControlMessage represents a JSON control message
type ControlMessage struct {
	Type   string `json:"type"`
	Cols   uint16 `json:"cols,omitempty"`
	Rows   uint16 `json:"rows,omitempty"`
	To     string `json:"to,omitempty"`      // For grant_control
	UserID string `json:"user_id,omitempty"` // For identifying sender
}

// Client represents a WebSocket client connected to a PTY
type Client struct {
	conn   *websocket.Conn
	hub    *pty.Hub
	userID string
	output chan pty.HubMessage
}

// NewClient creates a new WebSocket client (legacy - no user ID)
func NewClient(conn *websocket.Conn, hub *pty.Hub) *Client {
	return NewClientWithUser(conn, hub, "")
}

// NewClientWithUser creates a new WebSocket client with user ID.
// Returns nil if hub is already stopped.
func NewClientWithUser(conn *websocket.Conn, hub *pty.Hub, userID string) *Client {
	c := &Client{
		conn:   conn,
		hub:    hub,
		userID: userID,
		output: make(chan pty.HubMessage, 256),
	}
	var registered bool
	if userID != "" {
		registered = hub.RegisterClient(userID, c.output)
		if registered {
			hub.Reconnect(userID)
		}
	} else {
		registered = hub.Register(c.output)
	}
	if !registered {
		conn.Close()
		return nil
	}
	return c
}

// ReadPump reads messages from the WebSocket
func (c *Client) ReadPump() {
	defer func() {
		c.hub.Unregister(c.output)
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		messageType, data, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("websocket error: %v", err)
			}
			return
		}

		switch messageType {
		case websocket.BinaryMessage:
			// Binary = PTY input (only from controller)
			// Clients without userID cannot write - they are view-only
			if c.userID != "" {
				c.hub.Write(c.userID, data)
			}
			// else: silently drop input from anonymous clients

		case websocket.TextMessage:
			// Text = JSON control message
			var msg ControlMessage
			if err := json.Unmarshal(data, &msg); err != nil {
				log.Printf("invalid control message: %v", err)
				continue
			}
			c.handleControl(msg)
		}
	}
}

// handleControl processes control messages
func (c *Client) handleControl(msg ControlMessage) {
	switch msg.Type {
	case "resize":
		if msg.Cols > 0 && msg.Rows > 0 {
			c.hub.Resize(msg.Cols, msg.Rows)
		}

	case "take_control":
		if c.userID != "" {
			c.hub.TakeControl(c.userID)
		}

	case "request_control":
		if c.userID != "" {
			c.hub.RequestControl(c.userID)
		}

	case "grant_control":
		if c.userID != "" && msg.To != "" {
			c.hub.GrantControl(c.userID, msg.To)
		}

	case "revoke_control":
		if c.userID != "" {
			c.hub.RevokeControl(c.userID)
		}

	case "ping":
		// Client keepalive ping - no action needed, presence is sufficient

	default:
		log.Printf("unknown control message type: %s", msg.Type)
	}
}

// WritePump writes messages to the WebSocket
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.output:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			// Use the message type flag to determine WebSocket frame type
			if msg.IsBinary {
				if err := c.conn.WriteMessage(websocket.BinaryMessage, msg.Data); err != nil {
					return
				}
			} else {
				if err := c.conn.WriteMessage(websocket.TextMessage, msg.Data); err != nil {
					return
				}
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// UserID returns the client's user ID
func (c *Client) UserID() string {
	return c.userID
}
