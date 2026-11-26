// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: self-input-v2-own-screen

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
)

// Self-input: a process in a terminal types into *its own* terminal, as if the user had
// typed or pasted it. A coordinator uses it to hand a prompt to the interactive agent
// the user started and logged into in that terminal (PokerBench gives each linked agent
// its poker prompt at Start). Pool mode: the privileged Unix socket (/input, identity
// from SO_PEERCRED). Otherwise: MCPLocal with the PTY's X-MCP-Secret
// (/sessions/{sessionId}/ptys/{ptyId}/input).
//
// Only ever the caller's own PTY. It grants nothing a process in that terminal can't
// already do (it runs as the terminal's user, and any of them can already start new
// terminals and agents through the MCP UI tools); it never reaches another terminal,
// and every use is logged.

const selfInputRevision = "self-input-v2-own-screen"

const selfInputMaxBytes = 64 * 1024

func init() {
	log.Printf("[self-input] REVISION: %s loaded at %s", selfInputRevision, time.Now().Format(time.RFC3339))
}

type selfInputRequest struct {
	Text  string `json:"text"`
	Paste bool   `json:"paste"` // wrap in bracketed paste, so newlines don't submit
	Enter bool   `json:"enter"` // then press Enter (after a short pause, so the TUI takes the paste)
}

// selfInputBytes is what reaches the PTY for a request: the text, bracketed if pasted.
func selfInputBytes(req selfInputRequest) []byte {
	if req.Paste {
		return []byte("\x1b[200~" + req.Text + "\x1b[201~")
	}
	return []byte(req.Text)
}

func (s *Server) handleSelfInputForPTY(w http.ResponseWriter, r *http.Request, session *sessions.Session, ptyID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "E79995: POST only", http.StatusMethodNotAllowed)
		return
	}
	if session == nil || ptyID == "" {
		http.Error(w, "E79996: no terminal identity", http.StatusForbidden)
		return
	}
	hub := session.GetHub(ptyID)
	if hub == nil {
		http.Error(w, "E79997: PTY not found", http.StatusNotFound)
		return
	}
	var req selfInputRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, selfInputMaxBytes+1024)).Decode(&req); err != nil {
		http.Error(w, "E79998: invalid JSON body", http.StatusBadRequest)
		return
	}
	if len(req.Text) > selfInputMaxBytes {
		http.Error(w, "E79998: text too long", http.StatusRequestEntityTooLarge)
		return
	}
	log.Printf("[self-input] session=%s pty=%s bytes=%d paste=%v enter=%v", session.ID, ptyID, len(req.Text), req.Paste, req.Enter)
	if req.Text != "" {
		if _, err := hub.WriteSystem(selfInputBytes(req)); err != nil {
			http.Error(w, "E79968: couldn't write to the terminal", http.StatusInternalServerError)
			return
		}
	}
	if req.Enter {
		if req.Text != "" {
			time.Sleep(400 * time.Millisecond)
		}
		if _, err := hub.WriteSystem([]byte("\r")); err != nil {
			http.Error(w, "E79968: couldn't write to the terminal", http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSelfInputLocal: the MCPLocal (non-pool) route; requireLocalPTYAuth has checked the PTY's secret.
func (s *Server) handleSelfInputLocal(w http.ResponseWriter, r *http.Request) {
	session, err := s.sessions.Get(r.PathValue("sessionId"))
	if err != nil {
		http.Error(w, "E79994: session not found", http.StatusNotFound)
		return
	}
	s.handleSelfInputForPTY(w, r, session, r.PathValue("ptyId"))
}

// Own screen: the raw recent output of the caller's own terminal (ANSI intact, the last
// 64KB), so the caller can render what is on the screen now. The /scrollback route
// strips the escape codes, which loses the cursor moves an interactive agent's UI is
// drawn with: text it has since redrawn over (a dialog that was answered) stays in it.
// Pool mode: /screen on the privileged socket; otherwise MCPLocal
// GET /sessions/{sessionId}/ptys/{ptyId}/screen. Only ever the caller's own PTY.
func (s *Server) handleOwnScreenForPTY(w http.ResponseWriter, r *http.Request, session *sessions.Session, ptyID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "E79995: GET only", http.StatusMethodNotAllowed)
		return
	}
	if session == nil || ptyID == "" {
		http.Error(w, "E79996: no terminal identity", http.StatusForbidden)
		return
	}
	hub := session.GetHub(ptyID)
	if hub == nil {
		http.Error(w, "E79997: PTY not found", http.StatusNotFound)
		return
	}
	cols, rows := hub.Size()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Screen-Cols", strconv.Itoa(int(cols)))
	w.Header().Set("X-Screen-Rows", strconv.Itoa(int(rows)))
	w.Write(hub.ScrollbackRaw(64 * 1024))
}

func (s *Server) handleOwnScreenLocal(w http.ResponseWriter, r *http.Request) {
	session, err := s.sessions.Get(r.PathValue("sessionId"))
	if err != nil {
		http.Error(w, "E79994: session not found", http.StatusNotFound)
		return
	}
	s.handleOwnScreenForPTY(w, r, session, r.PathValue("ptyId"))
}
