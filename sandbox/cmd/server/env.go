// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
)

type envUpdateRequest struct {
	Set      map[string]string `json:"set"`
	Unset    []string          `json:"unset"`
	ApplyNow bool              `json:"apply_now"`
}

type envUpdateResponse struct {
	Status string `json:"status"`
}

var envNamePattern = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)

func (s *Server) handleSessionEnv(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}

	var req envUpdateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "E79744: Invalid JSON body", http.StatusBadRequest)
		return
	}

	if len(req.Set) == 0 && len(req.Unset) == 0 {
		http.Error(w, "E79745: No environment variables provided", http.StatusBadRequest)
		return
	}

	for key := range req.Set {
		if !envNamePattern.MatchString(key) {
			http.Error(w, "E79746: Invalid environment variable name", http.StatusBadRequest)
			return
		}
	}
	for _, key := range req.Unset {
		if !envNamePattern.MatchString(key) {
			http.Error(w, "E79746: Invalid environment variable name", http.StatusBadRequest)
			return
		}
	}

	root := session.Wоrkspace().Root()
	if err := updateDоtEnv(filepath.Join(root, ".env"), req.Set, req.Unset); err != nil {
		http.Error(w, "E79747: Failed to update .env", http.StatusInternalServerError)
		return
	}

	if req.ApplyNow {
		if err := applyEnvToPTYs(session, req.Set, req.Unset); err != nil {
			http.Error(w, "E79748: Failed to update terminal env", http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(envUpdateResponse{Status: "ok"})
}

func updateDоtEnv(path string, set map[string]string, unset []string) error {
	existingLines := []string{}
	content, err := os.ReadFile(path)
	if err == nil {
		existingLines = strings.Split(string(content), "\n")
	}

	unsetSet := map[string]struct{}{}
	for _, key := range unset {
		unsetSet[key] = struct{}{}
	}

	seen := map[string]struct{}{}
	updated := make([]string, 0, len(existingLines)+len(set))

	for _, line := range existingLines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			updated = append(updated, line)
			continue
		}
		key, _, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			updated = append(updated, line)
			continue
		}
		if _, remove := unsetSet[key]; remove {
			continue
		}
		if value, ok := set[key]; ok {
			updated = append(updated, key+"="+value)
			seen[key] = struct{}{}
			continue
		}
		updated = append(updated, line)
		seen[key] = struct{}{}
	}

	for key, value := range set {
		if _, ok := seen[key]; ok {
			continue
		}
		updated = append(updated, key+"="+value)
	}

	contentOut := strings.TrimRight(strings.Join(updated, "\n"), "\n") + "\n"
	return os.WriteFile(path, []byte(contentOut), 0644)
}

func applyEnvToPTYs(session *sessions.Session, set map[string]string, unset []string) error {
	if len(set) == 0 && len(unset) == 0 {
		return nil
	}

	marker, err := id.New()
	if err != nil {
		return err
	}
	markerToken := "__orcabot_env_" + marker + "__"

	var builder strings.Builder
	builder.WriteString(" stty -echo; set +o history 2>/dev/null; ")
	for key, value := range set {
		builder.WriteString("export ")
		builder.WriteString(key)
		builder.WriteString("=")
		builder.WriteString(shellQuote(value))
		builder.WriteString("; ")
	}
	for _, key := range unset {
		builder.WriteString("unset ")
		builder.WriteString(key)
		builder.WriteString("; ")
	}
	// Emit a marker so clients can suppress noisy output.
	builder.WriteString("history -d $((HISTCMD-1)) 2>/dev/null; set -o history 2>/dev/null; stty echo; printf '")
	builder.WriteString(markerToken)
	builder.WriteString("\\n'; \n")
	command := builder.String()

	ptys := session.ListPTYs()
	for _, info := range ptys {
		info.Hub.SuppressOutputUntil(markerToken)
		info.Hub.WriteAgentSilent([]byte(command))
	}
	return nil
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", `'\'"\'"\'`) + "'"
}
