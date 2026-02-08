// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// Browser automation MCP tools - handled locally in the sandbox
// These tools allow agents to control the Chromium browser instance

// BrowserTool represents an MCP tool definition for browser automation
type BrowserTool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema InputSchema `json:"inputSchema"`
}

type InputSchema struct {
	Type       string              `json:"type"`
	Properties map[string]Property `json:"properties"`
	Required   []string            `json:"required,omitempty"`
}

type Property struct {
	Type        string   `json:"type"`
	Description string   `json:"description"`
	Enum        []string `json:"enum,omitempty"`
}

// BROWSER_TOOLS defines all browser automation MCP tools
var BROWSER_TOOLS = []BrowserTool{
	{
		Name:        "browser_start",
		Description: "Start the browser if not already running. Returns browser status.",
		InputSchema: InputSchema{
			Type:       "object",
			Properties: map[string]Property{},
		},
	},
	{
		Name:        "browser_stop",
		Description: "Stop the browser and release resources.",
		InputSchema: InputSchema{
			Type:       "object",
			Properties: map[string]Property{},
		},
	},
	{
		Name:        "browser_status",
		Description: "Get the current browser status (running, ready, etc).",
		InputSchema: InputSchema{
			Type:       "object",
			Properties: map[string]Property{},
		},
	},
	{
		Name:        "browser_navigate",
		Description: "Navigate the browser to a URL and wait for the page to load.",
		InputSchema: InputSchema{
			Type: "object",
			Properties: map[string]Property{
				"url": {
					Type:        "string",
					Description: "The URL to navigate to (must start with http:// or https://)",
				},
			},
			Required: []string{"url"},
		},
	},
	{
		Name:        "browser_screenshot",
		Description: "Capture a screenshot of the current browser viewport. Returns the file path.",
		InputSchema: InputSchema{
			Type: "object",
			Properties: map[string]Property{
				"filename": {
					Type:        "string",
					Description: "Optional filename for the screenshot (defaults to screenshot-{timestamp}.png)",
				},
			},
		},
	},
	{
		Name:        "browser_click",
		Description: "Click an element on the page by CSS selector.",
		InputSchema: InputSchema{
			Type: "object",
			Properties: map[string]Property{
				"selector": {
					Type:        "string",
					Description: "CSS selector for the element to click (e.g., 'button.submit', '#login-btn')",
				},
			},
			Required: []string{"selector"},
		},
	},
	{
		Name:        "browser_type",
		Description: "Type text into an input element. Clears existing content first.",
		InputSchema: InputSchema{
			Type: "object",
			Properties: map[string]Property{
				"selector": {
					Type:        "string",
					Description: "CSS selector for the input element (e.g., 'input#email', 'input[name=password]')",
				},
				"text": {
					Type:        "string",
					Description: "Text to type into the element. Environment variables like $PASSWORD are NOT expanded - use the actual value.",
				},
			},
			Required: []string{"selector", "text"},
		},
	},
	{
		Name:        "browser_get_content",
		Description: "Get the visible text content of the current page. Useful for reading page state.",
		InputSchema: InputSchema{
			Type:       "object",
			Properties: map[string]Property{},
		},
	},
	{
		Name:        "browser_get_html",
		Description: "Get the full HTML source of the current page.",
		InputSchema: InputSchema{
			Type:       "object",
			Properties: map[string]Property{},
		},
	},
	{
		Name:        "browser_get_url",
		Description: "Get the current page URL.",
		InputSchema: InputSchema{
			Type:       "object",
			Properties: map[string]Property{},
		},
	},
	{
		Name:        "browser_get_title",
		Description: "Get the current page title.",
		InputSchema: InputSchema{
			Type:       "object",
			Properties: map[string]Property{},
		},
	},
	{
		Name:        "browser_wait",
		Description: "Wait for an element to appear on the page.",
		InputSchema: InputSchema{
			Type: "object",
			Properties: map[string]Property{
				"selector": {
					Type:        "string",
					Description: "CSS selector for the element to wait for",
				},
				"timeout": {
					Type:        "number",
					Description: "Maximum time to wait in seconds (default: 30)",
				},
			},
			Required: []string{"selector"},
		},
	},
	{
		Name:        "browser_evaluate",
		Description: "Execute JavaScript code in the browser and return the result.",
		InputSchema: InputSchema{
			Type: "object",
			Properties: map[string]Property{
				"script": {
					Type:        "string",
					Description: "JavaScript code to execute (e.g., 'document.title', 'document.querySelector(\".price\").innerText')",
				},
			},
			Required: []string{"script"},
		},
	},
	{
		Name:        "browser_scroll",
		Description: "Scroll the page by a given amount.",
		InputSchema: InputSchema{
			Type: "object",
			Properties: map[string]Property{
				"x": {
					Type:        "number",
					Description: "Horizontal scroll amount in pixels",
				},
				"y": {
					Type:        "number",
					Description: "Vertical scroll amount in pixels (positive = down)",
				},
			},
		},
	},
}

// handleBrowserMCPTools returns the list of browser tools for MCP
func (s *Server) handleBrowserMCPTools() []BrowserTool {
	return BROWSER_TOOLS
}

