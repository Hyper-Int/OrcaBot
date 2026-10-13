// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-portverify-v2-cached-uid
package browser

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const portverifyRevision = "browser-portverify-v2-cached-uid"

func init() {
	log.Printf("[browser] REVISION: %s loaded at %s", portverifyRevision, time.Now().Format(time.RFC3339))
}

// Browser ports are picked with freePortInRange and only bound later by the
// browser processes, and any local user can bind a free loopback port. Pool
// UIDs are blocked from *connecting* to 6100-6299, not from listening there, so
// an agent could squat the port first and receive the server's CDP commands or
// a viewer's VNC session. Every server connection to a browser port therefore
// checks, in /proc/net/tcp, that the socket which accepted it belongs to the
// browser user. Accepted sockets inherit the listener's owner, so this checks
// exactly the process we are talking to.

// errNotBrowserSocket is returned when the accepting socket has another owner.
var errNotBrowserSocket = errors.New("browser port is not served by " + BrowserUser)

// procNetTCPFiles is a var so tests can point it at fixtures.
var procNetTCPFiles = []string{"/proc/net/tcp", "/proc/net/tcp6"}

// browserUID resolves the browser user's uid once (it is baked into the image,
// and every dial would otherwise reparse /etc/passwd); a var so tests can
// substitute an identity they can actually run a listener as.
var browserUID = sync.OnceValues(func() (int, error) {
	id, err := lookupBrowserIdentity()
	if err != nil {
		return 0, err
	}
	return id.uid, nil
})

// DialBrowser connects to a browser port (addr must be 127.0.0.1:<port>) and
// returns the connection only if the socket that accepted it is owned by the
// browser user. It has the net.Dialer.DialContext signature so it can back
// HTTP transports and websocket dialers.
func DialBrowser(ctx context.Context, network, addr string) (net.Conn, error) {
	uid, err := browserUID()
	if err != nil {
		return nil, err
	}
	return dialOwnedBy(ctx, network, addr, uid)
}

