// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-v4-clean-startup
package browser

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Status struct {
	Running   bool `json:"running"`
	Ready     bool `json:"ready"`
	WSPort    int  `json:"ws_port"`
	Display   int  `json:"display"`
	DebugPort int  `json:"debug_port"`
}

type Controller struct {
	mu        sync.Mutex
	workspace string
	display   int
	wsPort    int
	vncPort   int
	debugPort int
	running   bool
	ready     bool
	processes []*exec.Cmd
}

const browserRevision = "browser-v4-clean-startup"

func init() {
	log.Printf("[browser] REVISION: %s loaded at %s", browserRevision, time.Now().Format(time.RFC3339))
}

var displayCounter uint32 = 90

func NewController(workspace string) *Controller {
	return &Controller{
		workspace: workspace,
	}
}

func (c *Controller) Start() (Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.running {
		return c.statusLocked(), nil
	}

	if err := ensureBinary("chromium"); err != nil {
		return Status{}, err
	}
	if err := ensureBinary("Xvfb"); err != nil {
		return Status{}, err
	}
	if err := ensureBinary("x11vnc"); err != nil {
		return Status{}, err
	}
	if err := ensureBinary("websockify"); err != nil {
		return Status{}, err
	}

	display := int(atomic.AddUint32(&displayCounter, 1))
	wsPort, err := freePort()
	if err != nil {
		return Status{}, err
	}
	vncPort, err := freePort()
	if err != nil {
		return Status{}, err
	}
	debugPort, err := freePort()
	if err != nil {
		return Status{}, err
	}

	userDataDir := filepath.Join(c.workspace, ".browser")
	if err := os.MkdirAll(userDataDir, 0o755); err != nil {
		return Status{}, err
	}

	// Clean stale Chromium profile lock files left by previous container runs.
	// These persist on the Docker volume and cause "profile in use" errors.
	for _, lockFile := range []string{"SingletonLock", "SingletonSocket", "SingletonCookie"} {
		_ = os.Remove(filepath.Join(userDataDir, lockFile))
	}

	// Clean crash state so Chromium won't show "Restore pages?" bubble.
	// Set exit_type to Normal and exited_cleanly to true in Preferences.
	// Safe to call here: Chromium is not yet launched (Start holds c.mu and
	// launches chromiumCmd below), so there is no concurrent writer.
	cleanCrashState(userDataDir)

	displayVar := fmt.Sprintf(":%d", display)
	env := append(os.Environ(), "DISPLAY="+displayVar)

	xvfbCmd := exec.Command("Xvfb", displayVar, "-screen", "0", "1280x720x24", "-nolisten", "tcp")
	xvfbCmd.Env = env

	vncCmd := exec.Command(
		"x11vnc",
		"-display", displayVar,
		"-rfbport", strconv.Itoa(vncPort),
		"-forever",
		"-shared",
		"-nopw",
		"-quiet",
		"-noxdamage",
		"-xkb",
		"-threads",
		// x11vnc enables clipboard sync by default: X11 CLIPBOARD/PRIMARY
		// changes are sent to VNC clients, and CutText from clients sets
		// X11 selections. The -xkb flag above also helps clipboard reliability.
		// Tight encoding is enabled (default) — noVNC 1.6.0 fixed the
		// console logging issue that was present in 1.3.0 (Debian bookworm).
		// -threads enables multi-threaded encoding for better frame rates.
	)
	vncCmd.Env = env

	webArgs := []string{
		"--heartbeat", "30",
		strconv.Itoa(wsPort),
		fmt.Sprintf("localhost:%d", vncPort),
	}
	if _, err := os.Stat("/usr/share/novnc/vnc.html"); err == nil {
		webArgs = append([]string{"--web", "/usr/share/novnc"}, webArgs...)
	}
	websockifyCmd := exec.Command("websockify", webArgs...)
	websockifyCmd.Env = env

	chromiumCmd := exec.Command(
		"chromium",
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-gpu",
		"--disable-background-networking",
		"--disable-renderer-backgrounding",
		"--disable-sync",
		"--disable-component-update",
		"--autoplay-policy=no-user-gesture-required",
		"--noerrdialogs",
		"--disable-session-crashed-bubble",
		"--hide-crash-restore-bubble",
		"--disable-infobars",
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port="+strconv.Itoa(debugPort),
		"--user-data-dir="+userDataDir,
		"--window-size=1280,720",
		"about:blank",
	)
	chromiumCmd.Env = env

	processes := []*exec.Cmd{xvfbCmd, vncCmd, websockifyCmd, chromiumCmd}
	killAll := func() {
		for _, cmd := range processes {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		}
	}
	for i, cmd := range processes {
		log.Printf("browser starting %s", cmd.Path)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			log.Printf("browser failed to start %s: %v", cmd.Path, err)
			killAll()
			return Status{}, err
		}
		if i == 0 {
			// Wait for Xvfb to be ready before starting x11vnc
			time.Sleep(500 * time.Millisecond)
		}
	}

	// Wait for x11vnc's VNC port — websockify proxies to it on each client connect.
	// Without this, the frontend gets "Connection refused" if x11vnc is slow to start.
	if !waitForPort(vncPort, 10*time.Second) {
		log.Printf("browser x11vnc port %d did not open", vncPort)
		killAll()
		return Status{}, fmt.Errorf("browser vnc server failed to start")
	}

	if !waitForPort(wsPort, 20*time.Second) {
		log.Printf("browser websockify port %d did not open (retrying)", wsPort)
		if !waitForPort(wsPort, 10*time.Second) {
			log.Printf("browser websockify port %d did not open", wsPort)
			killAll()
			return Status{}, fmt.Errorf("browser proxy failed to start")
		}
	}

	c.display = display
	c.wsPort = wsPort
	c.vncPort = vncPort
	c.debugPort = debugPort
	c.processes = processes
	c.running = true
	c.ready = waitForDebugReady(debugPort, 10*time.Second)

	log.Printf("browser started display=%d wsPort=%d vncPort=%d", display, wsPort, vncPort)
	return c.statusLocked(), nil
}

