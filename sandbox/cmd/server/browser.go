// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-v6-navigate-egress
package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/egress"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
)

type browserStatusResponse struct {
	Running   bool `json:"running"`
	Ready     bool `json:"ready"`
	WSPort    int  `json:"ws_port"`
	Display   int  `json:"display"`
	DebugPort int  `json:"debug_port"`
}

func (s *Server) handleBrowserStart(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	status, err := session.StartBrowser()
	if err != nil {
		log.Printf("browser start error: %v", err)
		http.Error(w, "E79310: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, browserStatusResponse{
		Running:   status.Running,
		Ready:     status.Ready,
		WSPort:    status.WSPort,
		Display:   status.Display,
		DebugPort: status.DebugPort,
	})
}

func (s *Server) handleBrowserStop(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	session.StopBrowser()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleBrowserStatus(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	status := session.BrowserStatus()
	writeJSON(w, http.StatusOK, browserStatusResponse{
		Running:   status.Running,
		Ready:     status.Ready,
		WSPort:    status.WSPort,
		Display:   status.Display,
		DebugPort: status.DebugPort,
	})
}

type browserOpenRequest struct {
	URL   string `json:"url"`
	PtyID string `json:"pty_id,omitempty"`
}

func (s *Server) handleBrowserOpen(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")
	session := s.getSessiоnOrErrоr(w, sessionID)
	if session == nil {
		return
	}

	var req browserOpenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "E79817: invalid payload", http.StatusBadRequest)
		return
	}

	s.handleBrowserOpenForPTY(w, r, session, req.PtyID, req.URL)
}

// handleBrowserOpenLocal is the MCPLocal (port 8081) variant of handleBrowserOpen.
// Requires pty_id + X-MCP-Secret to bind the caller to a specific PTY identity,
// preventing arbitrary sandbox processes from opening browser URLs for any session.
// Pool mode is blocked upstream by poolModeGuard (503), so this only runs in
// non-pool mode where ORCABOT_MCP_SECRET is present in the PTY environment.
// The external port-8080 route uses handleBrowserOpen, authenticated by internal token.
// REVISION: browser-v4-tcp-pty-auth
func (s *Server) handleBrowserOpenLocal(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionId")
	session := s.getSessiоnOrErrоr(w, sessionID)
	if session == nil {
		return
	}

	var req browserOpenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "E79817: invalid payload", http.StatusBadRequest)
		return
	}

	if req.PtyID == "" {
		http.Error(w, "E79819: pty_id required for browser open on localhost MCP server", http.StatusBadRequest)
		return
	}
	mcpSecret := r.Header.Get("X-MCP-Secret")
	storedSecret := session.GetMCPSecret(req.PtyID)
	if storedSecret == "" || subtle.ConstantTimeCompare([]byte(mcpSecret), []byte(storedSecret)) != 1 {
		http.Error(w, "E79820: invalid PTY authentication for browser open", http.StatusForbidden)
		return
	}

	s.handleBrowserOpenForPTY(w, r, session, req.PtyID, req.URL)
}

// checkBrowserEgress applies the egress allowlist to any agent-driven browser
// navigation. Chromium runs as root and is outside the UID-range iptables rule,
// so without this check an agent can exfiltrate data by encoding secrets in a URL.
// Returns an HTTP status code and error message if navigation should be blocked,
// or 0/nil if permitted.
// No-op when EGRESS_PROXY_ENABLED is unset (s.egressEnabled == false).
// REVISION: browser-v6-navigate-egress
func (s *Server) checkBrowserEgress(urlStr string) (int, string) {
	if !s.egressEnabled || s.egressProxy == nil {
		return 0, ""
	}
	parsed, err := url.Parse(urlStr)
	if err != nil || parsed.Host == "" {
		return http.StatusBadRequest, "E79821: invalid URL for browser navigation"
	}
	host := parsed.Hostname()
	port := 443
	if p := parsed.Port(); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			port = n
		}
	}
	if strings.EqualFold(parsed.Scheme, "http") {
		port = 80
	}
	decision := s.egressProxy.CheckAndHold(host, port)
	if decision != egress.DecisionDefault && decision != egress.DecisionAllowOnce && decision != egress.DecisionAllowAlways {
		log.Printf("[browser] egress denied: host=%s decision=%s url=%s", host, decision, urlStr)
		return http.StatusForbidden, "E79822: browser navigation denied by egress policy"
	}
	return 0, ""
}

