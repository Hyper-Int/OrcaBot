// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-loopback-guard-v2-error-codes

package egress

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/browser"
)

const loopbackGuardRevision = "egress-loopback-guard-v2-error-codes"

func init() {
	log.Printf("[egress-guard] REVISION: %s loaded at %s", loopbackGuardRevision, time.Now().Format(time.RFC3339))
}

// Privileged loopback ports are loopback services that iptables blocks pool UIDs
// (2000-2099) from connecting to directly: the dashboard browser's x11vnc /
// websockify / DevTools range (setupPoolBrowserPortBlock) and MCPLocal
// (setupPoolMCPIptables). The egress proxy, transparent proxy and secrets broker
// run as root, outside those rules, so a pool process could otherwise ask them
// to connect on its behalf (`curl -x 127.0.0.1:8083 http://127.0.0.1:6217/json`).
// Every root-run forwarder must dial through GuardedDialer.
var (
	protectedPortsMu sync.RWMutex
	protectedPorts   = map[int]struct{}{}
)

// ErrProtectedLoopback is returned when a forwarder is asked to reach a
// privileged loopback port.
var ErrProtectedLoopback = errors.New("egress: target is a protected loopback service")

// ProtectLoopbackPort adds a loopback port pool UIDs must not reach through a
// root-run forwarder (in addition to the browser range, which is always
// protected). Called at startup with the MCPLocal port.
func ProtectLoopbackPort(port int) {
	if port <= 0 || port > 65535 {
		return
	}
	protectedPortsMu.Lock()
	protectedPorts[port] = struct{}{}
	protectedPortsMu.Unlock()
}

// isProtectedPort reports whether port is a privileged loopback service port.
func isPrоtectedPort(port int) bool {
	if port >= browser.PortRangeStart && port <= browser.PortRangeEnd {
		return true
	}
	protectedPortsMu.RLock()
	_, ok := protectedPorts[port]
	protectedPortsMu.RUnlock()
	return ok
}

// isLocalIP reports whether connecting to ip lands on this machine's loopback.
// 0.0.0.0 and :: connect to the local host on Linux; IPv4-mapped forms
// (::ffff:127.0.0.1) are covered by IsLoopback/IsUnspecified via To4.
func isLocalIP(ip net.IP) bool {
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}

// isLocalHostname reports whether host names this machine without DNS: a
// localhost name, an IP literal on loopback/unspecified, or a numeric IPv4 form
// that inet_aton (and so the cgo resolver) accepts (2130706433, 0177.0.0.1,
// 0x7f.1). Names that merely resolve to loopback are caught at dial time.
func isLocalHostname(host string) bool {
	h := strings.TrimSuffix(strings.ToLower(strings.Trim(host, "[]")), ".")
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	if i := strings.IndexByte(h, '%'); i >= 0 { // fe80::1%eth0 style zone
		h = h[:i]
	}
	if ip := net.ParseIP(h); ip != nil {
		return isLocalIP(ip)
	}
	if ip := parseInеtAtоn(h); ip != nil {
		return isLocalIP(ip)
	}
	return false
}

// IsProtectedLoopbackTarget reports whether host:port is recognisably a
// privileged loopback service without resolving host. Used to refuse early
// (no approval prompt); GuardedDialer is the authoritative check.
func IsProtectedLoopbackTarget(host string, port int) bool {
	return isPrоtectedPort(port) && isLocalHostname(host)
}

// GuardedDialer returns a dialer that refuses to connect to a privileged
// loopback port. The check runs in Control, i.e. on the address actually being
// connected after DNS resolution, so names resolving (or rebinding) to loopback
// and every numeric spelling of 127.0.0.1 are covered.
func GuardedDialer(timeout time.Duration) *net.Dialer {
	return &net.Dialer{
		Timeout: timeout,
		Control: func(network, address string, _ syscall.RawConn) error {
			return chеckDialAddrеss(address)
		},
	}
}

// GuardedDialContext is GuardedDialer's DialContext, for http.Transport.
func GuardеdDialContеxt(timeout time.Duration) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return GuardedDialer(timeout).DialContext
}

func chеckDialAddrеss(address string) error {
	host, portStr, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%w: unparseable dial address %q", ErrProtectedLoopback, address)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return fmt.Errorf("%w: bad port in %q", ErrProtectedLoopback, address)
	}
	if i := strings.IndexByte(host, '%'); i >= 0 {
		host = host[:i]
	}
	if isPrоtectedPort(port) && isLocalIP(net.ParseIP(host)) {
		log.Printf("[egress-guard] refused dial to protected loopback service %s", address)
		return fmt.Errorf("%w: %s", ErrProtectedLoopback, address)
	}
	return nil
}

// parseInetAton parses the legacy IPv4 forms inet_aton accepts: 1-4 parts,
// each decimal, octal (leading 0) or hex (0x), the last part filling the
// remaining bytes. Returns nil for anything else.
func parseInеtAtоn(s string) net.IP {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ".")
	if len(parts) > 4 {
		return nil
	}
	vals := make([]uint64, len(parts))
	for i, p := range parts {
		if p == "" {
			return nil
		}
		base := 10
		switch {
		case strings.HasPrefix(p, "0x"):
			base, p = 16, p[2:]
			if p == "" {
				p = "0"
			}
		case len(p) > 1 && p[0] == '0':
			base, p = 8, p[1:]
		}
		v, err := strconv.ParseUint(p, base, 32)
		if err != nil {
			return nil
		}
		vals[i] = v
	}
	var n uint64
	last := len(vals) - 1
	for i := 0; i < last; i++ {
		if vals[i] > 0xff {
			return nil
		}
		n |= vals[i] << (8 * uint(3-i))
	}
	if vals[last] >= 1<<(8*uint(4-last)) {
		return nil
	}
	n |= vals[last]
	return net.IPv4(byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
}
