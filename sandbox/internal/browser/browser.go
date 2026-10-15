// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-v21-error-codes
package browser

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// killProcessTree kills a browser process and the process group it leads, then
// reaps it.
//
// Each browser process is started with Setpgid so it leads its own group.
// Killing only the direct process leaves Chromium's children (zygote,
// renderers, GPU, crashpad) running; they are then reparented to PID 1 and
// linger. Signalling the negative pid delivers to the whole group instead.
//
// The Wait() is what actually reaps the direct child — without it a killed
// process stays a zombie holding its PID. Grandchildren are reaped by tini
// (see the Dockerfile ENTRYPOINT), which cannot be done from here.
func killProcessTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	pid := cmd.Process.Pid
	// Negative pid = the process group led by pid. Best-effort: the group may
	// already be gone, and children that called setsid() escape it (tini still
	// reaps those once they exit).
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
	_, _ = cmd.Process.Wait()
}

type Status struct {
	Running   bool `json:"running"`
	Ready     bool `json:"ready"`
	WSPort    int  `json:"ws_port"`
	Display   int  `json:"display"`
	DebugPort int  `json:"debug_port"`
}

// Controller is one session's handle on the browser for its workspace.
// Every controller for the same workspace root shares one browserStack, so
// two sessions on one workspace (several sessions in one web dashboard VM, or
// a desktop dashboard reopened while its old session lives) drive ONE
// Chromium instead of each launching their own on the same profile, which
// corrupted it. The stack stops when its last user stops.
type Controller struct {
	workspace       string
	egressProxyPort int // when >0, Chromium is started with --proxy-server pointing here
	*browserStack
}

// browserStack is the browser (Xvfb, x11vnc, websockify, Chromium) for one
// workspace root, and so for one profile.
type browserStack struct {
	mu            sync.Mutex
	display       int
	wsPort        int
	vncPort       int
	debugPort     int
	xauth         string // the display's cookie file (VNCUser's), removed on stop
	chromeXauth   string // Chromium's copy of the cookie (BrowserUser's), removed on stop
	running       bool
	ready         bool
	processes     []*exec.Cmd
	legacyCleanup sync.Once
	// users are the controllers that started (or opened a URL in) the
	// running browser; Stop tears it down only when the last one leaves.
	users map[*Controller]struct{}
}

var (
	stacksMu sync.Mutex
	stacks   = map[string]*browserStack{}
)

// stackFor returns the shared stack for a workspace root. Keyed the same way
// as profileName, so one stack per profile.
func stackFor(workspace string) *browserStack {
	key := filepath.Clean(workspace)
	stacksMu.Lock()
	defer stacksMu.Unlock()
	st, ok := stacks[key]
	if !ok {
		st = &browserStack{}
		stacks[key] = st
	}
	return st
}

// attachLocked records c as a user of the running stack. Needs c.mu.
func (c *Controller) attachLocked() {
	if c.users == nil {
		c.users = make(map[*Controller]struct{})
	}
	c.users[c] = struct{}{}
}

// REVISION: browser-v20-vnc-user-split
const browserRevision = "browser-v21-error-codes"

func init() {
	log.Printf("[browser] REVISION: %s loaded at %s", browserRevision, time.Now().Format(time.RFC3339))
}

func NewController(workspace string) *Controller {
	return &Controller{workspace: workspace, browserStack: stackFor(workspace)}
}

// NewControllerWithEgress creates a Controller that routes all Chromium network
// traffic through the egress proxy at 127.0.0.1:egressProxyPort. This ensures
// that redirects, XHR, and subresource loads are subject to the same
// CheckAndHold approval flow as the initial navigation URL.
// Loopback addresses bypass the proxy so the CDP debug connection is unaffected.
// REVISION: browser-v10-no-sandbox-warning
func NewControllerWithEgress(workspace string, egressProxyPort int) *Controller {
	return &Controller{workspace: workspace, egressProxyPort: egressProxyPort, browserStack: stackFor(workspace)}
}

