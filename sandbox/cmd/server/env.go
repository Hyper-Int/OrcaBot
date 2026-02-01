// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/broker"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
)

// SecretConfig represents a secret with optional broker protection.
type SecretConfig struct {
	Value           string `json:"value"`
	BrokerProtected bool   `json:"broker_protected"` // If true, use broker instead of setting env var directly
}

// ApprovedDomainConfig represents an approved domain for a custom secret.
type ApprovedDomainConfig struct {
	SecretName   string `json:"secret_name"`
	Domain       string `json:"domain"`
	HeaderName   string `json:"header_name"`
	HeaderFormat string `json:"header_format"`
}

type envUpdateRequest struct {
	Set             map[string]string        `json:"set"`              // Regular env vars (set directly)
	Secrets         map[string]SecretConfig  `json:"secrets"`          // Secrets with broker protection option
	ApprovedDomains []ApprovedDomainConfig   `json:"approved_domains"` // Pre-approved domains for custom secrets
	Unset           []string                 `json:"unset"`
	ApplyNow        bool                     `json:"apply_now"`
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

	if len(req.Set) == 0 && len(req.Secrets) == 0 && len(req.Unset) == 0 {
		http.Error(w, "E79745: No environment variables provided", http.StatusBadRequest)
		return
	}

	// Validate env var names
	for key := range req.Set {
		if !envNamePattern.MatchString(key) {
			http.Error(w, "E79746: Invalid environment variable name", http.StatusBadRequest)
			return
		}
	}
	for key := range req.Secrets {
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

	// Process secrets - configure broker and build effective env vars
	effectiveEnvVars := make(map[string]string)
	secretValues := make(map[string]string) // For redaction

	// Copy regular env vars
	for key, value := range req.Set {
		effectiveEnvVars[key] = value
	}

	// Process secrets with broker protection
	brokerPort := session.BrokerPort()
	sessionBroker := session.Broker()

	// Only clear and rebuild broker configs when secrets are provided.
	// This preserves configs when only updating plain env vars.
	if len(req.Secrets) > 0 {
		sessionBroker.ClearConfigs()
	} else if len(req.Unset) > 0 {
		// Remove configs for secrets being unset
		for _, name := range req.Unset {
			sessionBroker.RemoveConfig("custom/" + name)
			// Also try removing as built-in provider
			providerName, _ := broker.GetProviderByEnvKey(name)
			if providerName != "" {
				sessionBroker.RemoveConfig(providerName)
			}
		}
	}

	for secretName, config := range req.Secrets {
		if !config.BrokerProtected {
			// Not broker-protected: set the actual value as env var
			// Don't add to redaction - env vars are meant to be visible
			effectiveEnvVars[secretName] = config.Value
			continue
		}

		// Only brokered secrets should be redacted
		secretValues[secretName] = config.Value

		// Broker-protected: configure the broker and set dummy env vars
		providerName, providerSpec := broker.GetProviderByEnvKey(secretName)

		if providerSpec != nil {
			// Built-in provider: use hardcoded config
			effectiveEnvVars[secretName] = broker.GetDummyValue(providerName)
			effectiveEnvVars[providerSpec.BrokerEnvKey] = fmt.Sprintf("http://localhost:%d/broker/%s",
				brokerPort, providerName)

			sessionBroker.SetConfig(providerName, &broker.ProviderConfig{
				Name:          providerName,
				TargetBaseURL: providerSpec.TargetBaseURL,
				HeaderName:    providerSpec.HeaderName,
				HeaderFormat:  providerSpec.HeaderFormat,
				SecretValue:   config.Value,
				SessionID:     session.ID,
			})
		} else {
			// Custom secret: use dynamic domain approval
			customID := "custom/" + secretName
			effectiveEnvVars[secretName] = broker.GetCustomDummyValue(secretName)
			effectiveEnvVars[secretName+"_BROKER"] = fmt.Sprintf("http://localhost:%d/broker/%s",
				brokerPort, customID)

			sessionBroker.SetConfig(customID, &broker.ProviderConfig{
				Name:        customID,
				SecretValue: config.Value,
				SessionID:   session.ID,
				// TargetBaseURL, HeaderName, HeaderFormat are dynamic for custom secrets
			})
		}
	}

	// Update session's secret values for output redaction
	session.SetSecrets(secretValues)

	// Only update approved domains if explicitly provided in the request
	// nil means "don't change", empty array means "clear all"
	if req.ApprovedDomains != nil {
		sessionBroker.ClearApprovedDomains()
		for _, approval := range req.ApprovedDomains {
			sessionBroker.AddApprovedDomain(approval.SecretName, approval.Domain, &broker.ApprovedDomainConfig{
				Domain:       approval.Domain,
				HeaderName:   approval.HeaderName,
				HeaderFormat: approval.HeaderFormat,
			})
		}
	}

	// Write to .env file
	root := session.Wоrkspace().Root()
	if err := updateDоtEnv(filepath.Join(root, ".env"), effectiveEnvVars, req.Unset); err != nil {
		http.Error(w, "E79747: Failed to update .env", http.StatusInternalServerError)
		return
	}

	if req.ApplyNow {
		if err := applyEnvToPTYs(session, effectiveEnvVars, req.Unset); err != nil {
			http.Error(w, "E79748: Failed to update terminal env", http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(envUpdateResponse{Status: "ok"})
}

// envQuote wraps a value in double quotes for .env file, escaping special chars.
func envQuote(value string) string {
	// Escape backslashes, double quotes, dollar signs, and backticks
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	escaped = strings.ReplaceAll(escaped, `$`, `\$`)
	escaped = strings.ReplaceAll(escaped, "`", "\\`")
	return `"` + escaped + `"`
}

// envLine formats a key=value pair for .env file with export prefix
func envLine(key, value string) string {
	return "export " + key + "=" + envQuote(value)
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
		// Strip "export " prefix if present for parsing
		lineToParse := trimmed
		if strings.HasPrefix(lineToParse, "export ") {
			lineToParse = strings.TrimPrefix(lineToParse, "export ")
		}
		key, _, ok := strings.Cut(lineToParse, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			updated = append(updated, line)
			continue
		}
		if _, remove := unsetSet[key]; remove {
			continue
		}
		if value, ok := set[key]; ok {
			updated = append(updated, envLine(key, value))
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
		updated = append(updated, envLine(key, value))
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
