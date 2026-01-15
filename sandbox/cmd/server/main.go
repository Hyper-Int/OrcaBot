package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/auth"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/fs"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/ws"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	sessionManager := sessions.NewManager()
	server := NewServer(sessionManager)

	httpServer := &http.Server{
		Addr:    ":" + port,
		Handler: server.Handler(),
	}

	// Channel to listen for shutdown signals
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, syscall.SIGINT, syscall.SIGTERM)

	// Start server in goroutine
	go func() {
		log.Printf("Starting server on :%s", port)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	// Wait for shutdown signal
	sig := <-shutdown
	log.Printf("Received signal %v, shutting down...", sig)

	// Create context with timeout for graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Shutdown HTTP server (stops accepting new connections)
	if err := httpServer.Shutdown(ctx); err != nil {
		log.Printf("HTTP server shutdown error: %v", err)
	}

	// Close all sessions (kills PTYs, agents, cleans up workspaces)
	sessionManager.Shutdown()

	log.Println("Server stopped")
}

type Server struct {
	sessions *sessions.Manager
	wsRouter *ws.Router
	auth     *auth.Middleware
	machine  string
}

func NewServer(sm *sessions.Manager) *Server {
	authMiddleware := auth.NewMiddleware()
	if !authMiddleware.IsEnabled() {
		log.Println("WARNING: SANDBOX_INTERNAL_TOKEN not set - authentication is disabled, all requests will be rejected")
	}
	return &Server{
		sessions: sm,
		wsRouter: ws.NewRouter(sm),
		auth:     authMiddleware,
		machine:  sandboxMachineID(),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Health check - unauthenticated (for load balancer probes)
	mux.HandleFunc("GET /health", s.handleHealth)

	// Debug profiling - requires auth + machine pinning
	mux.HandleFunc("GET /debug/pprof/", s.auth.RequireAuthFunc(s.requireMachine(pprof.Index)))
	mux.HandleFunc("GET /debug/pprof/cmdline", s.auth.RequireAuthFunc(s.requireMachine(pprof.Cmdline)))
	mux.HandleFunc("GET /debug/pprof/profile", s.auth.RequireAuthFunc(s.requireMachine(pprof.Profile)))
	mux.HandleFunc("GET /debug/pprof/symbol", s.auth.RequireAuthFunc(s.requireMachine(pprof.Symbol)))
	mux.HandleFunc("GET /debug/pprof/trace", s.auth.RequireAuthFunc(s.requireMachine(pprof.Trace)))

	// All other routes require authentication
	// Sessions
	mux.HandleFunc("POST /sessions", s.auth.RequireAuthFunc(s.requireMachine(s.handleCreateSession)))
	mux.HandleFunc("DELETE /sessions/{sessionId}", s.auth.RequireAuthFunc(s.requireMachine(s.handleDeleteSession)))

	// PTYs
	mux.HandleFunc("GET /sessions/{sessionId}/ptys", s.auth.RequireAuthFunc(s.requireMachine(s.handleListPTYs)))
	mux.HandleFunc("POST /sessions/{sessionId}/ptys", s.auth.RequireAuthFunc(s.requireMachine(s.handleCreatePTY)))
	mux.HandleFunc("DELETE /sessions/{sessionId}/ptys/{ptyId}", s.auth.RequireAuthFunc(s.requireMachine(s.handleDeletePTY)))

	// WebSocket for PTYs - auth checked via token, origin validated by upgrader
	mux.HandleFunc("GET /sessions/{sessionId}/ptys/{ptyId}/ws", s.auth.RequireAuthFunc(s.requireMachine(s.wsRouter.HandleWebSocket)))

	// Agent
	mux.HandleFunc("POST /sessions/{sessionId}/agent", s.auth.RequireAuthFunc(s.requireMachine(s.handleStartAgent)))
	mux.HandleFunc("GET /sessions/{sessionId}/agent", s.auth.RequireAuthFunc(s.requireMachine(s.handleGetAgent)))
	mux.HandleFunc("POST /sessions/{sessionId}/agent/pause", s.auth.RequireAuthFunc(s.requireMachine(s.handlePauseAgent)))
	mux.HandleFunc("POST /sessions/{sessionId}/agent/resume", s.auth.RequireAuthFunc(s.requireMachine(s.handleResumeAgent)))
	mux.HandleFunc("POST /sessions/{sessionId}/agent/stop", s.auth.RequireAuthFunc(s.requireMachine(s.handleStopAgent)))
	mux.HandleFunc("GET /sessions/{sessionId}/agent/ws", s.auth.RequireAuthFunc(s.requireMachine(s.wsRouter.HandleAgentWebSocket)))

	// Filesystem
	mux.HandleFunc("GET /sessions/{sessionId}/files", s.auth.RequireAuthFunc(s.requireMachine(s.handleListFiles)))
	mux.HandleFunc("GET /sessions/{sessionId}/file", s.auth.RequireAuthFunc(s.requireMachine(s.handleGetFile)))
	mux.HandleFunc("PUT /sessions/{sessionId}/file", s.auth.RequireAuthFunc(s.requireMachine(s.handlePutFile)))
	mux.HandleFunc("DELETE /sessions/{sessionId}/file", s.auth.RequireAuthFunc(s.requireMachine(s.handleDeleteFile)))
	mux.HandleFunc("GET /sessions/{sessionId}/file/stat", s.auth.RequireAuthFunc(s.requireMachine(s.handleStatFile)))

	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	session, err := s.sessions.Create()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"id":         session.ID,
		"machine_id": s.machine,
	})
}