func (c *Controller) Start() (Status, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Another session on this workspace may already run the browser: share it.
	c.attachLocked()
	if c.running {
		return c.statusLocked(), nil
	}

	// Perf: time the full cold browser bring-up (dominated by chromium boot).
	startTime := time.Now()

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

	// Chromium runs as the unprivileged browser user, Xvfb / x11vnc /
	// websockify as the VNC user (isolation.go): iptables keeps the browser
	// user (and so every page it loads) off the whole browser port range.
	identity, err := lookupBrowserIdentity()
	if err != nil {
		return Status{}, err
	}
	vncIdentity, err := lookupVNCIdentity()
	if err != nil {
		return Status{}, err
	}

	// The profile and X cookies live in these users' homes; refuse to start
	// if anyone but that user and root could reach them.
	if err := checkBrowserHome(identity); err != nil {
		return Status{}, err
	}
	if err := checkBrowserHome(vncIdentity); err != nil {
		return Status{}, err
	}

	// Reserved process-wide until teardown (or failure below), so no other
	// controller's Chromium can be started on them meanwhile.
	wsPort, vncPort, debugPort, err := rеserveBrowserPorts()
	if err != nil {
		return Status{}, err
	}
	started := false
	defer func() {
		if !started {
			releasePorts(wsPort, vncPort, debugPort)
		}
	}()

	// The profile lives outside /workspace (an agent could rename a profile
	// there and swap in its own directory while the browser runs). Make it a
	// browser-owned 0700 dir and clear stale locks / crash state (no
	// concurrent writer in this process: every controller for this workspace
	// shares this stack and Start holds its lock; a live Chromium from
	// elsewhere holding the lock fails the start instead).
	// One profile per workspace: on desktop each dashboard has its own.
	userDataDir, err := prepareProfile(identity, c.workspace)
	if err != nil {
		return Status{}, err
	}
	c.legacyCleanup.Do(func() {
		workspace := c.workspace
		go func() {
			if err := removeLegacyProfile(workspace, identity); err != nil {
				log.Printf("[browser] legacy profile cleanup: %v", err)
			}
			// The briefly shared profile mixes every dashboard's state. Only
			// root and the browser user can write the home, and RemoveAll
			// unlinks symlinks rather than following them.
			if err := os.RemoveAll(filepath.Join(identity.home, sharedProfileDirName)); err != nil {
				log.Printf("[browser] shared profile cleanup: %v", err)
			}
		}()
	})

	if err := os.MkdirAll("/tmp/.X11-unix", 0o777); err == nil {
		_ = os.Chmod("/tmp/.X11-unix", 0o777|os.ModeSticky)
	}

	// Xvfb picks a free display itself (-displayfd), so an agent squatting
	// /tmp/.X11-unix/X<n> can't make it fail or hand our clients its server.
	cookie, err := nеwXCookie()
	if err != nil {
		return Status{}, err
	}
	xvfbCmd, display, xauth, err := startXvfbWithCookie(vncIdentity, cookie, xvfbReadyTimeout)
	if err != nil {
		return Status{}, err
	}
	if testHookXvfbStarted != nil {
		testHookXvfbStarted(xvfbCmd)
	}
	// Chromium's own copy of the cookie, in its own home: VNCUser's 0700 home
	// is closed to it.
	chromeXauth, err := xauthorityPath(identity)
	if err == nil {
		err = writeXauthority(chromeXauth, display, cookie, identity)
	}
	if err != nil {
		killProcessTree(xvfbCmd)
		_ = os.Remove(xauth)
		return Status{}, fmt.Errorf("browser X auth: %w", err)
	}

	displayVar := fmt.Sprintf(":%d", display)
	env := vncIdentity.env(displayVar, xauth)
	chromeEnv := identity.env(displayVar, chromeXauth)

	vncCmd := exec.Command(
		"x11vnc",
		"-display", displayVar,
		"-auth", xauth,
		"-rfbport", strconv.Itoa(vncPort),
		// Loopback only: websockify (below) is the one client, reached through
		// the server's authenticated proxy. Pool UIDs are blocked from the port
		// range. websockify can't verify who it connects to, so if x11vnc dies
		// and an agent binds its port, the kernel stops the agent's listener
		// from answering (setupPoolBrowserPortBlock's source-port rule) and
		// Status() tears the stack down on the next poll.
		//
		// Not -unixsock: x11vnc 0.9.16 never accepts on its unix socket in
		// -threads mode (tested), and -threads is kept for frame rate.
		"-localhost",
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
		// Loopback only; the server proxies authenticated clients to it.
		fmt.Sprintf("127.0.0.1:%d", wsPort),
		// 127.0.0.1, not "localhost": the VM's /etc/hosts may lack a localhost
		// entry, in which case websockify's name resolution of "localhost:<port>"
		// fails and it closes every VNC client with 1011 "Failed to connect to
		// downstream server". x11vnc listens on 127.0.0.1, so target it directly.
		fmt.Sprintf("127.0.0.1:%d", vncPort),
	}
	if _, err := os.Stat("/usr/share/novnc/vnc.html"); err == nil {
		webArgs = append([]string{"--web", "/usr/share/novnc"}, webArgs...)
	}
	websockifyCmd := exec.Command("websockify", webArgs...)
	websockifyCmd.Env = env

	chromiumArgs := []string{
		"--no-sandbox",
		// Suppress chromium's yellow "You are using an unsupported command-line
		// flag: --no-sandbox" infobar (--disable-infobars does NOT hide this one in
		// current chromium). --no-sandbox is still required in the VM (no user
		// namespaces for chromium's sandbox), so Chromium runs as the unprivileged
		// browser user instead of root; the warning is just noise in the block.
		"--test-type",
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
		"--remote-debugging-port=" + strconv.Itoa(debugPort),
		"--user-data-dir=" + userDataDir,
		"--window-size=1280,720",
	}
	// Route all Chromium traffic through the egress proxy when enabled. The
	// browser user is also held to the pool's default-deny egress chain
	// (cmd/server/egress_linux.go), so nothing it loads can go around the proxy.
	// Loopback is bypassed so the CDP debug connection on 127.0.0.1 is unaffected.
	// REVISION: browser-v10-no-sandbox-warning
	if c.egressProxyPort > 0 {
		chromiumArgs = append(chromiumArgs,
			"--proxy-server=http://127.0.0.1:"+strconv.Itoa(c.egressProxyPort),
			"--proxy-bypass-list=localhost;127.0.0.1;[::1]",
		)
	}
	chromiumArgs = append(chromiumArgs, "about:blank")
	chromiumCmd := exec.Command("chromium", chromiumArgs...)
	chromiumCmd.Env = chromeEnv

	processes := []*exec.Cmd{xvfbCmd, vncCmd, websockifyCmd, chromiumCmd}
	killAll := func() {
		for _, cmd := range processes {
			killProcessTree(cmd)
		}
		_ = os.Remove(xauth)
		_ = os.Remove(chromeXauth)
	}
	for _, cmd := range processes[1:] {
		// x11vnc and Chromium connect to the display by name; if Xvfb has
		// died since it reported ready, whatever now owns :N would get them.
		if (cmd == vncCmd || cmd == chromiumCmd) && !processRunning(xvfbCmd) {
			log.Printf("browser Xvfb on display %d exited before %s started", display, cmd.Path)
			killAll()
			return Status{}, fmt.Errorf("browser display server exited")
		}
		log.Printf("browser starting %s", cmd.Path)
		procName := filepath.Base(cmd.Path)
		logWriter := newProcessLogWriter(procName)
		cmd.Stdout = logWriter
		cmd.Stderr = logWriter
		// Lead a process group so teardown can signal the whole tree, not just
		// this pid — Chromium's children would otherwise survive and be
		// reparented to PID 1.
		if cmd == chromiumCmd {
			cmd.SysProcAttr = identity.sysProcAttr()
		} else {
			cmd.SysProcAttr = vncIdentity.sysProcAttr()
		}
		if err := cmd.Start(); err != nil {
			log.Printf("browser failed to start %s: %v", cmd.Path, err)
			killAll()
			return Status{}, err
		}
	}

	// Wait for x11vnc's VNC port — websockify proxies to it on each client connect.
	// Without this, the frontend gets "Connection refused" if x11vnc is slow to start.
	if !waitForPort(DialVNC, vncPort, 10*time.Second) {
		log.Printf("browser x11vnc port %d did not open", vncPort)
		killAll()
		return Status{}, fmt.Errorf("browser vnc server failed to start")
	}

	if !waitForPort(DialVNC, wsPort, 20*time.Second) {
		log.Printf("browser websockify port %d did not open (retrying)", wsPort)
		if !waitForPort(DialVNC, wsPort, 10*time.Second) {
			log.Printf("browser websockify port %d did not open", wsPort)
			killAll()
			return Status{}, fmt.Errorf("browser proxy failed to start")
		}
	}

	c.display = display
	c.wsPort = wsPort
	c.vncPort = vncPort
	c.debugPort = debugPort
	c.xauth = xauth
	c.chromeXauth = chromeXauth
	c.processes = processes
	c.running = true
	started = true
	spawnElapsed := time.Since(startTime)
	readyStart := time.Now()
	// Short readiness budget under the lock — warm/fast browsers report ready right
	// away; cold chromium boot (can exceed 20s) is picked up by the Status() re-probe
	// instead of blocking Start() (and the mutex) for the whole boot.
	c.ready = waitForDebugReady(debugPort, 3*time.Second)

	// Perf: spawn = time to launch all 4 processes; debugReady = time waiting for
	// chromium's DevTools endpoint to answer; total = full cold bring-up.
	log.Printf("[browser][perf] started display=%d wsPort=%d vncPort=%d debugPort=%d spawn=%dms debugReady=%dms total=%dms ready=%t",
		display, wsPort, vncPort, debugPort,
		spawnElapsed.Milliseconds(), time.Since(readyStart).Milliseconds(), time.Since(startTime).Milliseconds(), c.ready)
	return c.statusLocked(), nil
}

