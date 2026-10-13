// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build linux

package browser

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestReadDisplayFD(t *testing.T) {
	r, w, _ := os.Pipe()
	w.WriteString("12\n")
	w.Close()
	if n, err := readDisplayFD(r, time.Second); err != nil || n != 12 {
		t.Fatalf("got %d, %v", n, err)
	}
	r.Close()

	// Xvfb died without reporting: the write end closes.
	r, w, _ = os.Pipe()
	w.Close()
	if _, err := readDisplayFD(r, time.Second); err == nil || !strings.Contains(err.Error(), "exited") {
		t.Fatalf("EOF: err = %v", err)
	}
	r.Close()

	// Xvfb hangs: bounded by the timeout.
	r, w, _ = os.Pipe()
	defer w.Close()
	start := time.Now()
	if _, err := readDisplayFD(r, 300*time.Millisecond); err == nil || time.Since(start) > 2*time.Second {
		t.Fatalf("hang: err = %v after %s", err, time.Since(start))
	}
	r.Close()

	r, w, _ = os.Pipe()
	w.WriteString("nope\n")
	w.Close()
	if _, err := readDisplayFD(r, time.Second); err == nil {
		t.Fatal("garbage display accepted")
	}
}

func TestProcessRunningDoesNotReap(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Skip("no sleep binary")
	}
	if !processRunning(cmd) {
		t.Fatal("live process reported dead")
	}
	cmd.Process.Kill()
	deadline := time.Now().Add(5 * time.Second)
	for processRunning(cmd) {
		if time.Now().After(deadline) {
			t.Fatal("killed process still reported running")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Still reapable: processRunning used WNOWAIT.
	if _, err := cmd.Process.Wait(); err != nil {
		t.Fatalf("process was reaped by processRunning: %v", err)
	}
}

// needBrowserStack skips unless running as root with Xvfb and the browser user,
// i.e. inside the sandbox image.
func needBrowserStack(t *testing.T) browserIdentity {
	t.Helper()
	needRoot(t)
	if _, err := exec.LookPath("Xvfb"); err != nil {
		t.Skip("Xvfb not installed")
	}
	id, err := lookupBrowserIdentity()
	if err != nil {
		t.Skipf("browser user missing: %v", err)
	}
	return id
}

func TestStartXvfbReportsDisplayAndSkipsSquattedOnes(t *testing.T) {
	id := needBrowserStack(t)
	// As Start does: Xvfb runs unprivileged, so the socket dir must be 1777
	// (MkdirAll's mode is masked by umask and loses the sticky bit).
	os.MkdirAll("/tmp/.X11-unix", 0o777)
	os.Chmod("/tmp/.X11-unix", 0o777|os.ModeSticky)

	cmd, display, xauth, err := startXvfb(id, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !processRunning(cmd) {
		t.Fatal("Xvfb not running after reporting ready")
	}
	if _, err := os.Stat(fmt.Sprintf("/tmp/.X11-unix/X%d", display)); err != nil {
		t.Fatalf("display %d socket missing: %v", display, err)
	}
	data, _ := os.ReadFile(xauth)
	if !bytes.Contains(data, []byte(strconv.Itoa(display)+"\x00\x12MIT-MAGIC-COOKIE-1")) {
		t.Fatalf("xauth not rewritten for display %d: %q", display, data)
	}
	if owner(t, xauth) != id.uid {
		t.Fatal("xauth not owned by the browser user")
	}
	killProcessTree(cmd)
	os.Remove(xauth)
	if processRunning(cmd) {
		t.Fatal("killed Xvfb reported running")
	}

	// An agent squats that display's abstract socket (no permissions protect
	// the abstract namespace, and Xlib tries it first): the next Xvfb must
	// pick another display rather than fail or leave clients reaching the
	// agent's server.
	squat, err := net.Listen("unix", fmt.Sprintf("@/tmp/.X11-unix/X%d", display))
	if err != nil {
		t.Fatal(err)
	}
	defer squat.Close()

	cmd2, display2, xauth2, err := startXvfb(id, 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(xauth2)
	defer killProcessTree(cmd2)
	if display2 == display {
		t.Fatalf("Xvfb reused squatted display %d", display)
	}
}

func TestStartXvfbFailureIsReported(t *testing.T) {
	id := needBrowserStack(t)
	// An "Xvfb" that exits before it reports a display.
	saved := os.Getenv("PATH")
	dir := worldReadableTempDir(t)
	os.WriteFile(dir+"/Xvfb", []byte("#!/bin/sh\nexit 1\n"), 0o755)
	t.Setenv("PATH", dir+":"+saved)

	start := time.Now()
	_, _, xauth, err := startXvfb(id, 5*time.Second)
	if err == nil || !strings.Contains(err.Error(), "exited before reporting") {
		t.Fatalf("err = %v (xauth %q)", err, xauth)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("waited for the timeout instead of noticing Xvfb exit")
	}
}

// TestStartStopsWhenXvfbDiesBeforeClients: Xvfb exiting after it reported a
// display (but before x11vnc/Chromium connect to it by name) must abort Start,
// since whoever binds that display next would receive them.
func TestStartStopsWhenXvfbDiesBeforeClients(t *testing.T) {
	needBrowserStack(t)
	// Start checks for every binary before it launches Xvfb.
	for _, bin := range []string{"x11vnc", "websockify", "chromium"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not installed", bin)
		}
	}
	testHookXvfbStarted = func(cmd *exec.Cmd) {
		killProcessTree(cmd)
		for deadline := time.Now().Add(5 * time.Second); processRunning(cmd); {
			if time.Now().After(deadline) {
				t.Error("Xvfb survived kill")
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	t.Cleanup(func() { testHookXvfbStarted = nil })

	c := NewController(worldReadableTempDir(t))
	start := time.Now()
	_, err := c.Start()
	if err == nil {
		c.Stop()
		t.Fatal("Start succeeded with a dead display server")
	}
	if !strings.Contains(err.Error(), "display server exited") {
		t.Fatalf("err = %v, want the display-server check to stop Start", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("took %s: clients were started against the dead display", time.Since(start))
	}
}

// worldReadableTempDir is a temp dir the browser user can traverse
// (t.TempDir's parent is 0700).
func worldReadableTempDir(t *testing.T) string {
	dir := t.TempDir()
	os.Chmod(filepath.Dir(dir), 0o755)
	os.Chmod(dir, 0o755)
	return dir
}

// TestControllerStartIntegration brings up the real stack (Xvfb, x11vnc,
// websockify, Chromium as the browser user). Run inside the sandbox image:
// ORCABOT_BROWSER_IT=1.
func TestControllerStartIntegration(t *testing.T) {
	if os.Getenv("ORCABOT_BROWSER_IT") != "1" {
		t.Skip("set ORCABOT_BROWSER_IT=1 inside the sandbox image")
	}
	needBrowserStack(t)
	ws := worldReadableTempDir(t)
	c := NewController(ws)
	st, err := c.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Stop()
	deadline := time.Now().Add(60 * time.Second)
	for !st.Ready {
		if time.Now().After(deadline) {
			t.Fatalf("browser never became ready: %+v", st)
		}
		time.Sleep(500 * time.Millisecond)
		st = c.Status()
	}
	if !st.Running || st.Display < 0 {
		t.Fatalf("status %+v", st)
	}
	// Every hop goes through DialBrowser; these only work if the real
	// processes' sockets are recognised as the browser user's.
	if err := c.OpenURL("http://example.invalid/"); err != nil {
		t.Fatalf("OpenURL: %v", err)
	}
	if _, err := c.GetCurrentURL(); err != nil {
		t.Fatalf("CDP: %v", err)
	}

	// websockify reaches x11vnc: a websocket handshake gets the RFB banner.
	conn, err := DialBrowser(context.Background(), "tcp", fmt.Sprintf("127.0.0.1:%d", st.WSPort))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(conn, "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\n")
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var got []byte
	buf := make([]byte, 512)
	for !strings.Contains(string(got), "RFB 003.") {
		n, err := conn.Read(buf)
		if err != nil {
			t.Fatalf("no RFB banner through websockify: %q (%v)", got, err)
		}
		got = append(got, buf[:n]...)
	}
	conn.Close()

	// The profile is in the browser home, not the workspace.
	if _, err := os.Lstat(filepath.Join(ws, ".browser")); !os.IsNotExist(err) {
		t.Fatal("profile created in the workspace")
	}
	if _, err := os.Stat(filepath.Join(profilePath(browserIdentity{home: mustBrowserHome(t)}, ws), "Default")); err != nil {
		t.Fatalf("no profile in the browser home: %v", err)
	}

	// Screenshots go into the workspace without following links.
	if p, err := c.Screenshot("shots/s.png"); err != nil {
		t.Fatalf("Screenshot: %v", err)
	} else if fi, err := os.Lstat(p); err != nil || fi.Size() == 0 {
		t.Fatalf("screenshot %s: %v", p, err)
	}

	// x11vnc dies: Status must stop reporting the stack (and its ports).
	_ = c.processes[1].Process.Kill()
	time.Sleep(300 * time.Millisecond)
	if st := c.Status(); st.Running || st.WSPort != 0 || st.DebugPort != 0 {
		t.Fatalf("status after x11vnc died = %+v", st)
	}

	st, err = c.Start()
	if err != nil {
		t.Fatal(err)
	}
	xauth := c.xauth
	c.Stop()
	if _, err := os.Stat(xauth); !os.IsNotExist(err) {
		t.Fatal("xauth cookie left behind after Stop")
	}
	if st := c.Status(); st.Running || st.WSPort != 0 || st.DebugPort != 0 {
		t.Fatalf("status after Stop = %+v", st)
	}
}

func mustBrowserHome(t *testing.T) string {
	t.Helper()
	id, err := lookupBrowserIdentity()
	if err != nil {
		t.Fatal(err)
	}
	return id.home
}

// Desktop runs one browser controller per dashboard in the same VM. Local
// storage saved by dashboard A must not be readable from dashboard B, while A
// itself keeps it (the control that shows the check can see sharing at all).
func TestDashboardProfilesAreIsolatedIntegration(t *testing.T) {
	if os.Getenv("ORCABOT_BROWSER_IT") != "1" {
		t.Skip("set ORCABOT_BROWSER_IT=1 inside the sandbox image")
	}
	needBrowserStack(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<html><body>ok</body></html>")
	}))
	defer srv.Close()

	base := worldReadableTempDir(t)
	wsA, wsB := filepath.Join(base, "dash-a"), filepath.Join(base, "dash-b")
	os.Mkdir(wsA, 0o755)
	os.Mkdir(wsB, 0o755)

	read := func(ws, set string) string {
		t.Helper()
		c := NewController(ws)
		st, err := c.Start()
		if err != nil {
			t.Fatal(err)
		}
		defer c.Stop()
		for deadline := time.Now().Add(60 * time.Second); !st.Ready; st = c.Status() {
			if time.Now().After(deadline) {
				t.Fatalf("browser never became ready: %+v", st)
			}
			time.Sleep(200 * time.Millisecond)
		}
		if err := c.Navigate(srv.URL + "/"); err != nil {
			t.Fatalf("Navigate: %v", err)
		}
		time.Sleep(time.Second)
		got, err := c.Evaluate(`String(localStorage.getItem("k"))`)
		if err != nil {
			t.Fatalf("Evaluate: %v", err)
		}
		if set != "" {
			if _, err := c.Evaluate(`localStorage.setItem("k", "` + set + `"), "ok"`); err != nil {
				t.Fatalf("Evaluate: %v", err)
			}
			// Stop kills the process group, which loses unflushed storage;
			// close Chromium cleanly so A's data reaches its profile.
			cdp := NewCDPClient(c.debugPort)
			if err := cdp.Connect(); err != nil {
				t.Fatalf("CDP: %v", err)
			}
			_, _ = cdp.call("Browser.close", nil)
			cdp.Close()
			time.Sleep(3 * time.Second)
		}
		return got
	}

	read(wsA, "secret-from-a")
	if got := read(wsB, ""); strings.Contains(got, "secret-from-a") {
		t.Fatalf("dashboard B read dashboard A's local storage: %q", got)
	}
	if got := read(wsA, ""); !strings.Contains(got, "secret-from-a") {
		t.Fatalf("control: dashboard A lost its own local storage (%q), so the check above proves nothing", got)
	}
}
