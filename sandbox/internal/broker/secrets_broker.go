// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package broker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// REVISION: broker-v2-fix-gemini-baseurl
const brokerRevision = "broker-v2-fix-gemini-baseurl"

func init() {
	log.Printf("[broker] REVISION: %s loaded at %s", brokerRevision, time.Now().Format(time.RFC3339))
}

// ProviderConfig holds runtime configuration for a specific provider.
type ProviderConfig struct {
	Name          string // Provider name (e.g., "anthropic") or "custom/SECRET_NAME"
	TargetBaseURL string // Base URL for built-in providers, empty for custom
	HeaderName    string // Auth header name
	HeaderFormat  string // Auth header format (e.g., "Bearer %s")
	SecretValue   string // The actual API key value
	SessionID     string // Session ID that owns this config (for approval callbacks)
}

// ApprovedDomainConfig holds configuration for an approved custom secret domain.
type ApprovedDomainConfig struct {
	Domain       string
	HeaderName   string
	HeaderFormat string
}

// SecretsBroker proxies API requests and injects authentication headers.
// It runs inside each sandbox VM on localhost to prevent secrets from
// being exposed to LLMs running in the sandbox.
type SecretsBroker struct {
	port   int
	server *http.Server

	mu      sync.RWMutex
	configs map[string]*ProviderConfig // provider name -> config

	// Approved domains for custom secrets (loaded from control plane)
	allowlistMu sync.RWMutex
	allowlist   map[string]map[string]*ApprovedDomainConfig // secretName -> domain -> config

	// Callback for notifying owner of pending domain approvals
	// Takes (sessionID, secretName, domain) so we know which session to notify
	onApprovalNeeded func(sessionID, secretName, domain string)
}

// NewSecretsBroker creates a new broker listening on the given port.
func NewSecretsBroker(port int) *SecretsBroker {
	return &SecretsBroker{
		port:      port,
		configs:   make(map[string]*ProviderConfig),
		allowlist: make(map[string]map[string]*ApprovedDomainConfig),
	}
}

// SetConfig adds or updates a provider configuration.
func (b *SecretsBroker) SetConfig(provider string, config *ProviderConfig) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.configs[provider] = config
}

// ClearConfigs removes all provider configurations.
// Call this before re-setting configs to ensure deleted secrets are removed.
func (b *SecretsBroker) ClearConfigs() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.configs = make(map[string]*ProviderConfig)
}

// RemoveConfig removes a specific provider configuration.
// Use this to remove individual secrets without clearing all configs.
func (b *SecretsBroker) RemoveConfig(providerID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.configs, providerID)
}

// SetOnApprovalNeeded sets the callback for domain approval notifications.
// The callback receives (sessionID, secretName, domain) so it knows which session to notify.
func (b *SecretsBroker) SetOnApprovalNeeded(fn func(sessionID, secretName, domain string)) {
	b.onApprovalNeeded = fn
}

// SetAllowlist updates the approved domains for custom secrets.
func (b *SecretsBroker) SetAllowlist(secretName string, domains map[string]*ApprovedDomainConfig) {
	b.allowlistMu.Lock()
	defer b.allowlistMu.Unlock()
	b.allowlist[secretName] = domains
}

// AddApprovedDomain adds a single approved domain for a custom secret.
func (b *SecretsBroker) AddApprovedDomain(secretName, domain string, config *ApprovedDomainConfig) {
	b.allowlistMu.Lock()
	defer b.allowlistMu.Unlock()
	if b.allowlist[secretName] == nil {
		b.allowlist[secretName] = make(map[string]*ApprovedDomainConfig)
	}
	b.allowlist[secretName][domain] = config
}

// ClearApprovedDomains removes all approved domain configurations.
// Call this before re-setting approved domains to ensure revocations take effect.
func (b *SecretsBroker) ClearApprovedDomains() {
	b.allowlistMu.Lock()
	defer b.allowlistMu.Unlock()
	b.allowlist = make(map[string]map[string]*ApprovedDomainConfig)
}