// handleBrowserMCPCall handles MCP tool calls for browser automation
func (s *Server) handleBrowserMCPCall(w http.ResponseWriter, r *http.Request, toolName string, args map[string]interface{}) {
	sessionID := r.PathValue("sessionId")
	session := s.getSessiоnOrErrоr(w, sessionID)
	if session == nil {
		return
	}

	// MCP response helper
	mcpResponse := func(text string) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"content": []map[string]string{
				{"type": "text", "text": text},
			},
		})
	}

	mcpError := func(err error) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK) // MCP errors are still 200 with error in content
		json.NewEncoder(w).Encode(map[string]interface{}{
			"content": []map[string]string{
				{"type": "text", "text": fmt.Sprintf("Error: %v", err)},
			},
			"isError": true,
		})
	}

	switch toolName {
	case "browser_start":
		status, err := session.StartBrowser()
		if err != nil {
			mcpError(err)
			return
		}
		mcpResponse(fmt.Sprintf("Browser started. Running: %v, Ready: %v", status.Running, status.Ready))

	case "browser_stop":
		session.StopBrowser()
		mcpResponse("Browser stopped.")

	case "browser_status":
		status := session.BrowserStatus()
		mcpResponse(fmt.Sprintf("Running: %v, Ready: %v", status.Running, status.Ready))

	case "browser_navigate":
		url, _ := args["url"].(string)
		if url == "" {
			mcpError(fmt.Errorf("url is required"))
			return
		}
		// Auto-start browser if not running
		status := session.BrowserStatus()
		if !status.Running {
			if _, err := session.StartBrowser(); err != nil {
				mcpError(fmt.Errorf("failed to start browser: %w", err))
				return
			}
		}
		if err := session.BrowserNavigate(url); err != nil {
			mcpError(err)
			return
		}
		mcpResponse(fmt.Sprintf("Navigated to %s", url))

	case "browser_screenshot":
		filename, _ := args["filename"].(string)
		path, err := session.BrowserScreenshot(filename)
		if err != nil {
			mcpError(err)
			return
		}
		mcpResponse(fmt.Sprintf("Screenshot saved to: %s", path))

	case "browser_click":
		selector, _ := args["selector"].(string)
		if selector == "" {
			mcpError(fmt.Errorf("selector is required"))
			return
		}
		if err := session.BrowserClick(selector); err != nil {
			mcpError(err)
			return
		}
		mcpResponse(fmt.Sprintf("Clicked element: %s", selector))

	case "browser_type":
		selector, _ := args["selector"].(string)
		text, _ := args["text"].(string)
		if selector == "" {
			mcpError(fmt.Errorf("selector is required"))
			return
		}
		if err := session.BrowserType(selector, text); err != nil {
			mcpError(err)
			return
		}
		mcpResponse(fmt.Sprintf("Typed text into: %s", selector))

	case "browser_get_content":
		content, err := session.BrowserGetContent()
		if err != nil {
			mcpError(err)
			return
		}
		// Truncate if too long
		if len(content) > 50000 {
			content = content[:50000] + "\n... (truncated)"
		}
		mcpResponse(content)

	case "browser_get_html":
		html, err := session.BrowserGetHTML()
		if err != nil {
			mcpError(err)
			return
		}
		// Truncate if too long
		if len(html) > 100000 {
			html = html[:100000] + "\n... (truncated)"
		}
		mcpResponse(html)

	case "browser_get_url":
		url, err := session.BrowserGetURL()
		if err != nil {
			mcpError(err)
			return
		}
		mcpResponse(url)

	case "browser_get_title":
		title, err := session.BrowserGetTitle()
		if err != nil {
			mcpError(err)
			return
		}
		mcpResponse(title)

	case "browser_wait":
		selector, _ := args["selector"].(string)
		if selector == "" {
			mcpError(fmt.Errorf("selector is required"))
			return
		}
		timeout := 30
		if t, ok := args["timeout"].(float64); ok && t > 0 {
			timeout = int(t)
		}
		if err := session.BrowserWaitForSelector(selector, timeout); err != nil {
			mcpError(err)
			return
		}
		mcpResponse(fmt.Sprintf("Element found: %s", selector))

	case "browser_evaluate":
		script, _ := args["script"].(string)
		if script == "" {
			mcpError(fmt.Errorf("script is required"))
			return
		}
		result, err := session.BrowserEvaluate(script)
		if err != nil {
			mcpError(err)
			return
		}
		mcpResponse(result)

	case "browser_scroll":
		x := 0
		y := 0
		if xVal, ok := args["x"].(float64); ok {
			x = int(xVal)
		}
		if yVal, ok := args["y"].(float64); ok {
			y = int(yVal)
		}
		if err := session.BrowserScroll(x, y); err != nil {
			mcpError(err)
			return
		}
		mcpResponse(fmt.Sprintf("Scrolled by x=%d, y=%d", x, y))

	default:
		mcpError(fmt.Errorf("unknown browser tool: %s", toolName))
	}
}

// isBrowserTool checks if a tool name is a browser tool
func isBrowserTool(toolName string) bool {
	for _, tool := range BROWSER_TOOLS {
		if tool.Name == toolName {
			return true
		}
	}
	return false
}