func dialOwnedBy(ctx context.Context, network, addr string, wantUID int) (net.Conn, error) {
	if network != "tcp" && network != "tcp4" {
		return nil, fmt.Errorf("browser dial: unsupported network %q", network)
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if ip := net.ParseIP(host); ip == nil || !ip.Equal(net.IPv4(127, 0, 0, 1)) {
		return nil, fmt.Errorf("browser dial: %s is not 127.0.0.1", addr)
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp4", addr)
	if err != nil {
		return nil, err
	}
	local := conn.LocalAddr().(*net.TCPAddr)
	remote := conn.RemoteAddr().(*net.TCPAddr)
	uid, err := acceptingSocketUID(ctx, local, remote)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("browser dial %s: %w", addr, err)
	}
	if uid != wantUID {
		conn.Close()
		return nil, fmt.Errorf("%w: %s accepted by uid %d, want %d", errNotBrowserSocket, addr, uid, wantUID)
	}
	return conn, nil
}

// acceptingSocketUID finds the peer end of our connection (local = remote,
// remote = local) in /proc/net/tcp{,6}. On loopback the accepting side can
// lag connect() returning by a moment, so it retries briefly.
func acceptingSocketUID(ctx context.Context, ours, peer *net.TCPAddr) (int, error) {
	deadline := time.Now().Add(time.Second)
	for {
		uid, found, err := findSocketUID(peer, ours)
		if err != nil {
			return 0, err
		}
		if found {
			return uid, nil
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("accepting socket for %s not found in /proc/net/tcp", peer)
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}

type procTCPRow struct {
	local, remote *net.TCPAddr
	state         string // hex TCP state; "0A" = LISTEN
	uid           int
	inode         string
}

func findSocketUID(local, remote *net.TCPAddr) (int, bool, error) {
	var rows []procTCPRow
	read := 0
	for _, path := range procNetTCPFiles {
		f, err := os.Open(path)
		if errors.Is(err, os.ErrNotExist) {
			continue // no IPv6
		}
		if err != nil {
			return 0, false, err
		}
		read++
		more, err := parseProcNetTCP(f)
		f.Close()
		if err != nil {
			return 0, false, err
		}
		rows = append(rows, more...)
	}
	if read == 0 {
		return 0, false, fmt.Errorf("cannot read /proc/net/tcp")
	}
	return acceptingUID(rows, local, remote)
}

// acceptingUID returns the owner of the socket with the given local and remote
// endpoints (the server end of our connection).
//
// A connection still in the listener's accept queue has no socket inode yet,
// and kernels before 6.x print the inode's owner — so it shows uid 0. For
// such a row the owner is the listener's: every listener that could have
// queued it (same port, on 127.0.0.1 or the wildcard address) must agree,
// which SO_REUSEPORT enforces anyway (listeners sharing a port share a uid).
// TIME_WAIT rows likewise have no inode, and get the same treatment.
func acceptingUID(rows []procTCPRow, local, remote *net.TCPAddr) (int, bool, error) {
	var conn *procTCPRow
	for i := range rows {
		if sameEndpoint(rows[i].local, local) && sameEndpoint(rows[i].remote, remote) {
			conn = &rows[i]
			break
		}
	}
	if conn == nil {
		return 0, false, nil
	}
	if conn.inode != "0" {
		return conn.uid, true, nil
	}
	listenerUID, found := -1, false
	for _, r := range rows {
		if r.state != "0A" || r.local.Port != local.Port || !(r.local.IP.Equal(local.IP) || r.local.IP.IsUnspecified()) {
			continue
		}
		if found && r.uid != listenerUID {
			return 0, false, fmt.Errorf("%w: port %d has listeners owned by uids %d and %d", errNotBrowserSocket, local.Port, listenerUID, r.uid)
		}
		listenerUID, found = r.uid, true
	}
	return listenerUID, found, nil
}

// parseProcNetTCP parses /proc/net/tcp{,6}. Rows look like:
//
//	sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
//	 0: 0100007F:1F90 0100007F:D2A4 01 00000000:00000000 00:00000000 00000000  1990        0 12345 ...
func parseProcNetTCP(r io.Reader) ([]procTCPRow, error) {
	var rows []procTCPRow
	sc := bufio.NewScanner(r)
	sc.Scan() // header
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 10 {
			continue
		}
		l, err := parseProcAddr(f[1])
		if err != nil {
			continue
		}
		rem, err := parseProcAddr(f[2])
		if err != nil {
			continue
		}
		uid, err := strconv.Atoi(f[7])
		if err != nil {
			return nil, fmt.Errorf("bad uid %q in /proc/net/tcp", f[7])
		}
		rows = append(rows, procTCPRow{local: l, remote: rem, state: f[3], uid: uid, inode: f[9]})
	}
	return rows, sc.Err()
}

func sameEndpoint(a, b *net.TCPAddr) bool {
	return a.Port == b.Port && a.IP.Equal(b.IP) // Equal treats v4-mapped v6 as v4
}

// parseProcAddr decodes "0100007F:1F90". The address is printed as 32-bit
// words in host byte order (one word for IPv4, four for IPv6); the port is
// plain hex.
func parseProcAddr(s string) (*net.TCPAddr, error) {
	hostHex, portHex, ok := strings.Cut(s, ":")
	if !ok {
		return nil, fmt.Errorf("bad address %q", s)
	}
	raw, err := hex.DecodeString(hostHex)
	if err != nil || (len(raw) != 4 && len(raw) != 16) {
		return nil, fmt.Errorf("bad address %q", s)
	}
	// Each printed word is the value of a network-order word loaded natively,
	// so its native-endian bytes are the address bytes.
	ip := make(net.IP, len(raw))
	for i := 0; i < len(raw); i += 4 {
		binary.NativeEndian.PutUint32(ip[i:], binary.BigEndian.Uint32(raw[i:i+4]))
	}
	port, err := strconv.ParseUint(portHex, 16, 16)
	if err != nil {
		return nil, fmt.Errorf("bad port %q", s)
	}
	return &net.TCPAddr{IP: ip, Port: int(port)}, nil
}

// browserTransport is shared so idle DevTools connections are reused rather
// than piling up one transport per status poll.
var browserTransport = NewBrowserTransport()

// newBrowserHTTPClient is the only way the server talks HTTP to a browser
// port: every connection goes through DialBrowser, never through a proxy.
func newBrowserHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: browserTransport}
}

// NewBrowserTransport returns an http.RoundTripper whose connections (including
// websocket upgrades through httputil.ReverseProxy) are verified by DialBrowser.
func NewBrowserTransport() *http.Transport {
	return &http.Transport{
		Proxy:               nil,
		DialContext:         DialBrowser,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
	}
}

// browserWSDialer dials CDP websockets through DialBrowser.
func browserWSDialer() *websocket.Dialer {
	return &websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
		NetDialContext:   DialBrowser,
	}
}