// handleBrowserOpenForPTY is the auth-free core of handleBrowserOpen.
// Called directly by the privileged Unix socket handler after SO_PEERCRED auth.
//
// INTENTIONAL DESIGN: this handler does NOT require a browser integration edge
// (canvas wiring) or a control-plane policy decision. That gate (mcp.go handleMCPCallTool)
// controls the LLM's *programmatic* browser access via MCP tools — screenshot, click,
// evaluate JS. xdg-open is the shell-level "show this URL to the user" primitive:
// the equivalent of the user pressing Ctrl+L in a browser themselves. It is visible
// in the frontend noVNC pane; it is not a covert channel.
// The security boundary here is the egress allowlist check; see checkBrowserEgress.
// REVISION: browser-v6-navigate-egress
func (s *Server) handleBrowserOpenForPTY(w http.ResponseWriter, r *http.Request, session *sessions.Session, ptyID string, urlStr string) {
	if status, msg := s.checkBrowserEgress(urlStr); status != 0 {
		http.Error(w, msg, status)
		return
	}

	if err := session.OpenBrowserURL(urlStr); err != nil {
		log.Printf("browser open error: %v", err)
		http.Error(w, "E79311: "+err.Error(), http.StatusInternalServerError)
		return
	}

	go s.notifyControlPlaneBrowserOpen(session.ID, urlStr, ptyID)

	w.WriteHeader(http.StatusNoContent)
}

