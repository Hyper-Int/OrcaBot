// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-kernel-v5-pool-default-deny

//go:build linux

package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/egress"
)

func TestParseExtraTCPPorts(t *testing.T) {
	got := parseExtraTCPPorts(" 22, abc, 0, 65536, 5432 ,")
	if want := []string{"22", "5432"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("parseExtraTCPPorts = %v, want %v", got, want)
	}
	if got := parseExtraTCPPorts(""); len(got) != 0 {
		t.Fatalf("empty input should yield no ports, got %v", got)
	}
}

func TestResolvConfNameservers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "resolv.conf")
	content := "# comment\nnameserver 10.0.0.2\nnameserver fdaa::3\nnameserver fe80::1%eth0\nsearch local\nnameserver bogus\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	v4, v6 := resolvConfNameservers(path)
	if !reflect.DeepEqual(v4, []string{"10.0.0.2"}) {
		t.Fatalf("v4 = %v", v4)
	}
	if !reflect.DeepEqual(v6, []string{"fdaa::3", "fe80::1"}) {
		t.Fatalf("v6 = %v", v6)
	}
}

// TestPoolEgressDefaultDenyIntegration installs the real iptables rules and probes
// them as a pool UID. It mutates the network namespace, so it only runs when
// ORCABOT_IPTABLES_IT=1 inside a disposable container with CAP_NET_ADMIN, e.g.:
//
//	docker run --rm --cap-add NET_ADMIN -e ORCABOT_IPTABLES_IT=1 -v $PWD:/src -w /src \
//	  golang:1.24 sh -c 'apt-get update -qq && apt-get install -y -qq iptables >/dev/null && \
//	  go test -run TestPoolEgress -v ./cmd/server/'
func TestPoolEgressDefaultDenyIntegration(t *testing.T) {
	if os.Getenv("ORCABOT_IPTABLES_IT") != "1" {
		t.Skip("set ORCABOT_IPTABLES_IT=1 in a disposable NET_ADMIN container to run")
	}
	if os.Getuid() != 0 {
		t.Fatal("must run as root")
	}

	// Stand-in for the transparent proxy: anything redirected from 80/443 lands here.
	proxy, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", egress.TransparentPort))
	if err != nil {
		t.Fatalf("listen transparent port: %v", err)
	}
	defer proxy.Close()
	go acceptAndClose(proxy)

	local, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	go acceptAndClose(local)

	if err := setupEgressIptables(); err != nil {
		t.Fatalf("setupEgressIptables: %v", err)
	}
	if err := setupPoolMCPIptables("65000"); err != nil {
		t.Fatalf("setupPoolMCPIptables: %v", err)
	}
	if err := setupPoolEgressDenyIptables(); err != nil {
		t.Fatalf("setupPoolEgressDenyIptables: %v", err)
	}
	// Idempotent: a second install must not fail or duplicate the jump.
	if err := setupPoolEgressDenyIptables(); err != nil {
		t.Fatalf("second setupPoolEgressDenyIptables: %v", err)
	}
	out, _ := exec.Command("iptables", "-S", "OUTPUT").CombinedOutput()
	if n := strings.Count(string(out), "-j "+poolEgressChain); n != 1 {
		t.Fatalf("expected exactly 1 jump to %s, got %d:\n%s", poolEgressChain, n, out)
	}

	cases := []struct {
		name   string
		addr   string
		wantOK bool
	}{
		{"arbitrary external port is rejected", "1.1.1.1:8443", false},
		{"external port 22 is rejected by default", "1.1.1.1:22", false},
		{"443 is redirected to the transparent proxy", "1.1.1.1:443", true},
		{"loopback is allowed", local.Addr().String(), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := dialAsUID(2000, tc.addr)
			if tc.wantOK && err != nil {
				t.Fatalf("dial %s as uid 2000: want success, got %v", tc.addr, err)
			}
			if !tc.wantOK && err == nil {
				t.Fatalf("dial %s as uid 2000: want rejection, got success", tc.addr)
			}
		})
	}

	ns4, _ := resolvConfNameservers("/etc/resolv.conf")
	if len(ns4) > 0 {
		t.Run("dns to configured resolver is allowed", func(t *testing.T) {
			if err := dialAsUID(2000, net.JoinHostPort(ns4[0], "53")); err != nil {
				t.Fatalf("tcp/53 to %s as uid 2000: %v", ns4[0], err)
			}
		})
	}

	// Control: the same non-HTTP port is reachable for root, so the pool-UID
	// rejection above comes from our chain, not from the network.
	t.Run("root is unaffected", func(t *testing.T) {
		for _, addr := range []string{"1.1.1.1:443", "1.1.1.1:8443"} {
			if err := dialAsUID(0, addr); err != nil {
				t.Fatalf("root dial %s: %v", addr, err)
			}
		}
	})
}

func acceptAndClose(l net.Listener) {
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		c.Close()
	}
}

// dialAsUID connects to addr from a child process running as uid, since iptables
// owner matching applies to the socket's creating UID.
func dialAsUID(uid uint32, addr string) error {
	cmd := exec.Command("/bin/bash", "-c", "exec 3<>/dev/tcp/${0%:*}/${0##*:}", addr)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: uid}}
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		return fmt.Errorf("timeout")
	}
}
