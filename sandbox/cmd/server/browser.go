// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

import (
	"encoding/json"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
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
