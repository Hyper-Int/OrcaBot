// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// browser-ctl is a CLI tool for controlling the sandbox browser from terminal agents.
// It communicates with the sandbox server's browser API to enable programmatic
// browser automation from within terminal sessions (e.g., Claude Code).
//
// Usage:
//
//	browser-ctl open <url>              Navigate to URL
//	browser-ctl screenshot [filename]   Capture screenshot
//	browser-ctl click <selector>        Click element
//	browser-ctl type <selector> <text>  Type into element
//	browser-ctl eval <script>           Execute JavaScript
//	browser-ctl content                 Get page text content
//	browser-ctl html                    Get page HTML
//	browser-ctl url                     Get current URL
//	browser-ctl title                   Get page title
//	browser-ctl wait <selector> [timeout] Wait for element
//	browser-ctl scroll <x> <y>          Scroll page
//	browser-ctl status                  Get browser status
//	browser-ctl start                   Start browser
//	browser-ctl stop                    Stop browser
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	// Get session ID from environment
	sessionID := os.Getenv("ORCABOT_SESSION_ID")
	if sessionID == "" {
		fmt.Fprintln(os.Stderr, "Error: ORCABOT_SESSION_ID environment variable not set")
		os.Exit(1)
	}

	// Get internal token from environment
	token := os.Getenv("ORCABOT_INTERNAL_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "Error: ORCABOT_INTERNAL_TOKEN environment variable not set")
		os.Exit(1)
	}

	// Sandbox server runs locally
	baseURL := "http://127.0.0.1:8080"

	client := &browserClient{
		baseURL:   baseURL,
		sessionID: sessionID,
		token:     token,
		http:      &http.Client{Timeout: 60 * time.Second},
	}

	var err error
	switch cmd {
	case "open", "navigate", "goto":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "Error: URL required")
			os.Exit(1)
		}
		err = client.open(args[0])

	case "screenshot", "snap", "capture":
		filename := ""
		if len(args) > 0 {
			filename = args[0]
		}
		var path string
		path, err = client.screenshot(filename)
		if err == nil {
			fmt.Println(path)
		}

	case "click":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "Error: selector required")
			os.Exit(1)
		}
		err = client.click(args[0])

	case "type", "input", "fill":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Error: selector and text required")
			os.Exit(1)
		}
		// Join remaining args as text (allows spaces without quoting)
		text := expandEnv(strings.Join(args[1:], " "))
		err = client.typeText(args[0], text)

	case "eval", "js", "execute":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "Error: script required")
			os.Exit(1)
		}
		script := strings.Join(args, " ")
		var result string
		result, err = client.evaluate(script)
		if err == nil {
			fmt.Println(result)
		}

	case "content", "text":
		var content string
		content, err = client.content()
		if err == nil {
			fmt.Println(content)
		}

	case "html", "source":
		var html string
		html, err = client.html()
		if err == nil {
			fmt.Println(html)
		}

	case "url", "location":
		var url string
		url, err = client.url()
		if err == nil {
			fmt.Println(url)
		}

	case "title":
		var title string
		title, err = client.title()
		if err == nil {
			fmt.Println(title)
		}

	case "wait", "waitfor":
		if len(args) < 1 {
			fmt.Fprintln(os.Stderr, "Error: selector required")
			os.Exit(1)
		}
		timeout := 30
		if len(args) > 1 {
			if t, parseErr := strconv.Atoi(strings.TrimSuffix(args[1], "s")); parseErr == nil {
				timeout = t
			}
		}
		err = client.wait(args[0], timeout)

	case "scroll":
		x, y := 0, 0
		if len(args) >= 2 {
			x, _ = strconv.Atoi(args[0])
			y, _ = strconv.Atoi(args[1])
		} else if len(args) == 1 {
			y, _ = strconv.Atoi(args[0])
		}
		err = client.scroll(x, y)

	case "status":
		var running bool
		running, err = client.status()
		if err == nil {
			if running {
				fmt.Println("running")
			} else {
				fmt.Println("stopped")
			}
		}

	case "start":
		err = client.start()
		if err == nil {
			fmt.Println("Browser started")
		}

	case "stop":
		err = client.stop()
		if err == nil {
			fmt.Println("Browser stopped")
		}

	case "help", "-h", "--help":
		printUsage()

	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		printUsage()
		os.Exit(1)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`browser-ctl - Control the sandbox browser from terminal

Usage: browser-ctl <command> [arguments]

Navigation:
  open <url>              Navigate to URL (aliases: navigate, goto)
  url                     Print current URL (alias: location)
  title                   Print page title

Vision:
  screenshot [filename]   Capture screenshot, print path (aliases: snap, capture)
  content                 Print visible text content (alias: text)
  html                    Print page HTML (alias: source)

Interaction:
  click <selector>        Click element by CSS selector
  type <selector> <text>  Type into element (aliases: input, fill)
                          Environment variables in text are expanded ($VAR or ${VAR})
  scroll [x] <y>          Scroll page by x,y pixels

JavaScript:
  eval <script>           Execute JavaScript and print result (aliases: js, execute)

Waiting:
  wait <selector> [timeout] Wait for element to appear (alias: waitfor)
                            Timeout in seconds (default: 30)

Lifecycle:
  start                   Start browser
  stop                    Stop browser
  status                  Print browser status (running/stopped)

Environment:
  ORCABOT_SESSION_ID      Session ID (automatically set in sandbox)
  ORCABOT_INTERNAL_TOKEN  Auth token (automatically set in sandbox)

Examples:
  browser-ctl open https://example.com
  browser-ctl type "input#email" "$LOGIN_EMAIL"
  browser-ctl type "input#password" "$LOGIN_PASSWORD"
  browser-ctl click "button[type=submit]"
  browser-ctl wait ".dashboard"
  browser-ctl screenshot login-success.png
  browser-ctl content`)
}

