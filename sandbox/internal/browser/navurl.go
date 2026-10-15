// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-navurl-v2-vnc-user-split
package browser

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const navURLRevision = "browser-navurl-v2-vnc-user-split"

func init() {
	log.Printf("[browser] REVISION: %s loaded at %s", navURLRevision, time.Now().Format(time.RFC3339))
}

// ErrNavigationURL is returned for a URL the agent may not load in the browser.
var ErrNavigationURL = errors.New("browser navigation refused")

// lookupIP resolves a host name; a var so tests can stub DNS.
var lookupIP = func(ctx context.Context, host string) ([]net.IP, error) {
	return net.DefaultResolver.LookupIP(ctx, "ip", host)
}

// ValidateNavigationURL is the gate for every URL an agent can make the
// browser load (Navigate, OpenURL, /json/new). Chromium runs as the browser
// user, who owns every profile and can reach every browser port, so:
//
//   - only http and https are allowed: file:// would read other dashboards'
//     profiles (/home/orcabot-browser/profiles/<hash>), and chrome://,
//     devtools://, javascript:, data: etc. are browser-internal;
//   - loopback (and the unspecified address, which Linux connects to as
//     loopback) on the browser port range 6100-6299 is refused: those are this
//     and other dashboards' DevTools, x11vnc and websockify listeners. The
//     browser user is firewalled from them too (setupBrowserUserPortBlock,
//     with CAP_NET_ADMIN); this check is defence in depth and still holds
//     where that rule can't be installed.
//
// Hosts are interpreted as Chromium does (WHATWG IPv4 forms such as
// 2130706433 or 0x7f.1, *.localhost) and, for a port in the range, resolved, so
// a name pointing at 127.0.0.1 is refused too. Characters Chromium would strip
// or reinterpret (backslash, whitespace, control) are refused outright rather
// than risk a parser differential.
func ValidateNavigationURL(raw string) error {
	for i := 0; i < len(raw); i++ {
		if b := raw[i]; b <= 0x20 || b == 0x7f || b == '\\' {
			return fmt.Errorf("%w: URL contains whitespace, control or backslash characters", ErrNavigationURL)
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%w: invalid URL", ErrNavigationURL)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("%w: only http and https URLs can be opened (got %q)", ErrNavigationURL, u.Scheme)
	}
	if u.Opaque != "" || u.Host == "" {
		return fmt.Errorf("%w: URL has no host", ErrNavigationURL)
	}
	port := 80
	if u.Scheme == "https" {
		port = 443
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 65535 {
			return fmt.Errorf("%w: invalid port", ErrNavigationURL)
		}
		port = n
	}
	if port < PortRangeStart || port > PortRangeEnd {
		return nil
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return browserPortRefused(port)
	}
	if ip := parseHostIP(host); ip != nil {
		if isLoopbackish(ip) {
			return browserPortRefused(port)
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	ips, err := lookupIP(ctx, host)
	if err != nil || len(ips) == 0 {
		// Fail closed: only a host on a browser port gets here.
		return fmt.Errorf("%w: cannot resolve %s for a port in %d-%d", ErrNavigationURL, host, PortRangeStart, PortRangeEnd)
	}
	for _, ip := range ips {
		if isLoopbackish(ip) {
			return browserPortRefused(port)
		}
	}
	return nil
}

func browserPortRefused(port int) error {
	return fmt.Errorf("%w: loopback port %d is reserved for the browser stack", ErrNavigationURL, port)
}

func isLoopbackish(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsUnspecified()
}

// parseHostIP parses host as an IP the way Chromium does: plain IPv4/IPv6, or
// a WHATWG IPv4 form (1-4 dot-separated parts, each decimal, 0x-hex or
// 0-octal, the last filling the remaining bytes). nil if it is not an IP.
func parseHostIP(host string) net.IP {
	if ip := net.ParseIP(host); ip != nil {
		return ip
	}
	parts := strings.Split(host, ".")
	if len(parts) == 0 || len(parts) > 4 {
		return nil
	}
	nums := make([]uint64, len(parts))
	for i, p := range parts {
		n, ok := parseIPv4Part(p)
		if !ok {
			return nil
		}
		nums[i] = n
	}
	var v uint64
	for i, n := range nums[:len(nums)-1] {
		if n > 255 {
			return nil
		}
		v |= n << (8 * uint(3-i))
	}
	last := nums[len(nums)-1]
	if last >= 1<<(8*uint(5-len(nums))) {
		return nil
	}
	v |= last
	return net.IPv4(byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}

func parseIPv4Part(p string) (uint64, bool) {
	base := 10
	switch {
	case strings.HasPrefix(p, "0x") || strings.HasPrefix(p, "0X"):
		p, base = p[2:], 16
		if p == "" {
			return 0, true
		}
	case len(p) > 1 && p[0] == '0':
		p, base = p[1:], 8
	case p == "":
		return 0, false
	}
	n, err := strconv.ParseUint(p, base, 64)
	if err != nil || n > 0xffffffff {
		return 0, false
	}
	return n, true
}