// ServeHTTP handles broker proxy requests.
// URL format: /broker/{provider}/... or /broker/custom/{secretName}?target=...
func (b *SecretsBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Parse the path: /broker/{provider}/path or /broker/custom/{secretName}
	path := strings.TrimPrefix(r.URL.Path, "/broker/")
	parts := strings.SplitN(path, "/", 3)
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, `{"error":"invalid_path","message":"Invalid broker path"}`, http.StatusBadRequest)
		return
	}

	var (
		providerID   string
		targetURL    string
		headerName   string
		headerFormat string
		secretValue  string
	)

	if parts[0] == "custom" && len(parts) >= 2 {
		// Custom secret: /broker/custom/{secretName}?target=https://...
		secretName := parts[1]
		providerID = "custom/" + secretName

		targetURL = r.URL.Query().Get("target")
		if targetURL == "" {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"missing_target","message":"Custom secrets require ?target=https://... parameter"}`, http.StatusBadRequest)
			return
		}

		// Validate target URL
		parsedTarget, err := url.Parse(targetURL)
		if err != nil || parsedTarget.Scheme != "https" {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"invalid_target","message":"Target URL must use HTTPS"}`, http.StatusBadRequest)
			return
		}

		domain := parsedTarget.Host

		// Get secret config first (we need session ID for approval callback)
		b.mu.RLock()
		config, exists := b.configs[providerID]
		b.mu.RUnlock()
		if !exists || config.SecretValue == "" {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, fmt.Sprintf(`{"error":"secret_not_configured","message":"%s not configured","hint":"Add your secret in Environment Variables"}`, secretName), http.StatusNotFound)
			return
		}
		secretValue = config.SecretValue
		sessionID := config.SessionID

		// Check if domain is approved
		allowedConfig := b.getApprovedDomainConfig(secretName, domain)
		if allowedConfig == nil {
			// Domain not approved - return 403 with approval request
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{
				"error":   "domain_approval_required",
				"domain":  domain,
				"secret":  secretName,
				"message": "This domain requires owner approval before the secret can be sent.",
			})
			// Notify owner asynchronously with the session ID from the config
			if b.onApprovalNeeded != nil && sessionID != "" {
				go b.onApprovalNeeded(sessionID, secretName, domain)
			}
			return
		}
		headerName = allowedConfig.HeaderName
		headerFormat = allowedConfig.HeaderFormat

	} else {
		// Built-in provider: /broker/{provider}/path
		providerID = parts[0]
		pathRemainder := ""
		if len(parts) > 1 {
			pathRemainder = "/" + strings.Join(parts[1:], "/")
		}

		b.mu.RLock()
		config, exists := b.configs[providerID]
		b.mu.RUnlock()

		if !exists {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, fmt.Sprintf(`{"error":"provider_not_configured","message":"%s not configured","hint":"Add your API key in Environment Variables"}`, providerID), http.StatusNotFound)
			return
		}

		// Build target URL, stripping any "key" query parameter since the broker
		// injects auth via headers. SDKs (e.g., Google GenAI) may send the
		// placeholder API key as ?key=..., which would cause upstream rejection.
		query := r.URL.Query()
		query.Del("key")
		targetURL = config.TargetBaseURL + pathRemainder
		if encoded := query.Encode(); encoded != "" {
			targetURL += "?" + encoded
		}

		headerName = config.HeaderName
		headerFormat = config.HeaderFormat
		secretValue = config.SecretValue

		// Verify target host matches expected (prevent SSRF)
		if !b.hostAllowed(providerID, targetURL) {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"host_not_allowed","message":"Target host does not match provider configuration"}`, http.StatusForbidden)
			return
		}
	}

	// Create outbound request
	outReq, err := http.NewRequest(r.Method, targetURL, r.Body)
	if err != nil {
		log.Printf("broker: failed to create request: %v", err)
		http.Error(w, `{"error":"request_failed","message":"Failed to create request"}`, http.StatusInternalServerError)
		return
	}

	// Copy headers (except Host and existing auth headers)
	for key, values := range r.Header {
		keyLower := strings.ToLower(key)
		if keyLower == "host" ||
			keyLower == "authorization" ||
			keyLower == "x-api-key" ||
			keyLower == "xi-api-key" ||
			keyLower == "x-goog-api-key" {
			continue
		}
		for _, v := range values {
			outReq.Header.Add(key, v)
		}
	}

	// Inject auth header
	authValue := fmt.Sprintf(headerFormat, secretValue)
	outReq.Header.Set(headerName, authValue)

	// Forward request with timeout
	client := &http.Client{
		Timeout: 120 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Prevent redirects to different domains for security
			if len(via) > 0 {
				originalHost := via[0].URL.Host
				if req.URL.Host != originalHost {
					return fmt.Errorf("redirect to different host blocked")
				}
			}
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			return nil
		},
	}

	resp, err := client.Do(outReq)
	if err != nil {
		log.Printf("broker: request failed for %s: %v", providerID, err)
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, `{"error":"upstream_failed","message":"Request to upstream API failed"}`, http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers (strip any auth headers just in case)
	for key, values := range resp.Header {
		keyLower := strings.ToLower(key)
		if keyLower == "authorization" ||
			keyLower == "x-api-key" ||
			keyLower == "xi-api-key" ||
			keyLower == "x-goog-api-key" {
			continue
		}
		for _, v := range values {
			w.Header().Add(key, v)
		}
	}

	w.WriteHeader(resp.StatusCode)

	// Stream response with flush support for SSE/streaming responses
	if flusher, ok := w.(http.Flusher); ok {
		buf := make([]byte, 32*1024)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				_, _ = w.Write(buf[:n])
				flusher.Flush()
			}
			if readErr != nil {
				break
			}
		}
	} else {
		io.Copy(w, resp.Body)
	}
}

// isLocalhostHTTPAllowed checks if HTTP is allowed for localhost (dev mode only)
func isLocalhostHTTPAllowed() bool {
	return os.Getenv("DEV_MODE") == "true" || os.Getenv("ALLOW_HTTP_BROKER_LOCALHOST") == "true"
}

// isLocalhost checks if a host is localhost
func isLocalhost(host string) bool {
	// Strip port if present
	h := host
	if colonIdx := strings.LastIndex(host, ":"); colonIdx != -1 {
		h = host[:colonIdx]
	}
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// hostAllowed verifies the target URL matches the expected provider host.
// Only HTTPS is allowed to prevent credential leakage over unencrypted connections.
// Exception: HTTP is allowed for localhost when DEV_MODE=true or ALLOW_HTTP_BROKER_LOCALHOST=true.
func (b *SecretsBroker) hostAllowed(providerID string, targetURL string) bool {
	parsed, err := url.Parse(targetURL)
	if err != nil {
		return false
	}

	// Check scheme: HTTPS required, except HTTP allowed for localhost in dev mode
	if parsed.Scheme == "http" {
		if !isLocalhost(parsed.Host) || !isLocalhostHTTPAllowed() {
			return false
		}
	} else if parsed.Scheme != "https" {
		return false
	}

	host := parsed.Host

	b.mu.RLock()
	config, exists := b.configs[providerID]
	b.mu.RUnlock()
	if !exists {
		return false
	}

	// Built-in provider: must match configured target base URL
	expectedParsed, err := url.Parse(config.TargetBaseURL)
	if err != nil {
		return false
	}
	return host == expectedParsed.Host
}

// getApprovedDomainConfig returns the approved config for a custom secret domain.
func (b *SecretsBroker) getApprovedDomainConfig(secretName, domain string) *ApprovedDomainConfig {
	b.allowlistMu.RLock()
	defer b.allowlistMu.RUnlock()

	domains, exists := b.allowlist[secretName]
	if !exists {
		return nil
	}
	return domains[domain]
}

// Start begins listening for broker requests on localhost.
func (b *SecretsBroker) Start() error {
	b.server = &http.Server{
		Addr:         fmt.Sprintf("127.0.0.1:%d", b.port),
		Handler:      b,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 180 * time.Second, // Long timeout for streaming responses
	}

	log.Printf("broker: starting secrets broker on localhost:%d", b.port)
	return b.server.ListenAndServe()
}

// Stop gracefully shuts down the broker.
func (b *SecretsBroker) Stop() error {
	if b.server == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return b.server.Shutdown(ctx)
}

// Port returns the port the broker is configured to listen on.
func (b *SecretsBroker) Port() int {
	return b.port
}