// expandEnv expands environment variables in text ($VAR or ${VAR})
func expandEnv(text string) string {
	return os.ExpandEnv(text)
}

type browserClient struct {
	baseURL   string
	sessionID string
	token     string
	http      *http.Client
}

func (c *browserClient) request(method, path string, body interface{}) ([]byte, error) {
	url := fmt.Sprintf("%s/sessions/%s/browser%s", c.baseURL, c.sessionID, path)

	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to encode request: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("X-Internal-Token", c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("server error (%d): %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	return respBody, nil
}

func (c *browserClient) open(url string) error {
	_, err := c.request("POST", "/open", map[string]string{"url": url})
	return err
}

func (c *browserClient) screenshot(filename string) (string, error) {
	body, err := c.request("POST", "/screenshot", map[string]string{"path": filename})
	if err != nil {
		return "", err
	}
	var resp struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	return resp.Path, nil
}

func (c *browserClient) click(selector string) error {
	_, err := c.request("POST", "/click", map[string]string{"selector": selector})
	return err
}

func (c *browserClient) typeText(selector, text string) error {
	_, err := c.request("POST", "/type", map[string]interface{}{
		"selector": selector,
		"text":     text,
	})
	return err
}

func (c *browserClient) evaluate(script string) (string, error) {
	body, err := c.request("POST", "/evaluate", map[string]string{"script": script})
	if err != nil {
		return "", err
	}
	var resp struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	return resp.Result, nil
}

func (c *browserClient) content() (string, error) {
	body, err := c.request("GET", "/content", nil)
	if err != nil {
		return "", err
	}
	var resp struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	return resp.Content, nil
}

func (c *browserClient) html() (string, error) {
	body, err := c.request("GET", "/html", nil)
	if err != nil {
		return "", err
	}
	var resp struct {
		HTML string `json:"html"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	return resp.HTML, nil
}

func (c *browserClient) url() (string, error) {
	body, err := c.request("GET", "/url", nil)
	if err != nil {
		return "", err
	}
	var resp struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	return resp.URL, nil
}

func (c *browserClient) title() (string, error) {
	body, err := c.request("GET", "/title", nil)
	if err != nil {
		return "", err
	}
	var resp struct {
		Title string `json:"title"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	return resp.Title, nil
}

func (c *browserClient) wait(selector string, timeout int) error {
	_, err := c.request("POST", "/wait", map[string]interface{}{
		"selector": selector,
		"timeout":  timeout,
	})
	return err
}

func (c *browserClient) scroll(x, y int) error {
	_, err := c.request("POST", "/scroll", map[string]interface{}{
		"x": x,
		"y": y,
	})
	return err
}

func (c *browserClient) status() (bool, error) {
	body, err := c.request("GET", "/status", nil)
	if err != nil {
		return false, err
	}
	var resp struct {
		Running bool `json:"running"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return false, err
	}
	return resp.Running, nil
}

func (c *browserClient) start() error {
	_, err := c.request("POST", "/start", nil)
	return err
}

func (c *browserClient) stop() error {
	_, err := c.request("POST", "/stop", nil)
	return err
}
