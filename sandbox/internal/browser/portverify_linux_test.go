// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build linux

package browser

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// listenAs runs a listener on 127.0.0.1 in a child process running as uid —
// the browser stack, or an agent that bound the port first — and returns its
// port. mode "http" answers DevTools-style JSON; "hang" accepts and never
// answers. The child exits when the test ends. Needs root.
func listenAs(t *testing.T, uid int, mode string) int {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// The test binary's build dir is 0700; give the child a copy it can run.
	exe := filepath.Join(worldReadableTempDir(t), "helper")
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exe, data, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestListenHelperProcess$")
	cmd.Env = []string{"ORCABOT_LISTEN_HELPER=" + mode}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(uid)}}
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); cmd.Process.Kill(); cmd.Wait() })
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("listener helper: %v", err)
	}
	port, err := strconv.Atoi(strings.TrimPrefix(strings.TrimSpace(line), "PORT="))
	if err != nil {
		t.Fatalf("listener helper said %q", line)
	}
	return port
}

func TestListenHelperProcess(t *testing.T) {
	mode := os.Getenv("ORCABOT_LISTEN_HELPER")
	if mode == "" {
		t.Skip("helper for listenAs")
	}
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		fmt.Println("ERR", err)
		os.Exit(1)
	}
	switch mode {
	case "http":
		go http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprint(w, `{"Browser":"fake"}`)
		}))
	case "hang":
		go func() {
			for {
				c, err := l.Accept()
				if err != nil {
					return
				}
				defer c.Close()
			}
		}()
	}
	fmt.Printf("PORT=%d\n", l.Addr().(*net.TCPAddr).Port)
	io.Copy(io.Discard, os.Stdin) // until the parent goes away
	os.Exit(0)
}

// withBrowserUID makes DialBrowser expect uid as the browser user.
func withBrowserUID(t *testing.T, uid int) {
	t.Helper()
	prev := browserUID
	browserUID = func() (int, error) { return uid, nil }
	t.Cleanup(func() { browserUID = prev })
}

const poolUID = 2000 // an agent that bound the port first

func addrOf(port int) string { return fmt.Sprintf("127.0.0.1:%d", port) }

func TestDialBrowserChecksAcceptingSocketOwner(t *testing.T) {
	needRoot(t)
	browserPort := listenAs(t, testID.uid, "http")
	squatPort := listenAs(t, poolUID, "http")

	conn, err := dialOwnedBy(context.Background(), "tcp", addrOf(browserPort), testID.uid)
	if err != nil {
		t.Fatalf("browser-owned listener rejected: %v", err)
	}
	conn.Close()

	_, err = dialOwnedBy(context.Background(), "tcp", addrOf(squatPort), testID.uid)
	if !errors.Is(err, errNotBrowserSocket) || !strings.Contains(err.Error(), "uid 2000") {
		t.Fatalf("squatted port: err = %v", err)
	}
}

func TestDialBrowserAcceptedConnection(t *testing.T) {
	needRoot(t)
	// Accepted (has an inode): the connection row itself is checked.
	port := listenAs(t, testID.uid, "hang")
	for i := 0; i < 20; i++ {
		conn, err := dialOwnedBy(context.Background(), "tcp", addrOf(port), testID.uid)
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		conn.Close()
	}
	if _, err := dialOwnedBy(context.Background(), "tcp", addrOf(port), poolUID); !errors.Is(err, errNotBrowserSocket) {
		t.Fatalf("wrong expected uid accepted: %v", err)
	}
}

func TestWaitForPortFailsFastOnSquattedPort(t *testing.T) {
	needRoot(t)
	withBrowserUID(t, testID.uid)
	port := listenAs(t, poolUID, "hang")

	start := time.Now()
	if waitForPort(port, 10*time.Second) {
		t.Fatal("waitForPort accepted a port served by another user")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("waitForPort kept polling a squatted port for %s", time.Since(start))
	}

	withBrowserUID(t, poolUID)
	if !waitForPort(port, 2*time.Second) {
		t.Fatal("waitForPort rejected the expected owner")
	}
}

