// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: privileged-socket-v11-cleanup-on-start-err

//go:build linux

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/pty"
)

const privilegedSocketRevision = "privileged-socket-v11-cleanup-on-start-err"

func init() {
	log.Printf("[privileged-socket] REVISION: %s loaded at %s", privilegedSocketRevision, time.Now().Format(time.RFC3339))
}

const privilegedSockPath = "/run/orcabot/privileged.sock"

// PrivilegedSocket is the Unix-domain socket server that authenticates callers
// via SO_PEERCRED (kernel-derived UID) and dispatches privileged requests.
//
// Auth model: peer UID → pool.Lookup(uid) → SlotEntry (ptyID, sessionID).
// After auth, handlers are called directly (*ForPTY methods) — no TCP hop,
// no bearer secret. The Unix socket IS the security boundary.
//
// This eliminates the poolProxyToken design:
//   - Pool UIDs are iptables-blocked from MCPLocal TCP (defense-in-depth)
//   - MCPLocal TCP returns 503 in pool mode (poolModeGuard)
//   - Root processes (Chromium --no-sandbox) cannot reach the Unix socket
//     and also cannot call TCP endpoints without a valid per-PTY secret
//     (which is withheld in pool mode)
//
// REVISION: privileged-socket-v11-cleanup-on-start-err
type PrivilegedSocket struct {
	server *Server
}

// NewPrivilegedSocket returns a PrivilegedSocket backed by the server.
func NewPrivilegedSocket(server *Server) *PrivilegedSocket {
	return &PrivilegedSocket{server: server}
}

// Start creates the Unix socket, sets ownership/permissions, and begins serving.
func (ps *PrivilegedSocket) Start() error {
	if err := os.MkdirAll("/run/orcabot", 0755); err != nil {
		return fmt.Errorf("privileged-socket mkdir: %w", err)
	}
	// Remove stale socket from a previous run.
	_ = os.Remove(privilegedSockPath)

	ln, err := net.Listen("unix", privilegedSockPath)
	if err != nil {
		return fmt.Errorf("privileged-socket listen: %w", err)
	}

	// On any post-Listen failure, remove the socket inode so that clients
	// (mcp-bridge os.Stat, xdg-open test -S) cannot mistake its presence for
	// a ready pool. Without this, a Chown/Chmod error leaves a stale inode:
	// clients switch to Unix-socket mode, every connection is rejected with
	// "pool not initialised", and the TCP fallback is never reached.
	// Disarmed by setting ok=true just before the successful return.
	// REVISION: privileged-socket-v11-cleanup-on-start-err
	ok := false
	defer func() {
		if !ok {
			ln.Close()
			_ = os.Remove(privilegedSockPath)
		}
	}()

	// Set group ownership to "sandbox" so pty-NNN processes (GID = sandbox) can connect.
	// Mode 0660: root can read/write, sandbox group can read/write, others cannot.
	// Both are hard failures: the socket is unusable without correct permissions.
	sandboxGID := int(pty.LookupSandboxGID())
	if sandboxGID > 0 {
		if err := os.Chown(privilegedSockPath, 0, sandboxGID); err != nil {
			return fmt.Errorf("privileged-socket chown (gid %d): %w", sandboxGID, err)
		}
	}
	if err := os.Chmod(privilegedSockPath, 0660); err != nil {
		return fmt.Errorf("privileged-socket chmod 0660: %w", err)
	}

	log.Printf("[privileged-socket] Listening on %s (mode 0660, gid %d)", privilegedSockPath, sandboxGID)
	go func() {
		ps.serve(ln)
		// serve() only returns when Accept fails (e.g. listener closed, socket inode
		// removed). At that point:
		//   - The socket file may still exist, keeping clients pinned to socket mode.
		//   - pty.GetPool() is non-nil, so pool UIDs are iptables-blocked from TCP.
		//   - Every pool PTY's MCP, apiKeyHelper, and browser-open is permanently broken.
		// There is no in-process recovery: the listener is dead and cannot be restarted
		// without re-running the full Chown/Chmod sequence and re-signalling clients.
		// Crash to force a clean VM restart, which re-initialises everything correctly.
		// REVISION: privileged-socket-v11-cleanup-on-start-err
		log.Fatalf("[privileged-socket] FATAL: accept loop exited while pool is active — unrecoverable; crashing for clean restart")
	}()
	ok = true // disarm cleanup defer — socket is live and correctly configured
	return nil
}

func (ps *PrivilegedSocket) serve(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("[privileged-socket] Accept error: %v", err)
			return
		}
		go ps.handleConn(conn)
	}
}

// oneConnLn is a net.Listener that serves exactly one connection then closes.
// This lets us hand a pre-accepted net.Conn to http.Server.Serve.
type oneConnLn struct {
	conn net.Conn
	ch   chan net.Conn
}

func newOneConnLn(conn net.Conn) *oneConnLn {
	ch := make(chan net.Conn, 1)
	ch <- conn
	return &oneConnLn{conn: conn, ch: ch}
}

func (l *oneConnLn) Accept() (net.Conn, error) {
	c, ok := <-l.ch
	if !ok {
		return nil, fmt.Errorf("listener closed")
	}
	return c, nil
}

func (l *oneConnLn) Close() error {
	close(l.ch)
	return nil
}

func (l *oneConnLn) Addr() net.Addr {
	return l.conn.LocalAddr()
}