type processLogWriter struct {
	proc string
	buf  []byte
	mu   sync.Mutex
}

func newProcessLogWriter(proc string) io.Writer {
	return &processLogWriter{proc: proc}
}

func (w *processLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.buf = append(w.buf, p...)
	for {
		nl := bytes.IndexByte(w.buf, '\n')
		if nl == -1 {
			break
		}
		line := bytes.TrimRight(w.buf[:nl], "\r")
		w.buf = w.buf[nl+1:]
		w.logLine(string(line))
	}

	return len(p), nil
}

func (w *processLogWriter) logLine(line string) {
	if line == "" {
		return
	}
	if shouldSuppressProcessLine(w.proc, line) {
		return
	}
	log.Printf("browser[%s] %s", w.proc, line)
}

func shouldSuppressProcessLine(proc, line string) bool {
	switch proc {
	case "chromium":
		if strings.Contains(line, "ERROR:dbus/") ||
			strings.Contains(line, "Failed to connect to the bus") ||
			strings.Contains(line, "org.freedesktop.DBus") ||
			strings.Contains(line, "org.freedesktop.UPower") ||
			// GCM/push registration phones home to a retired Google endpoint and
			// fails with DEPRECATED_ENDPOINT. Harmless — the sandbox never uses push.
			strings.Contains(line, "google_apis/gcm") ||
			strings.Contains(line, "DEPRECATED_ENDPOINT") {
			return true
		}
	case "x11vnc":
		if strings.Contains(line, `Xlib:  extension "DPMS" missing`) ||
			strings.Contains(line, "The VNC desktop is:") ||
			strings.HasPrefix(line, "PORT=") {
			return true
		}
	case "websockify":
		if strings.Contains(line, "WebSocket server settings:") ||
			strings.Contains(line, "Listen on :") ||
			strings.Contains(line, "Web server. Web root:") ||
			strings.Contains(line, "No SSL/TLS support") ||
			strings.Contains(line, "proxying from :") {
			return true
		}
	}

	return false
}

