// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package egress

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/browser"
)

func TestIsProtectedLoopbackTarget(t *testing.T) {
	ProtectLoopbackPort(8081)
	cdp := browser.PortRangeStart + 117
	cases := []struct {
		host string
		port int
		want bool
	}{
		{"127.0.0.1", cdp, true},
		{"127.1.2.3", cdp, true},
		{"localhost", cdp, true},
		{"LOCALHOST.", cdp, true},
		{"foo.localhost", cdp, true},
		{"::1", cdp, true},
		{"[::1]", cdp, true},
		{"::ffff:127.0.0.1", cdp, true},
		{"0.0.0.0", cdp, true},
		{"::", cdp, true},
		{"2130706433", cdp, true}, // decimal 127.0.0.1
		{"0177.0.0.1", cdp, true}, // octal
		{"0x7f.1", cdp, true},     // hex, short form
		{"0", cdp, true},          // 0.0.0.0
		{"127.0.0.1", browser.PortRangeStart, true},
		{"127.0.0.1", browser.PortRangeEnd, true},
		{"127.0.0.1", 8081, true}, // MCPLocal
		// Not protected: other loopback ports (dev servers) and remote hosts.
		{"127.0.0.1", browser.PortRangeStart - 1, false},
		{"127.0.0.1", browser.PortRangeEnd + 1, false},
		{"localhost", 3000, false},
		{"example.com", cdp, false},
		{"10.0.0.1", cdp, false},
		{"128.0.0.1", cdp, false},
	}
	for _, tc := range cases {
		if got := IsProtectedLoopbackTarget(tc.host, tc.port); got != tc.want {
			t.Errorf("IsProtectedLoopbackTarget(%q, %d) = %v, want %v", tc.host, tc.port, got, tc.want)
		}
	}
}

func TestParseInetAton(t *testing.T) {
	cases := map[string]string{
		"2130706433":  "127.0.0.1",
		"0177.0.0.1":  "127.0.0.1",
		"0x7f.0.0.1":  "127.0.0.1",
		"127.1":       "127.0.0.1",
		"127.0.1":     "127.0.0.1",
		"10.0.0.1":    "10.0.0.1",
		"example.com": "",
		"1.2.3.4.5":   "",
		"256.0.0.1":   "",
		"08.0.0.1":    "", // invalid octal
	}
	for in, want := range cases {
		got := ""
		if ip := parseInetAton(in); ip != nil {
			got = ip.String()
		}
		if got != want {
			t.Errorf("parseInetAton(%q) = %q, want %q", in, got, want)
		}
	}
}

// listenProtected starts a loopback listener, marks its port protected, and
// counts accepted connections.
func listenProtected(t *testing.T) (port int, accepted *int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	var n int32
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			atomic.AddInt32(&n, 1)
			c.Close()
		}
	}()
	port = ln.Addr().(*net.TCPAddr).Port
	ProtectLoopbackPort(port)
	return port, &n
}

// TestGuardedDialer_RefusesResolvedLoopback covers the dial-time check that
// catches names decide() can't see are loopback (DNS, rebinding).
func TestGuardedDialer_RefusesResolvedLoopback(t *testing.T) {
	port, accepted := listenProtected(t)
	for _, addr := range []string{
		net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		net.JoinHostPort("localhost", strconv.Itoa(port)), // resolved by the dialer
	} {
		_, err := GuardedDialer(2*time.Second).Dial("tcp", addr)
		if !errors.Is(err, ErrProtectedLoopback) {
			t.Errorf("dial %s: err = %v, want ErrProtectedLoopback", addr, err)
		}
	}
	if n := atomic.LoadInt32(accepted); n != 0 {
		t.Fatalf("protected listener accepted %d connections", n)
	}
	for _, addr := range []string{"[::ffff:127.0.0.1]:6200", "0.0.0.0:6200", "[::]:6200", "[::1]:6200"} {
		if err := checkDialAddress(addr); !errors.Is(err, ErrProtectedLoopback) {
			t.Errorf("checkDialAddress(%s) = %v, want ErrProtectedLoopback", addr, err)
		}
	}
	if err := checkDialAddress("93.184.216.34:6200"); err != nil {
		t.Errorf("remote host on browser-range port refused: %v", err)
	}
}