func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")
	if err := s.sessions.Delete(sessionId); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleListPTYs(w http.ResponseWriter, r *http.Request) {
	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}
	ptys := session.ListPTYs()

	type ptyInfo struct {
		ID string `json:"id"`
	}
	ptyList := make([]ptyInfo, len(ptys))
	for i, p := range ptys {
		ptyList[i] = ptyInfo{ID: p.ID}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ptys": ptyList,
	})
}

func (s *Server) handleCreatePTY(w http.ResponseWriter, r *http.Request) {
	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	// Parse optional creator_id from request body
	var req struct {
		CreatorID string `json:"creator_id"`
		Command   string `json:"command"`
	}
	if r.Body != nil {
		json.NewDecoder(r.Body).Decode(&req) // Ignore errors - creator_id is optional
	}

	pty, err := session.CreatePTY(req.CreatorID, req.Command)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"id": pty.ID})
}

func (s *Server) requireMachine(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		target := r.Header.Get("X-Sandbox-Machine-ID")
		if target == "" || s.machine == "" || target == s.machine {
			next(w, r)
			return
		}

		w.Header().Set("Fly-Replay", "instance="+target)
		w.WriteHeader(http.StatusConflict)
	}
}

func sandboxMachineID() string {
	if id := os.Getenv("FLY_MACHINE_ID"); id != "" {
		return id
	}
	if id := os.Getenv("FLY_ALLOC_ID"); id != "" {
		return id
	}
	return ""
}

// getSessionOrError retrieves a session by ID and returns it.
// If the session doesn't exist, it writes a 404 error response and returns nil.
func (s *Server) getSessionOrError(w http.ResponseWriter, sessionId string) *sessions.Session {
	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return nil
	}
	return session
}

// writeFSError writes an appropriate HTTP error response for filesystem errors.
func writeFSError(w http.ResponseWriter, err error) {
	switch err {
	case fs.ErrNotFound:
		http.Error(w, err.Error(), http.StatusNotFound)
	case fs.ErrPathTraversal:
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *Server) handleDeletePTY(w http.ResponseWriter, r *http.Request) {
	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}
	if err := session.DeletePTY(r.PathValue("ptyId")); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStartAgent(w http.ResponseWriter, r *http.Request) {
	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	agent, err := session.StartAgent(sessions.AgentTypeClaude)
	if err != nil {
		if err == sessions.ErrAgentExists {
			http.Error(w, err.Error(), http.StatusConflict)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"id":    agent.ID(),
		"state": string(agent.State()),
	})
}

func (s *Server) handleGetAgent(w http.ResponseWriter, r *http.Request) {
	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	agent, err := session.GetAgent()
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"id":    agent.ID(),
		"state": string(agent.State()),
	})
}

func (s *Server) handlePauseAgent(w http.ResponseWriter, r *http.Request) {
	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	agent, err := session.GetAgent()
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	if err := agent.Pause(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"state": string(agent.State())})
}

func (s *Server) handleResumeAgent(w http.ResponseWriter, r *http.Request) {
	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	agent, err := session.GetAgent()
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	if err := agent.Resume(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"state": string(agent.State())})
}

func (s *Server) handleStopAgent(w http.ResponseWriter, r *http.Request) {
	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	if err := session.StopAgent(); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// Filesystem handlers

func (s *Server) handleListFiles(w http.ResponseWriter, r *http.Request) {
	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}

	entries, err := session.Workspace().List(path)
	if err != nil {
		writeFSError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"files": entries})
}

func (s *Server) handleGetFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path parameter required", http.StatusBadRequest)
		return
	}

	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	data, err := session.Workspace().Read(path)
	if err != nil {
		writeFSError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(data)
}

func (s *Server) handlePutFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path parameter required", http.StatusBadRequest)
		return
	}

	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := session.Workspace().Write(path, data); err != nil {
		writeFSError(w, err)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path parameter required", http.StatusBadRequest)
		return
	}

	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	if err := session.Workspace().Delete(path); err != nil {
		writeFSError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStatFile(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path parameter required", http.StatusBadRequest)
		return
	}

	session := s.getSessionOrError(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	info, err := session.Workspace().Stat(path)
	if err != nil {
		writeFSError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}