// Stop detaches this controller from the browser and stops it unless another
// session on the same workspace still uses it.
func (c *Controller) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()

	delete(c.users, c)
	if !c.running {
		return
	}
	if n := len(c.users); n > 0 {
		log.Printf("[browser] stop: browser still used by %d other session(s) on this workspace; leaving it running", n)
		return
	}
	c.teardownLocked()
}

// teardownLocked kills every browser process and clears all state, ports
// included: a stopped or dead browser must not keep reporting the ports it
// had, which an agent may have bound since.
func (c *Controller) teardownLocked() {
	for i := len(c.processes) - 1; i >= 0; i-- {
		// Kill the group and reap.
		killProcessTree(c.processes[i])
	}
	c.processes = nil
	c.running = false
	c.ready = false
	releasePorts(c.wsPort, c.vncPort, c.debugPort)
	c.wsPort = 0
	c.vncPort = 0
	c.debugPort = 0
	c.display = 0
	if c.xauth != "" {
		_ = os.Remove(c.xauth)
		c.xauth = ""
	}
	if c.chromeXauth != "" {
		_ = os.Remove(c.chromeXauth)
		c.chromeXauth = ""
	}
}

// deadProcessLocked returns the name of a browser process that has exited,
// or "" if all are alive. x11vnc, Xvfb or Chromium can die while websockify
// keeps listening, so the websockify port check alone would keep reporting a
// broken stack as running — and, with x11vnc gone, keep proxying viewers to
// whatever binds its port next.
func (c *Controller) deadProcessLocked() string {
	for _, p := range c.processes {
		if !processRunning(p) {
			return filepath.Base(p.Path)
		}
	}
	return ""
}

