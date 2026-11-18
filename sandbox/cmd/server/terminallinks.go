// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: terminal-links-v1

package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/agentlink"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/pty"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
)

// Terminals linked to a terminal on the canvas (an edge either way), for a program in
// that terminal that coordinates the others: a game engine seats the players linked to
// it. The control plane decides from D1 edges (no edge, no link); this serves the
// answer to the terminal itself. Pool mode: the privileged Unix socket (/links,
// identity from SO_PEERCRED). Otherwise: MCPLocal with the PTY's X-MCP-Secret
// (/sessions/{sessionId}/ptys/{ptyId}/links).
//
// In pool mode each linked terminal comes with the OS user its PTY runs as, so the
// program can bind each to its own user (and a terminal can't pass itself off as
// another). It reveals names, PTY ids and UIDs of linked terminals only: never boot
// commands, output or environment.

const terminalLinksRevision = "terminal-links-v1"

func init() {
	log.Printf("[terminal-links] REVISION: %s loaded at %s", terminalLinksRevision, time.Now().Format(time.RFC3339))
}

type linkedTerminal struct {
	ItemID string `json:"itemId"`
	Name   string `json:"name"`
	PTYID  string `json:"ptyId"`
	UID    *int   `json:"uid,omitempty"`
}

type cachedLinks struct {
	at        time.Time
	terminals []agentlink.LinkedTerminal
}

var (
	terminalLinksOnce sync.Once
	terminalLinksCP   *agentlink.CPClient
	terminalLinksMu   sync.Mutex
	terminalLinksSeen = map[string]cachedLinks{}
)

// fetchTerminalLinks asks the control plane, cached briefly: a coordinator polls it.
func fetchTerminalLinks(ctx context.Context, dashboardID, ptyID string) ([]agentlink.LinkedTerminal, error) {
	terminalLinksOnce.Do(func() { terminalLinksCP = agentlink.NewCPClient(os.Getenv("CONTROLPLANE_URL")) })
	key := dashboardID + "\x00" + ptyID
	terminalLinksMu.Lock()
	c, ok := terminalLinksSeen[key]
	terminalLinksMu.Unlock()
	if ok && time.Since(c.at) < 2*time.Second {
		return c.terminals, nil
	}
	terms, err := terminalLinksCP.TerminalLinks(ctx, dashboardID, ptyID)
	if err != nil {
		return nil, err
	}
	terminalLinksMu.Lock()
	terminalLinksSeen[key] = cachedLinks{at: time.Now(), terminals: terms}
	terminalLinksMu.Unlock()
	return terms, nil
}

// withPoolUIDs adds each linked terminal's pool UID (pool mode only).
func withPoolUIDs(terms []agentlink.LinkedTerminal, uidFor func(string) (int, bool)) []linkedTerminal {
	out := make([]linkedTerminal, 0, len(terms))
	for _, t := range terms {
		o := linkedTerminal{ItemID: t.ItemID, Name: t.Name, PTYID: t.PTYID}
		if uidFor != nil {
			if uid, ok := uidFor(t.PTYID); ok {
				u := uid
				o.UID = &u
			}
		}
		out = append(out, o)
	}
	return out
}

func (s *Server) handleLinksForPTY(w http.ResponseWriter, r *http.Request, session *sessions.Session, ptyID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "E79991: GET only", http.StatusMethodNotAllowed)
		return
	}
	if session == nil || session.DashboardID == "" || ptyID == "" {
		http.Error(w, "E79992: no terminal identity", http.StatusForbidden)
		return
	}
	terms, err := fetchTerminalLinks(r.Context(), session.DashboardID, ptyID)
	if err != nil {
		log.Printf("[terminal-links] control plane: %v", err)
		http.Error(w, "E79993: couldn't ask the control plane", http.StatusBadGateway)
		return
	}
	var uidFor func(string) (int, bool)
	pool := pty.GetPool()
	if pool != nil {
		uidFor = pool.UIDForPTY
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"terminals": withPoolUIDs(terms, uidFor),
		"pool":      pool != nil,
		"revision":  terminalLinksRevision,
	})
}

// handleLinksLocal: the MCPLocal (non-pool) route; requireLocalPTYAuth has checked the PTY's secret.
func (s *Server) handleLinksLocal(w http.ResponseWriter, r *http.Request) {
	session, err := s.sessions.Get(r.PathValue("sessionId"))
	if err != nil {
		http.Error(w, "E79994: session not found", http.StatusNotFound)
		return
	}
	s.handleLinksForPTY(w, r, session, r.PathValue("ptyId"))
}
