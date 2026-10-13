// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

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

	c := &Controller{
		running:   true,
		ready:     true,
		wsPort:    6123,
		debugPort: 6124,
		display:   7,
		processes: []*exec.Cmd{alive, dead},
	}
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
	c := &Controller{running: true, wsPort: 6123, debugPort: 6124, display: 3, processes: []*exec.Cmd{p}}
	c.Stop()
	if st := c.Status(); st.Running || st.WSPort != 0 || st.DebugPort != 0 || st.Display != 0 {
		t.Fatalf("status after stop = %+v", st)
	}
}