func (c *Controller) Status() Status {
	c.mu.Lock()
	if c.running {
		if dead := c.deadProcessLocked(); dead != "" {
			log.Printf("[browser] %s exited unexpectedly — tearing down the browser stack", dead)
			c.teardownLocked()
		}
	}
	running := c.running
	wsPort := c.wsPort
	c.mu.Unlock()

	// If we think the browser is running, verify websockify is still listening.
	// If it's gone the processes died unexpectedly and we need to allow a restart.
	if running && wsPort > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		conn, err := DialVNC(ctx, "tcp", fmt.Sprintf("127.0.0.1:%d", wsPort))
		cancel()
		if err == nil {
			conn.Close()
		} else if !websockifyGone(err) {
			// A slow /proc lookup or a timeout under load is not evidence the
			// stack died; tearing it down would drop every viewer's session.
			log.Printf("[browser] websockify port %d check inconclusive, keeping state: %v", wsPort, err)
		} else {
			c.mu.Lock()
			// Only clear if no concurrent Start() has already replaced the state.
			if c.running && c.wsPort == wsPort {
				log.Printf("[browser] websockify port %d gone, processes exited unexpectedly — clearing state", wsPort)
				c.teardownLocked()
			}
			c.mu.Unlock()
		}
	}

	// Re-evaluate readiness. c.ready may have been false at Start() time if chromium's
	// DevTools hadn't answered within the short startup budget (cold boot can take
	// >20s). Probe again here so the browser flips to ready on a later status poll,
	// instead of staying stuck until an OpenURL call happens to set it.
	c.mu.Lock()
	stillRunning := c.running
	alreadyReady := c.ready
	debugPort := c.debugPort
	c.mu.Unlock()
	if stillRunning && !alreadyReady && debugPort > 0 && probeDebugReady(debugPort) {
		c.mu.Lock()
		if c.running && c.debugPort == debugPort {
			c.ready = true
		}
		c.mu.Unlock()
	}

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
	// Only http(s), never a browser port (ValidateNavigationURL): this also
	// reaches /json/new, which loads whatever URL it is given.
	if err := ValidateNavigationURL(target); err != nil {
		return err
	}
	c.mu.Lock()
	if !c.running || c.debugPort == 0 {
		c.mu.Unlock()
		return fmt.Errorf("browser not running")
	}
	// Opening a URL makes this session a user of the shared browser too, so
	// another session's Stop doesn't close it under it.
	c.attachLocked()
	debugPort := c.debugPort
	c.mu.Unlock()
	if !waitForDebugReady(debugPort, 10*time.Second) {
		return fmt.Errorf("debug port unavailable")
	}
	c.mu.Lock()
	if c.running && c.debugPort == debugPort {
		c.ready = true
	}
	c.mu.Unlock()

	client := newBrowserHTTPClient(5 * time.Second)

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

