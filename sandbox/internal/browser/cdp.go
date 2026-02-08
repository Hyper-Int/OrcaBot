// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package browser

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// CDPClient provides Chrome DevTools Protocol access to control the browser
type CDPClient struct {
	debugPort int
	conn      *websocket.Conn
	mu        sync.Mutex
	msgID     uint64
	pending   map[uint64]chan json.RawMessage
	targetID  string
	sessionID string
}

// NewCDPClient creates a new CDP client for the given debug port
func NewCDPClient(debugPort int) *CDPClient {
	return &CDPClient{
		debugPort: debugPort,
		pending:   make(map[uint64]chan json.RawMessage),
	}
}

// Connect establishes a WebSocket connection to the browser's debug endpoint
func (c *CDPClient) Connect() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.conn != nil {
		return nil // Already connected
	}

	// Get list of targets to find a page target
	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Get(fmt.Sprintf("http://127.0.0.1:%d/json/list", c.debugPort))
	if err != nil {
		return fmt.Errorf("failed to list targets: %w", err)
	}
	defer resp.Body.Close()

	var targets []struct {
		ID                   string `json:"id"`
		Type                 string `json:"type"`
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&targets); err != nil {
		return fmt.Errorf("failed to decode targets: %w", err)
	}

	// Find a page target
	var wsURL string
	for _, t := range targets {
		if t.Type == "page" {
			wsURL = t.WebSocketDebuggerURL
			c.targetID = t.ID
			break
		}
	}
	if wsURL == "" {
		return fmt.Errorf("no page target found")
	}

	// Connect via WebSocket
	dialer := websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
	}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		return fmt.Errorf("failed to connect to CDP: %w", err)
	}
	c.conn = conn

	// Start message reader
	go c.readMessages()

	return nil
}

// Close closes the CDP connection
func (c *CDPClient) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.conn != nil {
		err := c.conn.Close()
		c.conn = nil
		return err
	}
	return nil
}