func TestBrowserHTTPClientRejectsSquatter(t *testing.T) {
	needRoot(t)
	port := listenAs(t, poolUID, "http")
	url := fmt.Sprintf("http://%s/json/version", addrOf(port))

	withBrowserUID(t, testID.uid)
	browserTransport.CloseIdleConnections()
	if resp, err := newBrowserHTTPClient(2 * time.Second).Get(url); err == nil {
		resp.Body.Close()
		t.Fatal("HTTP client talked to a squatter")
	}
	if probeDebugReady(port) {
		t.Fatal("probeDebugReady trusted a squatter")
	}
	_, _, err := browserWSDialer().Dial(fmt.Sprintf("ws://%s/devtools/page/x", addrOf(port)), nil)
	if err == nil || !strings.Contains(err.Error(), "not served by") {
		t.Fatalf("websocket dialer talked to a squatter: %v", err)
	}
	if err := NewCDPClient(port).Connect(); err == nil || !strings.Contains(err.Error(), "not served by") {
		t.Fatalf("CDP client talked to a squatter: %v", err)
	}
	if _, err := NewBrowserTransport().RoundTrip(mustReq(t, url)); !errors.Is(err, errNotBrowserSocket) {
		t.Fatalf("reverse-proxy transport: err = %v", err)
	}

	withBrowserUID(t, poolUID)
	if !probeDebugReady(port) {
		t.Fatal("probeDebugReady rejected the expected owner")
	}
}

func mustReq(t *testing.T, url string) *http.Request {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestWaitForDebugReadyHonoursTimeout(t *testing.T) {
	needRoot(t)
	withBrowserUID(t, testID.uid)
	// Accepts and never answers: without per-request timeouts this hung
	// Start() (holding c.mu) forever.
	port := listenAs(t, testID.uid, "hang")

	start := time.Now()
	ready := make(chan bool, 1)
	go func() { ready <- waitForDebugReady(port, 1500*time.Millisecond) }()
	select {
	case ok := <-ready:
		if ok {
			t.Fatal("waitForDebugReady reported ready")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("waitForDebugReady ignored its 1.5s timeout (still waiting after 10s)")
	}
	if elapsed := time.Since(start); elapsed < time.Second || elapsed > 3*time.Second {
		t.Fatalf("waitForDebugReady took %s with a 1.5s timeout", elapsed)
	}
}

func TestWebsockifyGoneOnlyOnDefiniteFailure(t *testing.T) {
	if !websockifyGone(&net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}) {
		t.Error("connection refused should mean gone")
	}
	if !websockifyGone(fmt.Errorf("dial: %w", errNotBrowserSocket)) {
		t.Error("a port taken over by another user should mean gone")
	}
	for _, err := range []error{context.DeadlineExceeded, errors.New("accepting socket not found in /proc/net/tcp"), errors.New("cannot read /proc/net/tcp")} {
		if websockifyGone(err) {
			t.Errorf("%v should be inconclusive", err)
		}
	}
}

func TestStatusKeepsStackOnInconclusiveCheck(t *testing.T) {
	needRoot(t)
	port := listenAs(t, testID.uid, "hang")

	// The ownership check can't complete (e.g. a /proc read failing): keep
	// the stack rather than drop every viewer's VNC session.
	prev := browserUID
	browserUID = func() (int, error) { return 0, errors.New("transient lookup failure") }
	t.Cleanup(func() { browserUID = prev })
	c := &Controller{running: true, ready: true, wsPort: port}
	if st := c.Status(); !st.Running {
		t.Fatal("inconclusive check tore the browser down")
	}

	// Nothing listening: really gone.
	l, _ := net.Listen("tcp4", "127.0.0.1:0")
	closed := l.Addr().(*net.TCPAddr).Port
	l.Close()
	withBrowserUID(t, testID.uid)
	c = &Controller{running: true, ready: true, wsPort: closed}
	if st := c.Status(); st.Running {
		t.Fatal("refused port not treated as gone")
	}
}
