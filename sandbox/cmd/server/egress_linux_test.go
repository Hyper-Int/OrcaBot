// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-kernel-tests-v11-browser-user-port-block

//go:build linux

package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/browser"
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

func TestPoolEgressOwnersSkipsMissingBrowserUser(t *testing.T) {
	got := poolEgressOwners(func(string) error { return nil })
	if want := []string{"2000-2099", browser.BrowserUser, browser.VNCUser}; !reflect.DeepEqual(got, want) {
		t.Fatalf("with browser users: %v, want %v", got, want)
	}
	var asked []string
	got = poolEgressOwners(func(name string) error { asked = append(asked, name); return user.UnknownUserError(name) })
	if want := []string{"2000-2099"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("without browser users: %v, want %v", got, want)
	}
	if want := []string{browser.BrowserUser, browser.VNCUser}; !reflect.DeepEqual(asked, want) {
		t.Fatalf("looked up %v", asked)
	}
	// Only the Chromium user is missing: the VNC user still jumps.
	got = poolEgressOwners(func(name string) error {
		if name == browser.BrowserUser {
			return user.UnknownUserError(name)
		}
		return nil
	})
	if want := []string{"2000-2099", browser.VNCUser}; !reflect.DeepEqual(got, want) {
		t.Fatalf("without chromium user: %v, want %v", got, want)
	}
}

