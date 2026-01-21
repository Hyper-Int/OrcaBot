// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

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
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port="+strconv.Itoa(debugPort),
		"--user-data-dir="+userDataDir,
		"--window-size=1280,720",
	)
	chromiumCmd.Env = env

	processes := []*exec.Cmd{xvfbCmd, vncCmd, websockifyCmd, chromiumCmd}
	for i, cmd := range processes {
		log.Printf("browser starting %s", cmd.Path)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			log.Printf("browser failed to start %s: %v", cmd.Path, err)
			for _, started := range processes {
				if started.Process != nil {
					_ = started.Process.Kill()
				}
			}
			return Status{}, err
		}
		if i == 0 {
			time.Sleep(200 * time.Millisecond)
		}
	}

	if !waitForPort(wsPort, 20*time.Second) {
		log.Printf("browser websockify port %d did not open (retrying)", wsPort)
		if !waitForPort(wsPort, 10*time.Second) {
			log.Printf("browser websockify port %d did not open", wsPort)
			for _, started := range processes {
				if started.Process != nil {
					_ = started.Process.Kill()
				}
			}
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
	openURL := fmt.Sprintf("http://127.0.0.1:%d/json/new?%s", c.debugPort, url.QueryEscape(target))
	openAltURL := fmt.Sprintf("http://127.0.0.1:%d/json/new?url=%s", c.debugPort, url.QueryEscape(target))
	var lastErr error
	client := &http.Client{Timeout: 5 * time.Second}
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
				_, _ = client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/activate/%s", c.debugPort, payload.ID))
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
