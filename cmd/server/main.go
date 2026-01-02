package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"

	"github.com/hyper-ai-inc/hyper-backend/internal/fs"
	"github.com/hyper-ai-inc/hyper-backend/internal/sessions"
	"github.com/hyper-ai-inc/hyper-backend/internal/ws"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	sessionManager := sessions.NewManager()
	server := NewServer(sessionManager)

	log.Printf("Starting server on :%s", port)
	if err := http.ListenAndServe(":"+port, server.Handler()); err != nil {
		log.Fatal(err)
	}
}

type Server struct {
	sessions *sessions.Manager
	wsRouter *ws.Router
}

func NewServer(sm *sessions.Manager) *Server {
	return &Server{
		sessions: sm,
		wsRouter: ws.NewRouter(sm),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("GET /health", s.handleHealth)

	// Sessions
	mux.HandleFunc("POST /sessions", s.handleCreateSession)
	mux.HandleFunc("DELETE /sessions/{sessionId}", s.handleDeleteSession)

	// PTYs
	mux.HandleFunc("GET /sessions/{sessionId}/ptys", s.handleListPTYs)
	mux.HandleFunc("POST /sessions/{sessionId}/ptys", s.handleCreatePTY)
	mux.HandleFunc("DELETE /sessions/{sessionId}/ptys/{ptyId}", s.handleDeletePTY)

	// WebSocket for PTYs
	mux.HandleFunc("GET /sessions/{sessionId}/ptys/{ptyId}/ws", s.wsRouter.HandleWebSocket)

	// Agent
	mux.HandleFunc("POST /sessions/{sessionId}/agent", s.handleStartAgent)
	mux.HandleFunc("GET /sessions/{sessionId}/agent", s.handleGetAgent)
	mux.HandleFunc("POST /sessions/{sessionId}/agent/pause", s.handlePauseAgent)
	mux.HandleFunc("POST /sessions/{sessionId}/agent/resume", s.handleResumeAgent)
	mux.HandleFunc("POST /sessions/{sessionId}/agent/stop", s.handleStopAgent)
	mux.HandleFunc("GET /sessions/{sessionId}/agent/ws", s.wsRouter.HandleAgentWebSocket)

	// Filesystem
	mux.HandleFunc("GET /sessions/{sessionId}/files", s.handleListFiles)
	mux.HandleFunc("GET /sessions/{sessionId}/file", s.handleGetFile)
	mux.HandleFunc("PUT /sessions/{sessionId}/file", s.handlePutFile)
	mux.HandleFunc("DELETE /sessions/{sessionId}/file", s.handleDeleteFile)
	mux.HandleFunc("GET /sessions/{sessionId}/file/stat", s.handleStatFile)

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
	w.Write([]byte(`{"id":"` + session.ID + `"}`))
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
	sessionId := r.PathValue("sessionId")
	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	ptys := session.ListPTYs()
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ptys":[`))
	for i, p := range ptys {
		if i > 0 {
			w.Write([]byte(","))
		}
		w.Write([]byte(`{"id":"` + p.ID + `"}`))
	}
	w.Write([]byte(`]}`))
}

func (s *Server) handleCreatePTY(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")
	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	pty, err := session.CreatePTY()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	w.Write([]byte(`{"id":"` + pty.ID + `"}`))
}

func (s *Server) handleDeletePTY(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")
	ptyId := r.PathValue("ptyId")

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if err := session.DeletePTY(ptyId); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStartAgent(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
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
	w.Write([]byte(`{"id":"` + agent.ID() + `","state":"` + string(agent.State()) + `"}`))
}

func (s *Server) handleGetAgent(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	agent, err := session.GetAgent()
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"id":"` + agent.ID() + `","state":"` + string(agent.State()) + `"}`))
}

func (s *Server) handlePauseAgent(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
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
	w.Write([]byte(`{"state":"` + string(agent.State()) + `"}`))
}

func (s *Server) handleResumeAgent(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
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
	w.Write([]byte(`{"state":"` + string(agent.State()) + `"}`))
}

func (s *Server) handleStopAgent(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
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
	sessionId := r.PathValue("sessionId")
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/"
	}

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	entries, err := session.Workspace().List(path)
	if err != nil {
		if err == fs.ErrNotFound {
			http.Error(w, err.Error(), http.StatusNotFound)
		} else if err == fs.ErrPathTraversal {
			http.Error(w, err.Error(), http.StatusBadRequest)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"files": entries})
}

func (s *Server) handleGetFile(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path parameter required", http.StatusBadRequest)
		return
	}

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	data, err := session.Workspace().Read(path)
	if err != nil {
		if err == fs.ErrNotFound {
			http.Error(w, err.Error(), http.StatusNotFound)
		} else if err == fs.ErrPathTraversal {
			http.Error(w, err.Error(), http.StatusBadRequest)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(data)
}

func (s *Server) handlePutFile(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path parameter required", http.StatusBadRequest)
		return
	}

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := session.Workspace().Write(path, data); err != nil {
		if err == fs.ErrPathTraversal {
			http.Error(w, err.Error(), http.StatusBadRequest)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func (s *Server) handleDeleteFile(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path parameter required", http.StatusBadRequest)
		return
	}

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	if err := session.Workspace().Delete(path); err != nil {
		if err == fs.ErrNotFound {
			http.Error(w, err.Error(), http.StatusNotFound)
		} else if err == fs.ErrPathTraversal {
			http.Error(w, err.Error(), http.StatusBadRequest)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStatFile(w http.ResponseWriter, r *http.Request) {
	sessionId := r.PathValue("sessionId")
	path := r.URL.Query().Get("path")
	if path == "" {
		http.Error(w, "path parameter required", http.StatusBadRequest)
		return
	}

	session, err := s.sessions.Get(sessionId)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	info, err := session.Workspace().Stat(path)
	if err != nil {
		if err == fs.ErrNotFound {
			http.Error(w, err.Error(), http.StatusNotFound)
		} else if err == fs.ErrPathTraversal {
			http.Error(w, err.Error(), http.StatusBadRequest)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(info)
}
