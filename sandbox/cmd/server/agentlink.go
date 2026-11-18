// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: agent-link-v1-device-client

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/agentlink"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
)

// Agent blocks (outside AI agents linked to the dashboard owner). Two audiences:
//
//   - The dashboard's chat view: GET/POST /sessions/{sessionId}/agent-link/chat,
//     signed by the control plane (which only lets the dashboard owner through).
//   - Terminals: list, message and read the agents their canvas item is connected
//     to by edges, and no others. Pool mode: the privileged Unix socket (/agents/...,
//     identity from SO_PEERCRED). Otherwise: MCPLocal with the PTY's X-MCP-Secret
//     (/sessions/{sessionId}/ptys/{ptyId}/agents/{action}).
//
// Each dashboard gets one client (internal/agentlink), started on first use.

var (
	agentLinkOnce sync.Once
	agentLinkMgr  *agentlink.Manager
)

func agentLinks() *agentlink.Manager {
	agentLinkOnce.Do(func() {
		bin := os.Getenv("AGENT_LINK_BIN")
		if bin == "" {
			bin = "/usr/local/bin/orcabot-agent-link"
		}
		state := os.Getenv("AGENT_LINK_STATE")
		if state == "" {
			state = "/var/lib/orcabot/agent-link"
		}
		agentLinkMgr = agentlink.NewManager(agentlink.NewCPClient(os.Getenv("CONTROLPLANE_URL")), bin, state)
	})
	return agentLinkMgr
}

type agentChatMessage struct {
	Seq  int64  `json:"seq"`
	From string `json:"from"`
	Text string `json:"text"`
	Ts   int64  `json:"ts"`
}

func chatMessages(msgs []agentlink.Message) []agentChatMessage {
	out := make([]agentChatMessage, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, agentChatMessage{Seq: m.Seq, From: m.From, Text: m.Text, Ts: m.Ts})
	}
	return out
}

func agentLinkError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg, "revision": agentlink.Revision})
}

// handleAgentLinkChat: the owner's chat with one agent (control-plane signed).
func (s *Server) handleAgentLinkChat(w http.ResponseWriter, r *http.Request) {
	session, err := s.sessions.Get(r.PathValue("sessionId"))
	if err != nil || session.DashboardID == "" {
		agentLinkError(w, http.StatusNotFound, "E79960: session not found")
		return
	}
	link := agentLinks().Link(session.DashboardID)
	if r.Method == http.MethodPost {
		var body struct {
			Agent string `json:"agent"`
			Text  string `json:"text"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
			agentLinkError(w, http.StatusBadRequest, "E79961: invalid JSON body")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
		defer cancel()
		msg, err := link.Send(ctx, body.Agent, body.Text)
		if err != nil {
			agentLinkError(w, http.StatusBadGateway, "E79962: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "seq": msg.Seq, "revision": agentlink.Revision})
		return
	}
	agent := r.URL.Query().Get("agent")
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	status, detail := link.Status()
	writeJSON(w, http.StatusOK, map[string]any{
		"status": status, "detail": detail, "revision": agentlink.Revision,
		"messages": chatMessages(link.Messages(r.Context(), agent, after, 0)),
	})
}

// handleAgentsForPTY: what a terminal can do with the agents it's connected to.
//
//	GET  agents             -> {agents, status}
//	POST agents/send        {agent, text} -> {seq}
//	GET  agents/messages    ?agent=&after=&wait= (seconds, at most 60) -> {messages, status}
//
// `agent` is the agent's identity or name. Agents the terminal isn't connected to
// are refused (E79964), as if they didn't exist.
func (s *Server) handleAgentsForPTY(w http.ResponseWriter, r *http.Request, session *sessions.Session, ptyID, action string) {
	if session == nil || session.DashboardID == "" || ptyID == "" {
		agentLinkError(w, http.StatusForbidden, "E79963: no terminal identity")
		return
	}
	mgr := agentLinks()
	ctx := r.Context()
	switch strings.Trim(action, "/") {
	case "":
		agents, err := mgr.TerminalAgents(ctx, session.DashboardID, ptyID)
		if err != nil {
			agentLinkError(w, http.StatusBadGateway, "E79965: couldn't ask the control plane")
			return
		}
		if len(agents) == 0 {
			// No Agent blocks here: don't start the dashboard's client (or link a device) for nothing.
			writeJSON(w, http.StatusOK, map[string]any{"agents": []agentlink.Agent{}, "status": "idle", "revision": agentlink.Revision})
			return
		}
		// Connected to an agent: start linking now, so the first message isn't slow.
		status, _ := mgr.Link(session.DashboardID).Status()
		writeJSON(w, http.StatusOK, map[string]any{"agents": agents, "status": status, "revision": agentlink.Revision})
	case "send":
		if r.Method != http.MethodPost {
			agentLinkError(w, http.StatusMethodNotAllowed, "E79966: POST only")
			return
		}
		var body struct {
			Agent string `json:"agent"`
			Text  string `json:"text"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body); err != nil {
			agentLinkError(w, http.StatusBadRequest, "E79961: invalid JSON body")
			return
		}
		a, ok, err := mgr.Allowed(ctx, session.DashboardID, ptyID, body.Agent)
		if err != nil {
			agentLinkError(w, http.StatusBadGateway, "E79965: couldn't ask the control plane")
			return
		}
		if !ok {
			agentLinkError(w, http.StatusForbidden, "E79964: this terminal isn't connected to that agent")
			return
		}
		sctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		msg, err := mgr.Link(session.DashboardID).Send(sctx, a.Identity, body.Text)
		if err != nil {
			agentLinkError(w, http.StatusBadGateway, "E79962: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"seq": msg.Seq, "ts": msg.Ts, "revision": agentlink.Revision})
	case "messages":
		q := r.URL.Query()
		a, ok, err := mgr.Allowed(ctx, session.DashboardID, ptyID, q.Get("agent"))
		if err != nil {
			agentLinkError(w, http.StatusBadGateway, "E79965: couldn't ask the control plane")
			return
		}
		if !ok {
			agentLinkError(w, http.StatusForbidden, "E79964: this terminal isn't connected to that agent")
			return
		}
		after, _ := strconv.ParseInt(q.Get("after"), 10, 64)
		wait, _ := strconv.Atoi(q.Get("wait"))
		if wait < 0 {
			wait = 0
		} else if wait > 60 {
			wait = 60
		}
		link := mgr.Link(session.DashboardID)
		msgs := link.Messages(ctx, a.Identity, after, time.Duration(wait)*time.Second)
		status, _ := link.Status()
		writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "status": status, "revision": agentlink.Revision})
	default:
		agentLinkError(w, http.StatusNotFound, "E79967: unknown agents action")
	}
}

// handleAgentsLocal: the MCPLocal (non-pool) route; requireLocalPTYAuth has checked the PTY's secret.
func (s *Server) handleAgentsLocal(w http.ResponseWriter, r *http.Request) {
	session, err := s.sessions.Get(r.PathValue("sessionId"))
	if err != nil {
		agentLinkError(w, http.StatusNotFound, "E79960: session not found")
		return
	}
	s.handleAgentsForPTY(w, r, session, r.PathValue("ptyId"), r.PathValue("action"))
}