func (c *CDPClient) readMessages() {
	for {
		c.mu.Lock()
		conn := c.conn
		c.mu.Unlock()

		if conn == nil {
			return
		}

		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var response struct {
			ID     uint64          `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(msg, &response); err != nil {
			continue
		}

		if response.ID > 0 {
			c.mu.Lock()
			ch, ok := c.pending[response.ID]
			if ok {
				delete(c.pending, response.ID)
			}
			c.mu.Unlock()

			if ok {
				if response.Error != nil {
					ch <- json.RawMessage(fmt.Sprintf(`{"error":"%s"}`, response.Error.Message))
				} else {
					ch <- response.Result
				}
			}
		}
	}
}

func (c *CDPClient) call(method string, params interface{}) (json.RawMessage, error) {
	c.mu.Lock()
	conn := c.conn
	if conn == nil {
		c.mu.Unlock()
		return nil, fmt.Errorf("not connected")
	}

	id := atomic.AddUint64(&c.msgID, 1)
	ch := make(chan json.RawMessage, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	msg := map[string]interface{}{
		"id":     id,
		"method": method,
	}
	if params != nil {
		msg["params"] = params
	}
	if c.sessionID != "" {
		msg["sessionId"] = c.sessionID
	}

	c.mu.Lock()
	err := conn.WriteJSON(msg)
	c.mu.Unlock()

	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("failed to send CDP command: %w", err)
	}

	select {
	case result := <-ch:
		// Check for error in result
		var errCheck struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(result, &errCheck) == nil && errCheck.Error != "" {
			return nil, fmt.Errorf("CDP error: %s", errCheck.Error)
		}
		return result, nil
	case <-time.After(30 * time.Second):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("CDP command timeout")
	}
}

// Screenshot captures a screenshot of the current page
func (c *CDPClient) Screenshot() ([]byte, error) {
	result, err := c.call("Page.captureScreenshot", map[string]interface{}{
		"format":  "png",
		"quality": 90,
	})
	if err != nil {
		return nil, err
	}

	var resp struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(result, &resp); err != nil {
		return nil, fmt.Errorf("failed to decode screenshot: %w", err)
	}

	return base64.StdEncoding.DecodeString(resp.Data)
}

// Click clicks an element matching the CSS selector
func (c *CDPClient) Click(selector string) error {
	// First, get document root
	result, err := c.call("DOM.getDocument", nil)
	if err != nil {
		return fmt.Errorf("failed to get document: %w", err)
	}

	var doc struct {
		Root struct {
			NodeID int `json:"nodeId"`
		} `json:"root"`
	}
	if err := json.Unmarshal(result, &doc); err != nil {
		return fmt.Errorf("failed to parse document: %w", err)
	}

	// Query for the element
	result, err = c.call("DOM.querySelector", map[string]interface{}{
		"nodeId":   doc.Root.NodeID,
		"selector": selector,
	})
	if err != nil {
		return fmt.Errorf("failed to query selector: %w", err)
	}

	var node struct {
		NodeID int `json:"nodeId"`
	}
	if err := json.Unmarshal(result, &node); err != nil {
		return fmt.Errorf("failed to parse node: %w", err)
	}

	if node.NodeID == 0 {
		return fmt.Errorf("element not found: %s", selector)
	}

	// Get the element's bounding box
	result, err = c.call("DOM.getBoxModel", map[string]interface{}{
		"nodeId": node.NodeID,
	})
	if err != nil {
		return fmt.Errorf("failed to get box model: %w", err)
	}

	var box struct {
		Model struct {
			Content []float64 `json:"content"`
		} `json:"model"`
	}
	if err := json.Unmarshal(result, &box); err != nil {
		return fmt.Errorf("failed to parse box model: %w", err)
	}

	if len(box.Model.Content) < 6 {
		return fmt.Errorf("invalid box model for element")
	}

	// Calculate center of element (content is [x1,y1, x2,y1, x2,y2, x1,y2])
	x := (box.Model.Content[0] + box.Model.Content[2]) / 2
	y := (box.Model.Content[1] + box.Model.Content[5]) / 2

	// Dispatch mouse events
	for _, eventType := range []string{"mousePressed", "mouseReleased"} {
		_, err = c.call("Input.dispatchMouseEvent", map[string]interface{}{
			"type":       eventType,
			"x":          x,
			"y":          y,
			"button":     "left",
			"clickCount": 1,
		})
		if err != nil {
			return fmt.Errorf("failed to dispatch %s: %w", eventType, err)
		}
	}

	return nil
}

// Type types text into an element matching the CSS selector
func (c *CDPClient) Type(selector string, text string) error {
	// Focus the element first
	if err := c.Focus(selector); err != nil {
		return err
	}

	// Clear existing content
	_, _ = c.call("Input.dispatchKeyEvent", map[string]interface{}{
		"type":                "keyDown",
		"key":                 "a",
		"modifiers":           2, // Ctrl
		"windowsVirtualKeyCode": 65,
	})
	_, _ = c.call("Input.dispatchKeyEvent", map[string]interface{}{
		"type": "keyUp",
		"key":  "a",
	})
	_, _ = c.call("Input.dispatchKeyEvent", map[string]interface{}{
		"type":                "keyDown",
		"key":                 "Backspace",
		"windowsVirtualKeyCode": 8,
	})
	_, _ = c.call("Input.dispatchKeyEvent", map[string]interface{}{
		"type": "keyUp",
		"key":  "Backspace",
	})

	// Type the text using insertText for reliability
	_, err := c.call("Input.insertText", map[string]interface{}{
		"text": text,
	})
	if err != nil {
		return fmt.Errorf("failed to type text: %w", err)
	}

	return nil
}

// Focus focuses an element matching the CSS selector
func (c *CDPClient) Focus(selector string) error {
	// Get document root
	result, err := c.call("DOM.getDocument", nil)
	if err != nil {
		return fmt.Errorf("failed to get document: %w", err)
	}

	var doc struct {
		Root struct {
			NodeID int `json:"nodeId"`
		} `json:"root"`
	}
	if err := json.Unmarshal(result, &doc); err != nil {
		return fmt.Errorf("failed to parse document: %w", err)
	}

	// Query for the element
	result, err = c.call("DOM.querySelector", map[string]interface{}{
		"nodeId":   doc.Root.NodeID,
		"selector": selector,
	})
	if err != nil {
		return fmt.Errorf("failed to query selector: %w", err)
	}

	var node struct {
		NodeID int `json:"nodeId"`
	}
	if err := json.Unmarshal(result, &node); err != nil {
		return fmt.Errorf("failed to parse node: %w", err)
	}

	if node.NodeID == 0 {
		return fmt.Errorf("element not found: %s", selector)
	}

	// Focus the element
	_, err = c.call("DOM.focus", map[string]interface{}{
		"nodeId": node.NodeID,
	})
	if err != nil {
		return fmt.Errorf("failed to focus element: %w", err)
	}

	return nil
}

// Evaluate executes JavaScript and returns the result
func (c *CDPClient) Evaluate(script string) (string, error) {
	result, err := c.call("Runtime.evaluate", map[string]interface{}{
		"expression":    script,
		"returnByValue": true,
	})
	if err != nil {
		return "", err
	}

	var resp struct {
		Result struct {
			Value interface{} `json:"value"`
			Type  string      `json:"type"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(result, &resp); err != nil {
		return "", fmt.Errorf("failed to parse eval result: %w", err)
	}

	if resp.ExceptionDetails != nil {
		return "", fmt.Errorf("JS error: %s", resp.ExceptionDetails.Text)
	}

	// Convert value to string
	switch v := resp.Result.Value.(type) {
	case string:
		return v, nil
	case nil:
		return "", nil
	default:
		b, _ := json.Marshal(v)
		return string(b), nil
	}
}

// GetContent returns the visible text content of the page
func (c *CDPClient) GetContent() (string, error) {
	return c.Evaluate("document.body.innerText")
}

// GetHTML returns the full HTML of the page
func (c *CDPClient) GetHTML() (string, error) {
	return c.Evaluate("document.documentElement.outerHTML")
}

// GetURL returns the current page URL
func (c *CDPClient) GetURL() (string, error) {
	return c.Evaluate("window.location.href")
}

// GetTitle returns the page title
func (c *CDPClient) GetTitle() (string, error) {
	return c.Evaluate("document.title")
}

// WaitForSelector waits for an element to appear
func (c *CDPClient) WaitForSelector(selector string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		result, err := c.Evaluate(fmt.Sprintf(`document.querySelector(%q) !== null`, selector))
		if err == nil && result == "true" {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for selector: %s", selector)
}

// Navigate navigates to a URL and waits for load
func (c *CDPClient) Navigate(url string) error {
	_, err := c.call("Page.navigate", map[string]interface{}{
		"url": url,
	})
	if err != nil {
		return fmt.Errorf("failed to navigate: %w", err)
	}

	// Wait a bit for navigation to start
	time.Sleep(500 * time.Millisecond)

	// Wait for page load (simple polling approach)
	for i := 0; i < 60; i++ {
		result, err := c.Evaluate("document.readyState")
		if err == nil && (result == "complete" || result == "interactive") {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}

	return nil // Don't error on load timeout, page might be usable
}

// Scroll scrolls the page by the given amount
func (c *CDPClient) Scroll(x, y int) error {
	_, err := c.Evaluate(fmt.Sprintf("window.scrollBy(%d, %d)", x, y))
	return err
}

// ScrollTo scrolls to absolute position
func (c *CDPClient) ScrollTo(x, y int) error {
	_, err := c.Evaluate(fmt.Sprintf("window.scrollTo(%d, %d)", x, y))
	return err
}

// Browser controller methods that use CDP

// Screenshot captures and saves a screenshot, returns the file path
func (c *Controller) Screenshot(outputPath string) (string, error) {
	if !c.running || c.debugPort == 0 {
		return "", fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return "", fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	data, err := cdp.Screenshot()
	if err != nil {
		return "", err
	}

	// Determine output path - always resolve within workspace
	if outputPath == "" {
		outputPath = filepath.Join(c.workspace, fmt.Sprintf("screenshot-%d.png", time.Now().Unix()))
	} else if filepath.IsAbs(outputPath) {
		// Reject absolute paths to prevent writes outside workspace
		return "", fmt.Errorf("absolute paths are not allowed; use a relative path")
	} else {
		outputPath = filepath.Join(c.workspace, outputPath)
	}

	// Verify resolved path is within workspace (prevent ../ traversal)
	resolved, err := filepath.Abs(outputPath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve path: %w", err)
	}
	workspaceAbs, err := filepath.Abs(c.workspace)
	if err != nil {
		return "", fmt.Errorf("failed to resolve workspace: %w", err)
	}
	if !strings.HasPrefix(resolved, workspaceAbs+string(filepath.Separator)) && resolved != workspaceAbs {
		return "", fmt.Errorf("path escapes workspace directory")
	}

	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(outputPath), 0755); err != nil {
		return "", fmt.Errorf("failed to create directory: %w", err)
	}

	if err := os.WriteFile(outputPath, data, 0644); err != nil {
		return "", fmt.Errorf("failed to write screenshot: %w", err)
	}

	return outputPath, nil
}

// Click clicks an element
func (c *Controller) Click(selector string) error {
	if !c.running || c.debugPort == 0 {
		return fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.Click(selector)
}

// Type types text into an element
func (c *Controller) Type(selector string, text string) error {
	if !c.running || c.debugPort == 0 {
		return fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.Type(selector, text)
}

// Evaluate executes JavaScript
func (c *Controller) Evaluate(script string) (string, error) {
	if !c.running || c.debugPort == 0 {
		return "", fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return "", fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.Evaluate(script)
}

// GetContent returns page text content
func (c *Controller) GetContent() (string, error) {
	if !c.running || c.debugPort == 0 {
		return "", fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return "", fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.GetContent()
}

// GetHTML returns page HTML
func (c *Controller) GetHTML() (string, error) {
	if !c.running || c.debugPort == 0 {
		return "", fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return "", fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.GetHTML()
}

// GetCurrentURL returns the current URL
func (c *Controller) GetCurrentURL() (string, error) {
	if !c.running || c.debugPort == 0 {
		return "", fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return "", fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.GetURL()
}

// GetTitle returns the page title
func (c *Controller) GetTitle() (string, error) {
	if !c.running || c.debugPort == 0 {
		return "", fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return "", fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.GetTitle()
}

// WaitForSelector waits for an element to appear
func (c *Controller) WaitForSelector(selector string, timeout time.Duration) error {
	if !c.running || c.debugPort == 0 {
		return fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.WaitForSelector(selector, timeout)
}

// Navigate navigates to a URL using CDP (alternative to OpenURL)
func (c *Controller) Navigate(url string) error {
	if !c.running || c.debugPort == 0 {
		return fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.Navigate(url)
}

// Scroll scrolls the page
func (c *Controller) Scroll(x, y int) error {
	if !c.running || c.debugPort == 0 {
		return fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	return cdp.Scroll(x, y)
}

// ScreenshotToReader captures a screenshot and returns a reader for the PNG data
func (c *Controller) ScreenshotToReader() (io.Reader, error) {
	if !c.running || c.debugPort == 0 {
		return nil, fmt.Errorf("browser not running")
	}

	cdp := NewCDPClient(c.debugPort)
	if err := cdp.Connect(); err != nil {
		return nil, fmt.Errorf("CDP connect failed: %w", err)
	}
	defer cdp.Close()

	data, err := cdp.Screenshot()
	if err != nil {
		return nil, err
	}

	return &bytesReader{data: data}, nil
}

type bytesReader struct {
	data []byte
	pos  int
}

func (r *bytesReader) Read(p []byte) (n int, err error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n = copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}
