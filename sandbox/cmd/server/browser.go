// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
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
	URL string `json:"url"`
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

	if err := session.OpenBrowserURL(req.URL); err != nil {
		log.Printf("browser open error: %v", err)
		http.Error(w, "E79311: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Notify control plane to create browser item in frontend (async, best-effort)
	go s.notifyControlPlaneBrowserOpen(sessionID, req.URL)

	w.WriteHeader(http.StatusNoContent)
}

// notifyControlPlaneBrowserOpen notifies the control plane to create/show the browser
// component in the frontend. This runs async and is best-effort since the xdg-open
// script inside the PTY cannot access INTERNAL_API_TOKEN (filtered for security).
func (s *Server) notifyControlPlaneBrowserOpen(sandboxSessionID string, url string) {
	controlplaneURL := strings.TrimSuffix(os.Getenv("CONTROLPLANE_URL"), "/")
	internalToken := os.Getenv("INTERNAL_API_TOKEN")
	if controlplaneURL == "" || internalToken == "" {
		log.Printf("[browser] skipping control plane notification: missing CONTROLPLANE_URL or INTERNAL_API_TOKEN")
		return
	}

	payload := map[string]string{
		"sandbox_session_id": sandboxSessionID,
		"url":                url,
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
