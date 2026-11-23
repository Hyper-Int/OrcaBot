// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: bgproc-routes-v1-restart-choice

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/bgproc"
)

// Background processes a terminal leaves running (internal/bgproc), for the restart
// dialog: the user sees them and chooses which to stop before the terminal restarts.
// Control-plane routes only (signed per machine): the control plane decides who may
// restart the terminal and supplies its PTY ids (current and earlier) from D1.
//
//	GET  /sessions/{sessionId}/background-processes?pty_ids=a,b,c
//	POST /sessions/{sessionId}/background-processes/stop  {"pty_ids":[...],"processes":[{"pid":1,"start_ticks":2}]}
//
// Stop re-checks every process (same PID and start time, still the terminal's, outside
// every live PTY's group), so a stale list can't stop anything else. Each stop is logged.

const bgprocRoutesRevision = "bgproc-routes-v1-restart-choice"

const (
	bgprocMaxIDs     = 200
	bgprocMaxTargets = 200
	bgprocStopGrace  = 3 * time.Second
)

func init() {
	log.Printf("[bgproc] routes REVISION: %s loaded at %s", bgprocRoutesRevision, time.Now().Format(time.RFC3339))
}

var bgprocScanner = bgproc.New()

// liveProcessGroups: the process group of every running PTY on this VM.
func (s *Server) liveProcessGroups() map[int]bool {
	groups := map[int]bool{}
	for _, sess := range s.sessions.List() {
		for _, info := range sess.ListPTYs() {
			if info.Hub == nil {
				continue
			}
			if g := info.Hub.ProcessGroup(); g > 0 {
				groups[g] = true
			}
		}
	}
	return groups
}

func cleanPTYIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" && len(id) <= 128 {
			out = append(out, id)
		}
		if len(out) == bgprocMaxIDs {
			break
		}
	}
	return out
}

func (s *Server) handleListBackgroundProcesses(w http.ResponseWriter, r *http.Request) {
	if s.getSessiоnOrErrоr(w, r.PathValue("sessionId")) == nil {
		return
	}
	ids := cleanPTYIDs(strings.Split(r.URL.Query().Get("pty_ids"), ","))
	procs := bgprocScanner.Find(ids, s.liveProcessGroups())
	if procs == nil {
		procs = []bgproc.Process{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"processes": procs, "revision": bgprocRoutesRevision})
}

type stopBackgroundRequest struct {
	PTYIDs    []string        `json:"pty_ids"`
	Processes []bgproc.Target `json:"processes"`
}

func (s *Server) handleStopBackgroundProcesses(w http.ResponseWriter, r *http.Request) {
	if s.getSessiоnOrErrоr(w, r.PathValue("sessionId")) == nil {
		return
	}
	var req stopBackgroundRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		http.Error(w, "E79781: invalid request body", http.StatusBadRequest)
		return
	}
	ids := cleanPTYIDs(req.PTYIDs)
	if len(ids) == 0 || len(req.Processes) == 0 || len(req.Processes) > bgprocMaxTargets {
		http.Error(w, "E79782: pty_ids and 1-200 processes are required", http.StatusBadRequest)
		return
	}
	log.Printf("[bgproc] stop requested: session=%s processes=%d", r.PathValue("sessionId"), len(req.Processes))
	results := bgprocScanner.Stop(req.Processes, ids, s.liveProcessGroups(), bgprocStopGrace)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"results": results, "revision": bgprocRoutesRevision})
}