// notifyControlPlaneBrowserOpen notifies the control plane to create/show the browser
// component in the frontend. This runs async and is best-effort since the xdg-open
// script inside the PTY cannot access INTERNAL_API_TOKEN (filtered for security).
func (s *Server) notifyControlPlaneBrowserOpen(sandboxSessionID string, url string, ptyID string) {
	controlplaneURL := strings.TrimSuffix(os.Getenv("CONTROLPLANE_URL"), "/")
	internalToken := os.Getenv("INTERNAL_API_TOKEN")
	if controlplaneURL == "" || internalToken == "" {
		log.Printf("[browser] skipping control plane notification: missing CONTROLPLANE_URL or INTERNAL_API_TOKEN")
		return
	}

	payload := map[string]string{
		"sandbox_session_id": sandboxSessionID,
		"url":                url,
		"pty_id":             ptyID,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[browser] failed to marshal payload: %v", err)
		return
	}

	targetURL := fmt.Sprintf("%s/internal/browser/open", controlplaneURL)
	req, err := http.NewRequest("POST", targetURL, bytes.NewReader(body))
	if err != nil {
		log.Printf("[browser] failed to create request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Token", internalToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[browser] failed to notify control plane: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		log.Printf("[browser] control plane returned status %d", resp.StatusCode)
	}
}

func (s *Server) handleBrowserProxy(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	if r.PathValue("path") == "package.json" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"name":"novnc","version":"0.0.0"}`))
		return
	}

	status := session.BrowserStatus()
	if !status.Running || status.WSPort == 0 {
		http.Error(w, "E79812: browser not running", http.StatusNotFound)
		return
	}

	target, err := url.Parse("http://127.0.0.1:" + strconv.Itoa(status.WSPort))
	if err != nil {
		http.Error(w, "E79813: browser proxy unavailable", http.StatusInternalServerError)
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Del("X-Frame-Options")
		return nil
	}
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, err error) {
		http.Error(rw, "E79814: browser proxy error", http.StatusBadGateway)
	}

	path := r.PathValue("path")
	if path == "" {
		path = "vnc.html"
	}
	r.URL.Path = "/" + strings.TrimPrefix(path, "/")
	proxy.ServeHTTP(w, r)
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// Browser automation handlers

type browserScreenshotRequest struct {
	Path string `json:"path"`
}

func (s *Server) handleBrowserScreenshot(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	var req browserScreenshotRequest
	if r.Body != nil {
		json.NewDecoder(r.Body).Decode(&req)
	}

	path, err := session.BrowserScreenshot(req.Path)
	if err != nil {
		log.Printf("browser screenshot error: %v", err)
		http.Error(w, "E79312: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

type browserClickRequest struct {
	Selector string `json:"selector"`
}

func (s *Server) handleBrowserClick(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	var req browserClickRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "E79830: invalid payload", http.StatusBadRequest)
		return
	}

	if req.Selector == "" {
		http.Error(w, "E79831: selector required", http.StatusBadRequest)
		return
	}

	if err := session.BrowserClick(req.Selector); err != nil {
		log.Printf("browser click error: %v", err)
		http.Error(w, "E79313: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type browserTypeRequest struct {
	Selector string `json:"selector"`
	Text     string `json:"text"`
}

func (s *Server) handleBrowserType(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	var req browserTypeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "E79832: invalid payload", http.StatusBadRequest)
		return
	}

	if req.Selector == "" {
		http.Error(w, "E79833: selector required", http.StatusBadRequest)
		return
	}

	if err := session.BrowserType(req.Selector, req.Text); err != nil {
		log.Printf("browser type error: %v", err)
		http.Error(w, "E79314: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type browserEvaluateRequest struct {
	Script string `json:"script"`
}

func (s *Server) handleBrowserEvaluate(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	var req browserEvaluateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "E79834: invalid payload", http.StatusBadRequest)
		return
	}

	if req.Script == "" {
		http.Error(w, "E79835: script required", http.StatusBadRequest)
		return
	}

	result, err := session.BrowserEvaluate(req.Script)
	if err != nil {
		log.Printf("browser evaluate error: %v", err)
		http.Error(w, "E79315: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"result": result})
}

func (s *Server) handleBrowserContent(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	content, err := session.BrowserGetContent()
	if err != nil {
		log.Printf("browser content error: %v", err)
		http.Error(w, "E79316: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"content": content})
}

func (s *Server) handleBrowserHTML(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	html, err := session.BrowserGetHTML()
	if err != nil {
		log.Printf("browser html error: %v", err)
		http.Error(w, "E79317: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"html": html})
}

func (s *Server) handleBrowserURL(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	url, err := session.BrowserGetURL()
	if err != nil {
		log.Printf("browser url error: %v", err)
		http.Error(w, "E79318: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func (s *Server) handleBrowserTitle(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	title, err := session.BrowserGetTitle()
	if err != nil {
		log.Printf("browser title error: %v", err)
		http.Error(w, "E79319: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"title": title})
}

type browserWaitRequest struct {
	Selector string `json:"selector"`
	Timeout  int    `json:"timeout"`
}

func (s *Server) handleBrowserWait(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	var req browserWaitRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "E79836: invalid payload", http.StatusBadRequest)
		return
	}

	if req.Selector == "" {
		http.Error(w, "E79837: selector required", http.StatusBadRequest)
		return
	}

	timeout := req.Timeout
	if timeout <= 0 {
		timeout = 30
	}

	if err := session.BrowserWaitForSelector(req.Selector, timeout); err != nil {
		log.Printf("browser wait error: %v", err)
		http.Error(w, "E79320: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type browserNavigateRequest struct {
	URL string `json:"url"`
}

func (s *Server) handleBrowserNavigate(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	var req browserNavigateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "E79838: invalid payload", http.StatusBadRequest)
		return
	}

	if req.URL == "" {
		http.Error(w, "E79839: url required", http.StatusBadRequest)
		return
	}

	// Egress allowlist applies even on the internal-token-authenticated route.
	// Chromium runs as root and bypasses iptables regardless of the caller.
	if status, msg := s.checkBrowserEgress(req.URL); status != 0 {
		http.Error(w, msg, status)
		return
	}

	if err := session.BrowserNavigate(req.URL); err != nil {
		log.Printf("browser navigate error: %v", err)
		http.Error(w, "E79321: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

type browserScrollRequest struct {
	X int `json:"x"`
	Y int `json:"y"`
}

func (s *Server) handleBrowserScroll(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	var req browserScrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "E79840: invalid payload", http.StatusBadRequest)
		return
	}

	if err := session.BrowserScroll(req.X, req.Y); err != nil {
		log.Printf("browser scroll error: %v", err)
		http.Error(w, "E79322: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