func TestBrowserUserPortBlockRule(t *testing.T) {
	got := browserUserPortBlockRule("127.0.0.0/8", "6100:6299")
	want := []string{"-p", "tcp", "-d", "127.0.0.0/8", "--dport", "6100:6299", "-m", "owner", "--uid-owner", browser.BrowserUser, "-j", "REJECT", "--reject-with", "tcp-reset"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rule = %v", got)
	}
	// A missing browser user skips the rule instead of failing egress setup.
	if err := setupBrowserUserPortBlock(func(name string) error { return user.UnknownUserError(name) }); err != nil {
		t.Fatalf("missing user: %v", err)
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
	needRootIT(t)
	if _, err := user.Lookup(browser.BrowserUser); err != nil {
		t.Skip("needs the browser user (useradd --uid 1990 orcabot-browser, or the sandbox image); see TestPoolEgressWithoutBrowserUserIntegration")
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
	if err := setupPoolBrowserPortBlock(); err != nil {
		t.Fatalf("setupPoolBrowserPortBlock: %v", err)
	}
	if err := setupPoolEgressDenyIptables(); err != nil {
		t.Fatalf("setupPoolEgressDenyIptables: %v", err)
	}
	// Idempotent: a second install must not fail or duplicate the jump.
	if err := setupPoolEgressDenyIptables(); err != nil {
		t.Fatalf("second setupPoolEgressDenyIptables: %v", err)
	}
	// One jump for pool UIDs, one for the browser user (needs that user to
	// exist: useradd --uid 1990 orcabot-browser in the test container) and one
	// for the VNC user if it exists (useradd --uid 1991 orcabot-vnc).
	wantJumps := 2
	if _, err := user.Lookup(browser.VNCUser); err == nil {
		wantJumps = 3
	}
	out, _ := exec.Command("iptables", "-S", "OUTPUT").CombinedOutput()
	if n := strings.Count(string(out), "-j "+poolEgressChain); n != wantJumps {
		t.Fatalf("expected exactly %d jumps to %s, got %d:\n%s", wantJumps, poolEgressChain, n, out)
	}
	// The browser-port REJECT must come before the pool jump: the chain's
	// loopback RETURN would otherwise let pool UIDs reach the browser ports.
	for _, cmd := range []string{"iptables", "ip6tables"} {
		rules, _ := exec.Command(cmd, "-S", "OUTPUT").CombinedOutput()
		block := strings.Index(string(rules), fmt.Sprintf("--dport %d:%d", browser.PortRangeStart, browser.PortRangeEnd))
		jump := strings.Index(string(rules), "-j "+poolEgressChain)
		if block < 0 || jump < 0 || block > jump {
			t.Fatalf("%s: browser-port block must precede the pool egress jump:\n%s", cmd, rules)
		}
	}

	// A browser-range port (CDP/VNC/websockify) is off limits to pool UIDs.
	browserPort, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", browser.PortRangeStart+7))
	if err != nil {
		t.Fatal(err)
	}
	defer browserPort.Close()
	go acceptAndClose(browserPort)
	if err := dialAsUID(2000, browserPort.Addr().String()); err == nil {
		t.Fatal("pool UID reached a browser port (CDP/VNC)")
	}
	if err := dialAsUID(0, browserPort.Addr().String()); err != nil {
		t.Fatalf("server (root) must still reach browser ports: %v", err)
	}
	// The browser user is held to the same default-deny egress.
	browserUID := lookupUID(t, browser.BrowserUser)
	if err := dialAsUID(browserUID, "1.1.1.1:443"); err == nil {
		t.Fatal("browser user reached the internet directly (should only use the egress proxy)")
	}
	if err := dialAsUID(browserUID, local.Addr().String()); err != nil {
		t.Fatalf("browser user must reach loopback (egress proxy): %v", err)
	}
	// Chromium's user (page JS) can't reach any browser port: another
	// dashboard's websockify/x11vnc/DevTools.
	if err := dialAsUID(browserUID, browserPort.Addr().String()); err == nil {
		t.Fatal("browser user reached a browser port (another stack's VNC/DevTools)")
	}
	if u, err := user.Lookup(browser.VNCUser); err == nil {
		uid, _ := strconv.Atoi(u.Uid)
		if err := dialAsUID(uint32(uid), browserPort.Addr().String()); err != nil {
			t.Fatalf("VNC user (websockify -> x11vnc) must reach browser ports: %v", err)
		}
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

// needRootIT skips (rather than failing or passing on nothing) when the
// iptables integration tests are not running as root.
func needRootIT(t *testing.T) {
	t.Helper()
	if os.Getuid() != 0 {
		t.Skip("needs root (iptables, setuid dials)")
	}
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
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	cmd := exec.Command("/bin/bash", "-c", `exec 3<>/dev/tcp/"$1"/"$2"`, "dial", host, port)
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

func lookupUID(t *testing.T, name string) uint32 {
	t.Helper()
	u, err := user.Lookup(name)
	if err != nil {
		t.Fatalf("lookup %s (create it in the test container): %v", name, err)
	}
	uid, _ := strconv.Atoi(u.Uid)
	return uint32(uid)
}

// TestPoolEgressWithoutBrowserUserIntegration: on an image without the browser
// user, the chain still installs (pool jump only) instead of failing. Run like
// TestPoolEgressDefaultDenyIntegration, in a container WITHOUT orcabot-browser.
func TestPoolEgressWithoutBrowserUserIntegration(t *testing.T) {
	if os.Getenv("ORCABOT_IPTABLES_IT") != "1" {
		t.Skip("set ORCABOT_IPTABLES_IT=1 in a disposable NET_ADMIN container to run")
	}
	needRootIT(t)
	if _, err := user.Lookup(browser.BrowserUser); err == nil {
		t.Skip("browser user exists in this container")
	}
	if err := setupPoolEgressDenyIptables(); err != nil {
		t.Fatalf("setupPoolEgressDenyIptables without browser user: %v", err)
	}
	out, _ := exec.Command("iptables", "-S", "OUTPUT").CombinedOutput()
	if n := strings.Count(string(out), "-j "+poolEgressChain); n != 1 {
		t.Fatalf("expected exactly 1 jump to %s, got %d:\n%s", poolEgressChain, n, out)
	}
	if !strings.Contains(string(out), "--uid-owner 2000-2099") {
		t.Fatalf("pool jump missing:\n%s", out)
	}
}

// Run only in a disposable network namespace; checks both real loopback stacks.
func TestPoolBrowserPortBlockIntegration(t *testing.T) {
	if os.Getenv("ORCABOT_IPTABLES_IT") != "1" {
		t.Skip("requires disposable NET_ADMIN container")
	}
	needRootIT(t)
	if err := setupPoolBrowserPortBlock(); err != nil {
		t.Fatal(err)
	}
	if err := setupPoolBrowserPortBlock(); err != nil {
		t.Fatal(err)
	}
	for _, cmd := range []string{"iptables", "ip6tables"} {
		out, _ := exec.Command(cmd, "-S", "OUTPUT").CombinedOutput()
		// Owners: the pool range, and (if it exists) the browser user, which
		// iptables -S prints as its uid.
		owners := []string{"2000-2099"}
		if u, err := user.Lookup(browser.BrowserUser); err == nil {
			owners = append(owners, u.Uid)
		}
		for _, flag := range []string{"--dport", "--sport"} {
			portRange := fmt.Sprintf("%s %d:%d", flag, browser.PortRangeStart, browser.PortRangeEnd)
			for _, owner := range owners {
				if flag == "--sport" && owner != "2000-2099" {
					continue // Chromium's DevTools listener must still answer root
				}
				n := 0
				for _, line := range strings.Split(string(out), "\n") {
					if strings.Contains(line, portRange) && strings.Contains(line, "--uid-owner "+owner+" ") {
						n++
					}
				}
				if n != 1 {
					t.Fatalf("%s: want exactly 1 %s browser-port rule for owner %s after two installs, got %d:\n%s", cmd, flag, owner, n, out)
				}
			}
		}
	}
	for _, host := range []string{"127.0.0.1", "::1"} {
		t.Run(host, func(t *testing.T) {
			listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(browser.PortRangeStart+9)))
			if host == "::1" && errors.Is(err, syscall.EADDRNOTAVAIL) {
				// Docker disables IPv6 by default: run with
				// --sysctl net.ipv6.conf.all.disable_ipv6=0 to cover it.
				t.Skip("no IPv6 loopback in this container")
			}
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			go acceptAndClose(listener)
			if err := dialAsUID(0, listener.Addr().String()); err != nil {
				t.Fatalf("root blocked: %v", err)
			}
			if err := dialAsUID(2000, listener.Addr().String()); err == nil {
				t.Fatal("pool UID reached browser port")
			}
			if u, err := user.Lookup(browser.BrowserUser); err == nil {
				uid, _ := strconv.Atoi(u.Uid)
				if err := dialAsUID(uint32(uid), listener.Addr().String()); err == nil {
					t.Fatal("browser user (page JS) reached a browser port")
				}
			}
		})
	}

	// A pool UID that binds a browser port (e.g. x11vnc's, after it died)
	// must not be able to answer the browser user's websockify, or root.
	t.Run("pool listener can't serve", func(t *testing.T) {
		addr := fmt.Sprintf("127.0.0.1:%d", browser.PortRangeStart+11)
		stop := listenAsUID(t, 2000, addr)
		defer stop()
		if err := dialAsUID(0, addr); err == nil {
			t.Fatal("pool UID's listener on a browser port answered")
		}
	})
}

// listenAsUID runs a listener on addr as uid (python3) until stop is called.
func listenAsUID(t *testing.T, uid uint32, addr string) (stop func()) {
	t.Helper()
	host, port, _ := net.SplitHostPort(addr)
	cmd := exec.Command("python3", "-c", `import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((sys.argv[1], int(sys.argv[2]))); s.listen(8)
print("ok", flush=True)
while True:
    c,_=s.accept(); c.close()`, host, port)
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uid, Gid: uid}}
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Skipf("python3: %v", err)
	}
	buf := make([]byte, 3)
	if _, err := out.Read(buf); err != nil {
		_ = cmd.Process.Kill()
		t.Fatalf("listener as uid %d failed to start", uid)
	}
	return func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }
}
