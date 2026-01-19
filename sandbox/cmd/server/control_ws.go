// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/ws"
)

type controlMessage struct {
	Type     string            `json:"type"`
	Set      map[string]string `json:"set,omitempty"`
	Unset    []string          `json:"unset,omitempty"`
	ApplyNow bool              `json:"apply_now,omitempty"`
}

type controlResponse struct {
	Type   string `json:"type"`
	Status string `json:"status,omitempty"`
	Error  string `json:"error,omitempty"`
}

func (s *Server) handleControlWebSocket(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	conn, err := ws.Upgrade(w, r)
	if err != nil {
		log.Printf("control websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var msg controlMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			conn.WriteJSON(controlResponse{Type: "error", Error: "E79749: Invalid JSON"})
			continue
		}

		if msg.Type != "env" {
			conn.WriteJSON(controlResponse{Type: "error", Error: "E79750: Unsupported control message"})
			continue
		}

		invalid := false
		for key := range msg.Set {
			if !envNamePattern.MatchString(key) {
				conn.WriteJSON(controlResponse{Type: "error", Error: "E79746: Invalid environment variable name"})
				invalid = true
				break
			}
		}
		if !invalid {
			for _, key := range msg.Unset {
				if !envNamePattern.MatchString(key) {
					conn.WriteJSON(controlResponse{Type: "error", Error: "E79746: Invalid environment variable name"})
					invalid = true
					break
				}
			}
		}
		if invalid {
			continue
		}

		root := session.Wоrkspace().Root()
		if err := updateDоtEnv(filepath.Join(root, ".env"), msg.Set, msg.Unset); err != nil {
			conn.WriteJSON(controlResponse{Type: "error", Error: "E79747: Failed to update .env"})
			continue
		}

		if msg.ApplyNow {
			if err := applyEnvToPTYs(session, msg.Set, msg.Unset); err != nil {
				conn.WriteJSON(controlResponse{Type: "error", Error: "E79748: Failed to update terminal env"})
				continue
			}
		}

		conn.WriteJSON(controlResponse{Type: "env_result", Status: "ok"})
	}
}
