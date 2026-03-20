// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-transparent-v5-drop-no-hostname

//go:build linux

package egress

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// httpMaxHeaderBytes is the maximum number of bytes read when scanning for the
// HTTP Host header. 64 KB is well above any realistic header set.
const httpMaxHeaderBytes = 64 * 1024

// soOriginalDst is the Linux socket option to retrieve the original
// destination of a connection redirected by iptables REDIRECT.
const soOriginalDst = 80 // SO_ORIGINAL_DST

// StartTransparent starts a TCP listener (or two, if net.ipv6only=1) that accepts
// iptables-redirected connections from PTY processes. It extracts the target domain
// via SNI (for TLS) or Host header (for HTTP), applies the same allowlist/approval
// flow, then relays bytes to the resolved domain — not the original IP — to prevent
// bypass via a spoofed Host/SNI pointing to a blocked IP address.
func (p *EgressProxy) StartTransparent() error {
	port := fmt.Sprintf("%d", TransparentPort)

	// On Linux, net.ipv6only=0 (default) makes a dual-stack "tcp" listener accept
	// both IPv4 and IPv6 connections on the same socket. When ipv6only=1, a "tcp"
	// listener is IPv6-only, so IPv4-redirected traffic would silently fail.
	// Read the kernel setting and use two explicit listeners when required.
	bindv6only := false
	if data, err := os.ReadFile("/proc/sys/net/ipv6/bindv6only"); err == nil {
		bindv6only = len(data) > 0 && data[0] == '1'
	}

	if !bindv6only {
		// Default: single dual-stack listener accepts both iptables and ip6tables redirects.
		ln, err := net.Listen("tcp", ":"+port)
		if err != nil {
			return fmt.Errorf("transparent proxy listen: %w", err)
		}
		p.transparentListeners = []net.Listener{ln}
		go p.serveTransparent(ln)
		log.Printf("[egress-transparent] Listening on :%s dual-stack (ipv6only=0)", port)
	} else {
		// ipv6only=1: bind two explicit sockets so both iptables (IPv4) and
		// ip6tables (IPv6) redirected connections reach the proxy.
		ln4, err := net.Listen("tcp4", "0.0.0.0:"+port)
		if err != nil {
			return fmt.Errorf("transparent proxy listen tcp4: %w", err)
		}
		ln6, err := net.Listen("tcp6", "[::]:"+port)
		if err != nil {
			ln4.Close()
			return fmt.Errorf("transparent proxy listen tcp6: %w", err)
		}
		p.transparentListeners = []net.Listener{ln4, ln6}
		go p.serveTransparent(ln4)
		go p.serveTransparent(ln6)
		log.Printf("[egress-transparent] Listening on :%s as separate tcp4+tcp6 (ipv6only=1)", port)
	}
	return nil
}

func (p *EgressProxy) serveTransparent(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-p.stopCh:
				return
			default:
				log.Printf("[egress-transparent] Accept error: %v", err)
				return
			}
		}
		go p.handleTransparent(conn)
	}
}

func (p *EgressProxy) handleTransparent(conn net.Conn) {
	defer conn.Close()

	// Get original destination before reading any bytes.
	// SO_ORIGINAL_DST returns the pre-REDIRECT destination from conntrack.
	origIP, origPort, err := getOriginalDst(conn)
	if err != nil {
		log.Printf("[egress-transparent] SO_ORIGINAL_DST failed: %v", err)
		return
	}

	// Peek first byte to detect TLS (0x16) vs plain HTTP.
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var firstByte [1]byte
	if _, err := io.ReadFull(conn, firstByte[:]); err != nil {
		return
	}

	var domain string
	var preamble []byte // bytes already read that must be forwarded to upstream

	if firstByte[0] == 0x16 { // TLS handshake record
		// Read TLS record header (4 more bytes: version[2] + length[2])
		var tlsHeader [4]byte
		if _, err := io.ReadFull(conn, tlsHeader[:]); err != nil {
			return
		}
		conn.SetReadDeadline(time.Time{})

		recordLen := int(tlsHeader[2])<<8 | int(tlsHeader[3])
		if recordLen > 16384 {
			recordLen = 16384 // clamp to max TLS record size
		}
		body := make([]byte, recordLen)
		n, _ := io.ReadFull(conn, body)
		body = body[:n]

		// Reassemble full TLS record for SNI parsing
		all := append(firstByte[:], tlsHeader[:]...)
		all = append(all, body...)
		if sni := extractSNI(all); sni != "" {
			domain = sni
		}
		// No SNI: drop. Accepting raw-IP TLS connections would let PTYs bypass
		// the domain allowlist by presenting an allowed SNI on a blocked IP.
		if domain == "" {
			log.Printf("[egress-transparent] dropping no-SNI TLS connection to %s:%d", origIP, origPort)
			return
		}
		preamble = all
	} else {
		// Plain HTTP: accumulate bytes until the end-of-headers marker (\r\n\r\n)
		// is seen or httpMaxHeaderBytes is reached. A single conn.Read() is not
		// sufficient — TCP segmentation may split the Host header across reads,
		// causing the fallback to origIP and incorrect policy decisions.
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		all := make([]byte, 0, 4096)
		all = append(all, firstByte[0])
		tmp := make([]byte, 4096)
		for len(all) < httpMaxHeaderBytes {
			n, err := conn.Read(tmp)
			if n > 0 {
				all = append(all, tmp[:n]...)
				// Stop once we have the complete header block.
				if bytes.Contains(all, []byte("\r\n\r\n")) ||
					bytes.Contains(all, []byte("\n\n")) {
					break
				}
			}
			if err != nil {
				break
			}
		}
		conn.SetReadDeadline(time.Time{})

		if h := extractHTTPHost(all); h != "" {
			domain = h
		}
		// No Host header: drop. Raw-IP HTTP bypasses domain-level allowlisting.
		if domain == "" {
			log.Printf("[egress-transparent] dropping no-Host HTTP connection to %s:%d", origIP, origPort)
			return
		}
		preamble = all
	}

	// Normalize domain
	if h, _, err := net.SplitHostPort(domain); err == nil {
		domain = h
	}
	domain = strings.ToLower(domain)

	// Allowlist check + hold for user approval (same flow as CONNECT path)
	if !isLocalhost(domain) {
		if p.allowlist.IsAllowed(domain) {
			p.emitAudit(domain, origPort, "", DecisionDefault)
		} else {
			decision := p.holdForApproval(domain, origPort)
			if decision != DecisionAllowOnce && decision != DecisionAllowAlways {
				return // denied or timed out
			}
		}
	}

	// Dial the declared domain (not origIP). Using origIP here would allow a PTY
	// to present an allowed SNI/Host while connecting to an arbitrary blocked IP.
	// By resolving domain ourselves, the allowed name maps to its legitimate IPs.
	// When no Host/SNI was found, domain == origIP and behaviour is unchanged.
	target := net.JoinHostPort(domain, fmt.Sprintf("%d", origPort))
	upstream, err := net.DialTimeout("tcp", target, 10*time.Second)
	if err != nil {
		log.Printf("[egress-transparent] Dial %s failed: %v", target, err)
		return
	}
	defer upstream.Close()

	// Forward bytes we already consumed before the relay takes over
	if len(preamble) > 0 {
		if _, err := upstream.Write(preamble); err != nil {
			log.Printf("[egress-transparent] Preamble write to %s failed: %v", target, err)
			return
		}
	}

	// Bidirectional transparent relay
	done := make(chan struct{}, 2)
	go func() { io.Copy(upstream, conn); done <- struct{}{} }()
	go func() { io.Copy(conn, upstream); done <- struct{}{} }()
	<-done
}