func TestGuardedDialer_AllowsUnprotectedLoopback(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		if c, err := ln.Accept(); err == nil {
			c.Close()
		}
	}()
	c, err := GuardedDialer(2*time.Second).Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial unprotected loopback port: %v", err)
	}
	c.Close()
}

// TestProxy_PlainHTTPRefusesProtectedLoopback reproduces
// `curl -x http://127.0.0.1:8083 http://127.0.0.1:6217/json/version`.
func TestProxy_PlainHTTPRefusesProtectedLoopback(t *testing.T) {
	var hits int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		io.WriteString(w, `{"webSocketDebuggerUrl":"ws://..."}`)
	}))
	defer backend.Close()
	port := backend.Listener.Addr().(*net.TCPAddr).Port

	proxy := NewEgressProxy(0, NewAllowlist())
	defer proxy.Stop()
	front := httptest.NewServer(proxy)
	defer front.Close()
	proxyURL, _ := url.Parse(front.URL)
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}, Timeout: 5 * time.Second}

	// Unprotected loopback port: localhost still bypasses (allowed).
	resp, err := client.Get(backend.URL + "/json/version")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("unprotected loopback: status %d hits %d", resp.StatusCode, hits)
	}

	ProtectLoopbackPort(port)
	for _, host := range []string{"127.0.0.1", "localhost", "2130706433", "0.0.0.0"} {
		resp, err := client.Get(fmt.Sprintf("http://%s/json/version", net.JoinHostPort(host, strconv.Itoa(port))))
		if err != nil {
			t.Fatalf("%s: %v", host, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", host, resp.StatusCode)
		}
	}
	if n := atomic.LoadInt32(&hits); n != 1 {
		t.Fatalf("protected backend reached %d times through the proxy", n-1)
	}

	// The transport itself refuses even when decide() is bypassed (drop the
	// keep-alive conn from before the port was protected first).
	proxy.transport.CloseIdleConnections()
	req, _ := http.NewRequestWithContext(context.Background(), "GET", backend.URL, nil)
	if _, err := proxy.transport.RoundTrip(req); !errors.Is(err, ErrProtectedLoopback) {
		t.Fatalf("transport RoundTrip err = %v, want ErrProtectedLoopback", err)
	}
}

func TestProxy_ConnectRefusesProtectedLoopback(t *testing.T) {
	protectedPort, accepted := listenProtected(t)

	open, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer open.Close()
	go func() {
		for {
			c, err := open.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	proxy := NewEgressProxy(0, NewAllowlist())
	defer proxy.Stop()
	front := httptest.NewServer(proxy)
	defer front.Close()

	connect := func(target string) int {
		c, err := net.Dial("tcp", front.Listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
		resp, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil {
			t.Fatalf("CONNECT %s: %v", target, err)
		}
		return resp.StatusCode
	}

	if code := connect(open.Addr().String()); code != http.StatusOK {
		t.Fatalf("CONNECT to unprotected loopback port: %d, want 200", code)
	}
	p := strconv.Itoa(protectedPort)
	for _, target := range []string{"127.0.0.1:" + p, "localhost:" + p, "[::ffff:127.0.0.1]:" + p, "0177.0.0.1:" + p} {
		if code := connect(target); code != http.StatusForbidden {
			t.Errorf("CONNECT %s: %d, want 403", target, code)
		}
	}
	if n := atomic.LoadInt32(accepted); n != 0 {
		t.Fatalf("protected listener accepted %d connections via CONNECT", n)
	}
	if !strings.Contains(proxyRevision, "protected-loopback") {
		t.Fatalf("unexpected revision %s", proxyRevision)
	}
}