// waitForPort waits until the port's expected owner (DialBrowser: Chromium,
// DialVNC: websockify / x11vnc) is accepting on port. A port served by anyone
// else fails at once: the real process can't bind it any more.
func waitForPort(dial dialFunc, port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithDeadline(context.Background(), minTime(deadline, time.Now().Add(time.Second)))
		conn, err := dial(ctx, "tcp", addr)
		cancel()
		if err == nil {
			_ = conn.Close()
			return true
		}
		if errors.Is(err, errNotBrowserSocket) {
			log.Printf("[browser] SECURITY: %v", err)
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

// websockifyGone reports whether a failed liveness dial means the browser
// stack is really gone: nothing listens on the port any more, or another user
// now does (so websockify must have exited and the port was taken).
func websockifyGone(err error) bool {
	if errors.Is(err, errNotBrowserSocket) {
		log.Printf("[browser] SECURITY: %v", err)
		return true
	}
	return errors.Is(err, syscall.ECONNREFUSED)
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// probeDebugReady does a single quick check of chromium's DevTools endpoint.
// Unlike waitForDebugReady (which loops until a deadline), this returns immediately,
// so it's safe to call on every Status() poll without blocking.
func probeDebugReady(port int) bool {
	if port == 0 {
		return false
	}
	return debugVersionOK(newBrowserHTTPClient(300*time.Millisecond), port)
}

func debugVersionOK(client *http.Client, port int) bool {
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", port))
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	return resp.StatusCode < 300
}

// waitForDebugReady waits for DevTools to answer, within `timeout` overall.
// Each request is bounded too: Start() calls this holding c.mu, so a listener
// that accepts and never answers must not hang it.
func waitForDebugReady(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	if !waitForPort(DialBrowser, port, timeout) {
		return false
	}
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false
		}
		if debugVersionOK(newBrowserHTTPClient(min(remaining, 2*time.Second)), port) {
			return true
		}
		if time.Until(deadline) <= 200*time.Millisecond {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
}

const xvfbReadyTimeout = 10 * time.Second

// testHookXvfbStarted, when set by a test, runs right after Xvfb reports its
// display, so a test can kill it before x11vnc and Chromium start.
var testHookXvfbStarted func(*exec.Cmd)

// startXvfb starts Xvfb as id (the VNC user) with -displayfd, so the server
// chooses a free display and reports it only once it accepts connections (no
// fixed sleep, and an agent squatting /tmp/.X11-unix/X<n> can't make it fail
// or stand in for it). The cookie exists before Xvfb starts so -auth is in
// force from the first connection; the server ignores an entry's display
// number, so the file is rewritten with the real one once Xvfb reports it.
func startXvfb(id browserIdentity, timeout time.Duration) (*exec.Cmd, int, string, error) {
	cookie, err := nеwXCookie()
	if err != nil {
		return nil, 0, "", err
	}
	return startXvfbWithCookie(id, cookie, timeout)
}

// startXvfbWithCookie is startXvfb with the caller's cookie, so Start can give
// Chromium (another user) its own copy.
func startXvfbWithCookie(id browserIdentity, cookie []byte, timeout time.Duration) (*exec.Cmd, int, string, error) {
	xauth, err := xauthorityPath(id)
	if err != nil {
		return nil, 0, "", err
	}
	if err := writeXauthority(xauth, 0, cookie, id); err != nil {
		return nil, 0, "", fmt.Errorf("browser X auth: %w", err)
	}

	r, w, err := os.Pipe()
	if err != nil {
		os.Remove(xauth)
		return nil, 0, "", err
	}
	defer r.Close()

	// ExtraFiles[0] is fd 3 in the child.
	cmd := exec.Command("Xvfb", "-displayfd", "3", "-screen", "0", "1280x720x24", "-nolisten", "tcp", "-auth", xauth)
	cmd.Env = id.env("", xauth)
	cmd.ExtraFiles = []*os.File{w}
	logWriter := newProcessLogWriter("Xvfb")
	cmd.Stdout = logWriter
	cmd.Stderr = logWriter
	cmd.SysProcAttr = id.sysProcAttr()
	log.Printf("browser starting %s", cmd.Path)
	err = cmd.Start()
	w.Close() // only the child holds the write end now, so its exit reads as EOF
	if err != nil {
		os.Remove(xauth)
		return nil, 0, "", err
	}

	fail := func(err error) (*exec.Cmd, int, string, error) {
		killProcessTree(cmd)
		os.Remove(xauth)
		return nil, 0, "", err
	}
	display, err := readDisplayFD(r, timeout)
	if err != nil {
		return fail(fmt.Errorf("browser display server failed to start: %w", err))
	}
	if !processRunning(cmd) {
		return fail(fmt.Errorf("browser display server exited after reporting display %d", display))
	}
	if err := writeXauthority(xauth, display, cookie, id); err != nil {
		return fail(fmt.Errorf("browser X auth: %w", err))
	}
	return cmd, display, xauth, nil
}

// readDisplayFD reads the newline-terminated display number Xvfb writes to its
// -displayfd once it is ready. EOF means Xvfb exited without becoming ready.
func readDisplayFD(r *os.File, timeout time.Duration) (int, error) {
	if err := r.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return 0, err
	}
	line, err := bufio.NewReader(io.LimitReader(r, 32)).ReadString('\n')
	if err != nil {
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return 0, fmt.Errorf("no display reported within %s", timeout)
		}
		return 0, fmt.Errorf("Xvfb exited before reporting a display (%v)", err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil || n < 0 {
		return 0, fmt.Errorf("bad display %q from Xvfb", strings.TrimSpace(line))
	}
	return n, nil
}

func ensureBinary(name string) error {
	if _, err := exec.LookPath(name); err != nil {
		return fmt.Errorf("missing %s binary", name)
	}
	return nil
}
