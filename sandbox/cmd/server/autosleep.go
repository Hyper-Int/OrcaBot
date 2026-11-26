// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: autosleep-v1-session-flag

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

const autoSleepRevision = "autosleep-v1-session-flag"

func init() {
	log.Printf("[autosleep] REVISION: %s loaded at %s", autoSleepRevision, time.Now().Format(time.RFC3339))
}

// handleSessionAutoSleep sets the dashboard's Auto sleep on a live session
// (POST /sessions/{sessionId}/auto-sleep, {"auto_sleep": bool}). The control plane
// calls it when a member toggles Auto sleep in the dashboard's menu bar; every PTY
// create carries the setting too. Off: the session's terminals keep running with
// nobody watching (the hubs' idle timeout doesn't stop them). Control plane only
// (signed request, RequireAuthFunc).
func (s *Server) handleSessionAutoSleep(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}
	var req struct {
		AutoSleep *bool `json:"auto_sleep"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.AutoSleep == nil {
		http.Error(w, "E79771: auto_sleep (true or false) is required", http.StatusBadRequest)
		return
	}
	session.SetAutoSleep(*req.AutoSleep)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"auto_sleep": !session.KeepAwake(),
		"revision":   autoSleepRevision,
	})
}