// rawSockaddrInet6 mirrors the kernel sockaddr_in6 for IPv6 SO_ORIGINAL_DST.
type rawSockaddrInet6 struct {
	Family   uint16
	Port     uint16
	Flowinfo uint32
	Addr     [16]byte
	Scope_id uint32
}

// getOriginalDst uses SO_ORIGINAL_DST to recover the iptables-pre-REDIRECT destination.
// Supports both IPv4 (IPPROTO_IP) and IPv6 (IPPROTO_IPV6) connections.
func getOriginalDst(conn net.Conn) (ip string, port int, err error) {
	tc, ok := conn.(*net.TCPConn)
	if !ok {
		return "", 0, fmt.Errorf("not a TCP connection")
	}
	rc, err := tc.SyscallConn()
	if err != nil {
		return "", 0, fmt.Errorf("SyscallConn: %w", err)
	}

	// Determine address family from the local address of the accepted connection.
	localIP := tc.LocalAddr().(*net.TCPAddr).IP
	if localIP.To4() == nil && len(localIP) == net.IPv6len {
		return getOriginalDst6(rc)
	}
	return getOriginalDst4(rc)
}

func getOriginalDst4(rc syscall.RawConn) (ip string, port int, err error) {
	var sa syscall.RawSockaddrInet4
	var sockErr error
	cerr := rc.Control(func(fd uintptr) {
		addrLen := uint32(syscall.SizeofSockaddrInet4)
		_, _, errno := syscall.RawSyscall6(
			syscall.SYS_GETSOCKOPT,
			fd,
			syscall.IPPROTO_IP,
			soOriginalDst,
			uintptr(unsafe.Pointer(&sa)),
			uintptr(unsafe.Pointer(&addrLen)),
			0,
		)
		if errno != 0 {
			sockErr = errno
		}
	})
	if cerr != nil {
		return "", 0, cerr
	}
	if sockErr != nil {
		return "", 0, sockErr
	}
	ipStr := net.IP(sa.Addr[:]).String()
	// Port is network byte order (big endian) in RawSockaddrInet4
	p := int(sa.Port>>8) | int(sa.Port&0xff)<<8
	return ipStr, p, nil
}

func getOriginalDst6(rc syscall.RawConn) (ip string, port int, err error) {
	var sa rawSockaddrInet6
	var sockErr error
	cerr := rc.Control(func(fd uintptr) {
		addrLen := uint32(unsafe.Sizeof(sa))
		_, _, errno := syscall.RawSyscall6(
			syscall.SYS_GETSOCKOPT,
			fd,
			syscall.IPPROTO_IPV6,
			soOriginalDst,
			uintptr(unsafe.Pointer(&sa)),
			uintptr(unsafe.Pointer(&addrLen)),
			0,
		)
		if errno != 0 {
			sockErr = errno
		}
	})
	if cerr != nil {
		return "", 0, cerr
	}
	if sockErr != nil {
		return "", 0, sockErr
	}
	ipStr := net.IP(sa.Addr[:]).String()
	// Port is network byte order (big endian)
	p := int(sa.Port>>8) | int(sa.Port&0xff)<<8
	return ipStr, p, nil
}

// extractHTTPHost scans raw HTTP request bytes for the Host header value.
func extractHTTPHost(data []byte) string {
	s := string(data)
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimRight(line, "\r")
		if len(line) > 5 && strings.EqualFold(line[:5], "host:") {
			host := strings.TrimSpace(line[5:])
			if h, _, err := net.SplitHostPort(host); err == nil {
				return h
			}
			return host
		}
	}
	return ""
}
