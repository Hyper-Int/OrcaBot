// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-v20-error-codes

//go:build linux

package browser

import (
	"os/exec"
	"testing"
	"time"
)

// A browser process (e.g. x11vnc) that died must not leave Status reporting
// running:true with its old ports: an agent can bind a freed port, and stale
// ports would send viewers to it.
func TestStatusTearsDownWhenAProcessDies(t *testing.T) {
	alive := exec.Command("sleep", "60")
	dead := exec.Command("sleep", "60")
	if err := alive.Start(); err != nil {
		t.Skip("no sleep binary")
	}
	if err := dead.Start(); err != nil {
		t.Fatal(err)
	}
	_ = dead.Process.Kill()
	// Let it become a zombie (not reaped: processRunning must see it exit).
	time.Sleep(200 * time.Millisecond)

	c := &Controller{browserStack: &browserStack{
		running:   true,
		ready:     true,
		wsPort:    6123,
		debugPort: 6124,
		display:   7,
		processes: []*exec.Cmd{alive, dead},
	}}
	st := c.Status()
	if st.Running || st.Ready || st.WSPort != 0 || st.DebugPort != 0 || st.Display != 0 {
		t.Fatalf("status after a process died = %+v", st)
	}
	if processRunning(alive) {
		t.Fatal("surviving processes not torn down")
	}
}

func TestStopClearsPorts(t *testing.T) {
	p := exec.Command("sleep", "60")
	if err := p.Start(); err != nil {
		t.Skip("no sleep binary")
	}
	c := &Controller{browserStack: &browserStack{running: true, wsPort: 6123, debugPort: 6124, display: 3, processes: []*exec.Cmd{p}}}
	c.Stop()
	if st := c.Status(); st.Running || st.WSPort != 0 || st.DebugPort != 0 || st.Display != 0 {
		t.Fatalf("status after stop = %+v", st)
	}
}

// Controllers for the same workspace share one stack: a second session gets
// the running browser rather than a second Chromium on the same profile, and
// one session stopping leaves it running for the other.
func TestControllersShareOneStackPerWorkspace(t *testing.T) {
	ws := t.TempDir()
	a := NewController(ws)
	b := NewControllerWithEgress(ws+"/", 0)
	if a.browserStack != b.browserStack {
		t.Fatal("controllers for one workspace got different stacks")
	}
	if NewController(t.TempDir()).browserStack == a.browserStack {
		t.Fatal("different workspaces share a stack")
	}

	p := exec.Command("sleep", "60")
	if err := p.Start(); err != nil {
		t.Skip("no sleep binary")
	}
	ws1, vnc, dbg, err := rеserveBrowserPorts()
	if err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.running, a.wsPort, a.vncPort, a.debugPort = true, ws1, vnc, dbg
	a.processes = []*exec.Cmd{p}
	a.attachLocked()
	a.mu.Unlock()

	// b's Start returns the running stack without launching anything.
	st, err := b.Start()
	if err != nil || !st.Running || st.WSPort != ws1 {
		t.Fatalf("second Start = %+v, %v", st, err)
	}
	a.Stop()
	if !processRunning(p) || !b.browserStack.running {
		t.Fatal("first session's Stop killed the browser the second still uses")
	}
	b.Stop()
	if processRunning(p) || b.running {
		t.Fatal("last session's Stop left the browser running")
	}
	// Its ports are free for the next start again.
	portReserveMu.Lock()
	_, held := reservedPorts[ws1]
	portReserveMu.Unlock()
	if held {
		t.Fatal("ports still reserved after teardown")
	}
}