func (ps *PrivilegedSocket) handleConn(conn net.Conn) {
	defer conn.Close()

	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return
	}

	// Authenticate via SO_PEERCRED — the kernel provides the caller's real UID.
	uid, err := peerUID(uc)
	if err != nil {
		log.Printf("[privileged-socket] SO_PEERCRED failed: %v", err)
		return
	}

	pool := pty.GetPool()
	if pool == nil {
		writeHTTP403(conn, "pool not initialised")
		return
	}

	entry, ok := pool.Lookup(uid)
	if !ok {
		log.Printf("[privileged-socket] Rejected: uid %d not in pool registry", uid)
		writeHTTP403(conn, "uid not in pool")
		return
	}

	// Get the session to serve requests for this PTY.
	session, err := ps.server.sessions.Get(entry.SessionID)
	if err != nil {
		writeHTTP403(conn, "session not found")
		return
	}

	// Build per-connection mux. Identity (session, ptyID) is baked into closures
	// from the SO_PEERCRED lookup — callers cannot forge a different ptyID.
	mux := http.NewServeMux()

	// /anthropic-key → serve brokered Anthropic API key.
	// Claude Code reads this via apiKeyHelper in .claude/settings.local.json.
	mux.HandleFunc("/anthropic-key", func(w http.ResponseWriter, r *http.Request) {
		key := session.Broker().GetAnthropicKey(entry.SessionID)
		if key == "" {
			http.Error(w, "no anthropic key", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"apiKey":%q}`, key)
		log.Printf("[privileged-socket] Served anthropic-key for session %s pty %s", entry.SessionID, entry.PTYID)
	})

	// /mcp/ → MCP tool dispatch, called directly via ForPTY methods.
	// Caller-supplied pty_id in query string is IGNORED; only SO_PEERCRED value used.
	mux.HandleFunc("/mcp/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/mcp/")
		switch rest {
		case "tools":
			ps.server.handleMCPListToolsForPTY(w, r, session, entry.PTYID)
		case "tools/call":
			ps.server.handleMCPCallToolForPTY(w, r, session, entry.PTYID)
		case "items":
			ps.server.handleMCPListItemsForPTY(w, r, session)
		default:
			http.Error(w, "not found", http.StatusNotFound)
		}
	})

	// /agent-stopped → broadcast agent_stopped event.
	mux.HandleFunc("/agent-stopped", func(w http.ResponseWriter, r *http.Request) {
		ps.server.handleAgentStoppedForPTY(w, session, entry.PTYID, r.Body)
	})

	// /scrollback → return PTY scrollback ring buffer.
	mux.HandleFunc("/scrollback", func(w http.ResponseWriter, r *http.Request) {
		ps.server.handleScrollbackForPTY(w, session, entry.PTYID)
	})

	// /tools-changed → broadcast tools_changed event.
	mux.HandleFunc("/tools-changed", func(w http.ResponseWriter, r *http.Request) {
		ps.server.handleToolsChangedForPTY(w, session, entry.PTYID, r.Body)
	})

	// /audio → broadcast audio event.
	mux.HandleFunc("/audio", func(w http.ResponseWriter, r *http.Request) {
		ps.server.handleAudioEventForPTY(w, session, entry.PTYID, r.Body)
	})

	// /status → broadcast TTS status event.
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		ps.server.handleTtsStatusEventForPTY(w, session, entry.PTYID, r.Body)
	})

	// /browser → open browser URL for this PTY's session.
	// xdg-open uses this in pool mode so it can only open the browser for its own
	// session (identity from SO_PEERCRED, not caller-controlled URL path).
	// Caller-supplied pty_id in JSON body is IGNORED; only SO_PEERCRED value used.
	mux.HandleFunc("/browser", func(w http.ResponseWriter, r *http.Request) {
		var bodyMap map[string]interface{}
		if r.Body != nil {
			if err := json.NewDecoder(r.Body).Decode(&bodyMap); err != nil {
				http.Error(w, "invalid JSON body", http.StatusBadRequest)
				return
			}
		}
		urlStr, _ := bodyMap["url"].(string)
		ps.server.handleBrowserOpenForPTY(w, r, session, entry.PTYID, urlStr)
	})

	srv := &http.Server{
		Handler:      mux,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 120 * time.Second,
	}
	srv.Serve(newOneConnLn(conn)) //nolint:errcheck
}

// peerUID reads the real UID of the process on the other end of a Unix socket
// using SO_PEERCRED (Linux kernel provides this without the peer's cooperation).
func peerUID(uc *net.UnixConn) (int, error) {
	rawConn, err := uc.SyscallConn()
	if err != nil {
		return 0, err
	}

	var cred syscall.Ucred
	var credErr error
	err = rawConn.Control(func(fd uintptr) {
		size := uint32(unsafe.Sizeof(cred))
		_, _, errno := syscall.RawSyscall6(
			syscall.SYS_GETSOCKOPT,
			fd,
			syscall.SOL_SOCKET,
			syscall.SO_PEERCRED,
			uintptr(unsafe.Pointer(&cred)),
			uintptr(unsafe.Pointer(&size)),
			0,
		)
		if errno != 0 {
			credErr = errno
		}
	})
	if err != nil {
		return 0, err
	}
	if credErr != nil {
		return 0, credErr
	}
	return int(cred.Uid), nil
}

func writeHTTP(conn net.Conn, status int, contentType string, body []byte) {
	statusText := http.StatusText(status)
	fmt.Fprintf(conn,
		"HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nConnection: close\r\n\r\n",
		status, statusText, contentType, len(body),
	)
	conn.Write(body) //nolint:errcheck
}

func writeHTTP403(conn net.Conn, msg string) {
	writeHTTP(conn, http.StatusForbidden, "text/plain", []byte(msg))
}