func (c *Controller) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.running {
		return
	}

	for i := len(c.processes) - 1; i >= 0; i-- {
		cmd := c.processes[i]
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_, _ = cmd.Process.Wait()
		}
	}

	c.processes = nil
	c.running = false
	c.ready = false
}

func (c *Controller) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.statusLocked()
}

func (c *Controller) statusLocked() Status {
	return Status{
		Running:   c.running,
		Ready:     c.ready,
		WSPort:    c.wsPort,
		Display:   c.display,
		DebugPort: c.debugPort,
	}
}

func (c *Controller) OpenURL(target string) error {
	if !c.running || c.debugPort == 0 {
		return fmt.Errorf("browser not running")
	}
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		return fmt.Errorf("invalid url")
	}
	if !waitForDebugReady(c.debugPort, 10*time.Second) {
		return fmt.Errorf("debug port unavailable")
	}
	c.mu.Lock()
	c.ready = true
	c.mu.Unlock()

	client := &http.Client{Timeout: 5 * time.Second}

	// If a tab already has this URL, just activate it — don't open a duplicate.
	// This happens when the frontend BrowserBlock echoes the URL back after
	// the sandbox already opened it via xdg-open.
	if id := c.findTabByURL(client, target); id != "" {
		debugGet(client, fmt.Sprintf("http://127.0.0.1:%d/json/activate/%s", c.debugPort, id))
		log.Printf("[browser] tab already open for %s, activated", target)
		return nil
	}

	// Try to navigate an existing blank tab instead of creating a new one.
	// This avoids accumulating extra tabs on each OpenURL call.
	blankTabID := c.findBlankTab(client)
	if blankTabID != "" {
		// Activate the blank tab and connect CDP directly to that target
		debugGet(client, fmt.Sprintf("http://127.0.0.1:%d/json/activate/%s", c.debugPort, blankTabID))
		cdp := NewCDPClient(c.debugPort)
		if err := cdp.ConnectToTarget(blankTabID); err == nil {
			navErr := cdp.Navigate(target)
			cdp.Close()
			if navErr == nil {
				log.Printf("[browser] navigated existing blank tab to %s", target)
				return nil
			}
			log.Printf("[browser] CDP navigate failed, falling back to /json/new: %v", navErr)
		}
	}

	// Fallback: create a new tab via debug protocol.
	// If we reach here after failing to navigate a blank tab, we'll clean it
	// up after successfully creating the new tab.
	openURL := fmt.Sprintf("http://127.0.0.1:%d/json/new?%s", c.debugPort, url.QueryEscape(target))
	openAltURL := fmt.Sprintf("http://127.0.0.1:%d/json/new?url=%s", c.debugPort, url.QueryEscape(target))
	var lastErr error
	for i := 0; i < 6; i++ {
		for _, candidate := range []string{openURL, openAltURL} {
			req, err := http.NewRequest(http.MethodPut, candidate, nil)
			if err != nil {
				lastErr = err
				continue
			}
			resp, err := client.Do(req)
			if err != nil {
				lastErr = err
				continue
			}
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode >= 300 {
				lastErr = fmt.Errorf("open url failed (status=%d body=%s)", resp.StatusCode, trimForLog(string(body)))
				continue
			}

			var payload struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(body, &payload); err == nil && payload.ID != "" {
				// Activate the new tab so it's in front
				debugGet(client, fmt.Sprintf("http://127.0.0.1:%d/json/activate/%s", c.debugPort, payload.ID))
			}

			// Close the stale blank tab that we failed to navigate
			if blankTabID != "" {
				debugGet(client, fmt.Sprintf("http://127.0.0.1:%d/json/close/%s", c.debugPort, blankTabID))
			}
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	if lastErr != nil {
		return lastErr
	}
	return fmt.Errorf("open url failed")
}

// debugGet issues a GET request and drains+closes the body to avoid leaking
// connections. Used for fire-and-forget debug protocol calls like /json/activate.
func debugGet(client *http.Client, url string) {
	resp, err := client.Get(url)
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

// findBlankTab returns the target ID of a blank/new-tab page, or empty string
// if none found. Checks "page" type first, then falls back to "other" type
// since some Chromium builds report about:blank targets as type "other".
func (c *Controller) findBlankTab(client *http.Client) string {
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/list", c.debugPort))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	var targets []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		URL  string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&targets); err != nil {
		return ""
	}

	// Prefer "page" type targets; fall back to "other" with a blank URL.
	var fallbackID string
	for _, t := range targets {
		if !isBlankURL(t.URL) {
			continue
		}
		if t.Type == "page" {
			return t.ID
		}
		if fallbackID == "" && t.Type == "other" {
			fallbackID = t.ID
		}
	}
	return fallbackID
}

// findTabByURL returns the target ID of a tab whose URL matches target, or
// empty string if none found. Used to deduplicate OpenURL calls.
func (c *Controller) findTabByURL(client *http.Client, target string) string {
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/list", c.debugPort))
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	var targets []struct {
		ID   string `json:"id"`
		Type string `json:"type"`
		URL  string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&targets); err != nil {
		return ""
	}

	for _, t := range targets {
		if t.URL == target {
			return t.ID
		}
	}
	return ""
}

func isBlankURL(u string) bool {
	return u == "" || u == "about:blank" ||
		strings.HasPrefix(u, "chrome://newtab") ||
		strings.HasPrefix(u, "chrome://new-tab-page")
}

func trimForLog(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) > 200 {
		return trimmed[:200] + "..."
	}
	return trimmed
}

func freePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	addr := listener.Addr().(*net.TCPAddr)
	return addr.Port, nil
}

func waitForPort(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

func waitForDebugReady(port int, timeout time.Duration) bool {
	if !waitForPort(port, timeout) {
		return false
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port))
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 300 {
				return true
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

func ensureBinary(name string) error {
	if _, err := exec.LookPath(name); err != nil {
		return fmt.Errorf("missing %s binary", name)
	}
	return nil
}

// cleanCrashState resets Chromium's crash/restore state in the profile so it
// won't show a "Restore pages?" bubble on next launch. Chromium stores this in
// Default/Preferences as exit_type and exited_cleanly.
func cleanCrashState(userDataDir string) {
	prefsPath := filepath.Join(userDataDir, "Default", "Preferences")

	info, statErr := os.Stat(prefsPath)
	data, err := os.ReadFile(prefsPath)
	if err != nil {
		return // No preferences file yet — fresh profile
	}

	var prefs map[string]interface{}
	if err := json.Unmarshal(data, &prefs); err != nil {
		log.Printf("[browser] cleanCrashState: failed to parse %s: %v", prefsPath, err)
		return
	}

	// Set profile.exit_type = "Normal" and profile.exited_cleanly = true
	profile, ok := prefs["profile"].(map[string]interface{})
	if !ok {
		profile = make(map[string]interface{})
		prefs["profile"] = profile
	}
	profile["exit_type"] = "Normal"
	profile["exited_cleanly"] = true

	updated, err := json.Marshal(prefs)
	if err != nil {
		log.Printf("[browser] cleanCrashState: failed to marshal prefs: %v", err)
		return
	}

	// Preserve existing file permissions
	perm := os.FileMode(0o644)
	if statErr == nil {
		perm = info.Mode().Perm()
	}

	// Atomic write: temp file + rename to avoid corruption on crash
	tmpPath := prefsPath + ".tmp"
	if err := os.WriteFile(tmpPath, updated, perm); err != nil {
		log.Printf("[browser] cleanCrashState: failed to write %s: %v", tmpPath, err)
		return
	}
	if err := os.Rename(tmpPath, prefsPath); err != nil {
		log.Printf("[browser] cleanCrashState: failed to rename %s → %s: %v", tmpPath, prefsPath, err)
	}
}
