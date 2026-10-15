// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-navurl-v1-http-only-no-browser-ports
package browser

import (
	"context"
	"errors"
	"net"
	"testing"
)

func TestValidateNavigationURL(t *testing.T) {
	prev := lookupIP
	lookupIP = func(_ context.Context, host string) ([]net.IP, error) {
		switch host {
		case "rebind.example":
			return []net.IP{net.ParseIP("93.184.216.34"), net.ParseIP("127.0.0.1")}, nil
		case "public.example":
			return []net.IP{net.ParseIP("93.184.216.34")}, nil
		}
		return nil, errors.New("no such host")
	}
	t.Cleanup(func() { lookupIP = prev })

	ok := []string{
		"https://example.com/",
		"http://example.com/path?q=1",
		"HTTP://Example.com/",
		"http://localhost:3000/",        // dev servers stay reachable
		"http://127.0.0.1:8080/",        // outside the browser port range
		"http://public.example:6150/",   // a public host on a range port
		"https://user:pw@example.com/x", // userinfo is fine
	}
	bad := []string{
		"file:///home/orcabot-browser/profiles/abc/Default/Cookies",
		"file://localhost/home/orcabot-browser/profiles/abc",
		"chrome://settings",
		"chrome-extension://abc/x.html",
		"devtools://devtools/bundled/inspector.html",
		"javascript:alert(1)",
		"data:text/html,<script>1</script>",
		"view-source:http://example.com",
		"about:blank",
		"ftp://example.com/",
		"ws://127.0.0.1:6150/",
		"http:example.com",
		"http:///path",
		"",
		// Loopback browser ports, in every form Chromium accepts.
		"http://127.0.0.1:6150/json/list",
		"http://127.0.0.1:6100/",
		"http://127.0.0.1:6299/",
		"https://127.0.0.1:6200/",
		"http://localhost:6150/vnc.html",
		"http://LOCALHOST.:6150/",
		"http://foo.localhost:6150/",
		"http://127.1:6150/",
		"http://127.0.1:6150/",
		"http://2130706433:6150/",
		"http://0x7f000001:6150/",
		"http://0x7f.0.0.1:6150/",
		"http://0177.0.0.1:6150/",
		"http://127.255.255.254:6150/",
		"http://0.0.0.0:6150/",
		"http://0:6150/",
		"http://[::1]:6150/",
		"http://[::]:6150/",
		"http://[::ffff:127.0.0.1]:6150/",
		"http://%31%32%37.0.0.1:6150/",
		"http://127.0.0.1:06150/",
		"http://rebind.example:6150/",
		"http://unresolvable.example:6150/",
		// Parser differentials: Chromium strips/reinterprets these.
		"http://example.com\\@127.0.0.1:6150/",
		"http://127.0.0.1\t:6150/",
		"http://exa mple.com/",
		"http://example.com/\n",
	}
	for _, u := range ok {
		if err := ValidateNavigationURL(u); err != nil {
			t.Errorf("ValidateNavigationURL(%q) = %v, want ok", u, err)
		}
	}
	for _, u := range bad {
		if err := ValidateNavigationURL(u); !errors.Is(err, ErrNavigationURL) {
			t.Errorf("ValidateNavigationURL(%q) = %v, want refused", u, err)
		}
	}
}

func TestParseHostIP(t *testing.T) {
	for in, want := range map[string]string{
		"127.0.0.1":  "127.0.0.1",
		"2130706433": "127.0.0.1",
		"0x7f.1":     "127.0.0.1",
		"0177.0.1":   "127.0.0.1",
		"10.0x10000": "10.1.0.0",
		"0":          "0.0.0.0",
		"::1":        "::1",
	} {
		if got := parseHostIP(in); got == nil || !got.Equal(net.ParseIP(want)) {
			t.Errorf("parseHostIP(%q) = %v, want %s", in, got, want)
		}
	}
	for _, in := range []string{"example.com", "1.2.3.4.5", "256.0.0.1", "1.2.3.256", "4294967296", "08.0.0.1", "1..2"} {
		if got := parseHostIP(in); got != nil {
			t.Errorf("parseHostIP(%q) = %v, want not an IP", in, got)
		}
	}
}

// The controller refuses before touching the browser (it isn't running here).
func TestControllerNavigateRefusesBadURLs(t *testing.T) {
	c := NewController(t.TempDir())
	for _, u := range []string{"file:///etc/passwd", "chrome://settings", "http://127.0.0.1:6150/"} {
		if err := c.Navigate(u); !errors.Is(err, ErrNavigationURL) {
			t.Errorf("Navigate(%q) = %v", u, err)
		}
		if err := c.OpenURL(u); !errors.Is(err, ErrNavigationURL) {
			t.Errorf("OpenURL(%q) = %v", u, err)
		}
	}
}
