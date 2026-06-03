// Copyright 2026 Rob Macrae. All rights reserved.
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

// REVISION: broker-v6-provider-error-toast
const brokerRevision = "broker-v6-provider-error-toast"

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
	SessionID    string // Session that owns this approval (for scoped cleanup)
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

	// Callback for surfacing notable upstream model-provider errors (OpenRouter
	// 429/402/401/5xx) to the user as a dashboard toast. Fire-and-forget.
	onProviderError func(ProviderError)

	// Dedup for the once-per-(session,provider) routing log line.
	loggedRoutes sync.Map
}

// ProviderError describes an upstream model-provider failure worth surfacing to
// the user (vs. silently failing inside the harness).
type ProviderError struct {
	SessionID string
	Provider  string
	Status    int
	Title     string
	Message   string
	Hint      string
}

// NewSecretsBroker creates a new broker listening on the given port.
func NewSecretsBroker(port int) *SecretsBroker {
	return &SecretsBroker{
		port:      port,
		configs:   make(map[string]*ProviderConfig),
		allowlist: make(map[string]map[string]*ApprovedDomainConfig),
	}
}

// ConfigKey builds a session-namespaced key for the config map.
// Format: "{sessionID}:{provider}" — ensures session A's "anthropic" config
// cannot be overwritten by session B's "anthropic" config.
func ConfigKey(sessionID, provider string) string {
	return sessionID + ":" + provider
}

// SetConfig adds or updates a provider configuration.
// The key must be a session-namespaced key from ConfigKey().
func (b *SecretsBroker) SetConfig(key string, config *ProviderConfig) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.configs[key] = config
}

// ClearConfigs removes provider configurations for a specific session.
// Only clears configs whose SessionID matches, preserving other sessions' configs.
// Call this before re-setting configs to ensure deleted secrets are removed.
func (b *SecretsBroker) ClearConfigs() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.configs = make(map[string]*ProviderConfig)
}

// ClearConfigsForSession removes only the provider configurations belonging to
// the given session. This prevents one session's env update from clobbering
// another session's broker configs in multi-session sandboxes.
func (b *SecretsBroker) ClearConfigsForSession(sessionID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for key, config := range b.configs {
		if config.SessionID == sessionID {
			delete(b.configs, key)
		}
	}
}

// RemoveConfig removes a specific provider configuration.
// Use this to remove individual secrets without clearing all configs.
func (b *SecretsBroker) RemoveConfig(providerID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.configs, providerID)
}

// RemoveConfigForSession removes a provider configuration only if it belongs
// to the given session. Prevents one session from removing another's configs.
func (b *SecretsBroker) RemoveConfigForSession(providerID, sessionID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if config, exists := b.configs[providerID]; exists && config.SessionID == sessionID {
		delete(b.configs, providerID)
	}
}

// GetAnthropicKey returns the plaintext Anthropic API key for the given session,
// or "" if not brokered. Intentionally narrow — only returns ANTHROPIC_API_KEY,
// never other secrets. Used exclusively by the Claude apiKeyHelper endpoint.
func (b *SecretsBroker) GetAnthropicKey(sessionID string) string {
	key := ConfigKey(sessionID, "anthropic")
	b.mu.RLock()
	defer b.mu.RUnlock()
	if config, exists := b.configs[key]; exists {
		return config.SecretValue
	}
	return ""
}

// SetOnApprovalNeeded sets the callback for domain approval notifications.
// The callback receives (sessionID, secretName, domain) so it knows which session to notify.
func (b *SecretsBroker) SetOnApprovalNeeded(fn func(sessionID, secretName, domain string)) {
	b.onApprovalNeeded = fn
}

// SetOnProviderError sets the callback used to surface upstream model-provider
// errors (e.g. OpenRouter rate limits) to the user.
func (b *SecretsBroker) SetOnProviderError(fn func(ProviderError)) {
	b.onProviderError = fn
}

// isModelRoutingProvider reports whether the provider routes LLM model traffic
// (OpenRouter, OpenAI-compat or Anthropic-compat). Only these surface toasts —
// we don't want to alert on every TTS/ASR key error.
func isModelRoutingProvider(provider string) bool {
	return provider == "openrouter" || provider == "openrouter-anthropic"
}

// classifyProviderError turns an upstream error response into a user-facing
// title/message/hint. The message is extracted from the OpenRouter/OpenAI error
// envelope when present.
func classifyProviderError(status int, body []byte) (title, message, hint string) {
	var parsed struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &parsed)
	message = parsed.Error.Message

	switch {
	case status == 429:
		// NOT a credit problem — OpenRouter routed to its cheapest provider for
		// this model, whose rate limit is a shared pool across all OpenRouter users.
		// Lead with OpenRouter's verbatim message, then the provider-routing fix.
		title = "Model rate-limited upstream (not a credit issue)"
		hint = "OpenRouter picked its lowest-cost provider for this model; that rate limit is shared across all users, independent of your balance. Fix: set Default Provider Routing to prioritize throughput/performance over price at openrouter.ai/settings, add your own provider key, or pick a better-provisioned model."
		if message == "" {
			message = "The selected model is temporarily rate-limited by its upstream provider."
		}
	case status == 402:
		title = "Out of OpenRouter credits"
		hint = "Add credits at openrouter.ai/credits, then retry."
		if message == "" {
			message = "Your OpenRouter account is out of credits for this model."
		}
	case status == 401 || status == 403:
		title = "OpenRouter key rejected"
		hint = "Check the OPENROUTER_API_KEY in Environment Variables."
		if message == "" {
			message = "OpenRouter rejected the API key for this request."
		}
	case status == 404:
		title = "Model unavailable"
		hint = "This model id may be unavailable on OpenRouter — pick another in the Model panel."
		if message == "" {
			message = "The selected model was not found on OpenRouter."
		}
	case status >= 500:
		title = "Upstream provider error"
		hint = "The provider had a temporary error. Retry, or switch model."
		if message == "" {
			message = "The upstream provider returned a server error."
		}
	default:
		title = "Model request failed"
		hint = "Retry, or switch model in the Model panel."
		if message == "" {
			message = "The model request failed."
		}
	}
	return title, message, hint
}

// AddApprovedDomain adds a single approved domain for a custom secret.
// The allowlist key is session-namespaced (sessionID:secretName) to prevent
// cross-session collisions when two sessions use the same custom secret name.
func (b *SecretsBroker) AddApprovedDomain(sessionID, secretName, domain string, config *ApprovedDomainConfig) {
	b.allowlistMu.Lock()
	defer b.allowlistMu.Unlock()
	key := ConfigKey(sessionID, secretName)
	if b.allowlist[key] == nil {
		b.allowlist[key] = make(map[string]*ApprovedDomainConfig)
	}
	b.allowlist[key][domain] = config
}

// ClearApprovedDomains removes all approved domain configurations.
// Call this before re-setting approved domains to ensure revocations take effect.
func (b *SecretsBroker) ClearApprovedDomains() {
	b.allowlistMu.Lock()
	defer b.allowlistMu.Unlock()
	b.allowlist = make(map[string]map[string]*ApprovedDomainConfig)
}

// ClearApprovedDomainsForSession removes only approved domain configurations
// belonging to the given session. Prevents one session's domain update from
// revoking another session's approvals.
func (b *SecretsBroker) ClearApprovedDomainsForSession(sessionID string) {
	b.allowlistMu.Lock()
	defer b.allowlistMu.Unlock()
	for secretName, domains := range b.allowlist {
		for domain, config := range domains {
			if config.SessionID == sessionID {
				delete(domains, domain)
			}
		}
		// Remove the secretName key if no domains remain
		if len(domains) == 0 {
			delete(b.allowlist, secretName)
		}
	}
}

// ServeHTTP handles broker proxy requests.
// URL format: /broker/{sessionID}/{provider}/... or /broker/{sessionID}/custom/{secretName}?target=...
// The sessionID in the path is used to look up session-namespaced config keys,
// preventing cross-session config collisions in multi-session sandboxes.
func (b *SecretsBroker) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Parse the path: /broker/{sessionID}/{provider}/path or /broker/{sessionID}/custom/{secretName}
	path := strings.TrimPrefix(r.URL.Path, "/broker/")
	parts := strings.SplitN(path, "/", 4)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		http.Error(w, `{"error":"invalid_path","message":"E79326: Invalid broker path — expected /broker/{sessionID}/{provider}/..."}`, http.StatusBadRequest)
		return
	}

	sessionID := parts[0]
	// Remaining parts after sessionID
	providerParts := parts[1:]

	var (
		configKey    string
		targetURL    string
		headerName   string
		headerFormat string
		secretValue  string
		providerName string // built-in provider name; "" for custom secrets
	)

	if providerParts[0] == "custom" && len(providerParts) >= 2 {
		// Custom secret: /broker/{sessionID}/custom/{secretName}?target=https://...
		secretName := providerParts[1]
		configKey = ConfigKey(sessionID, "custom/"+secretName)

		targetURL = r.URL.Query().Get("target")
		if targetURL == "" {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"missing_target","message":"E79327: Custom secrets require ?target=https://... parameter"}`, http.StatusBadRequest)
			return
		}

		// Validate target URL
		parsedTarget, err := url.Parse(targetURL)
		if err != nil || parsedTarget.Scheme != "https" {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"invalid_target","message":"E79328: Target URL must use HTTPS"}`, http.StatusBadRequest)
			return
		}

		domain := parsedTarget.Host

		// Get secret config first (we need session ID for approval callback)
		b.mu.RLock()
		config, exists := b.configs[configKey]
		b.mu.RUnlock()
		if !exists || config.SecretValue == "" {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, fmt.Sprintf(`{"error":"secret_not_configured","message":"E79329: %s not configured","hint":"Add your secret in Environment Variables"}`, secretName), http.StatusNotFound)
			return
		}
		secretValue = config.SecretValue

		// Check if domain is approved (session-scoped lookup)
		allowedConfig := b.getApprovedDomainConfig(sessionID, secretName, domain)
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
			if b.onApprovalNeeded != nil && config.SessionID != "" {
				go b.onApprovalNeeded(config.SessionID, secretName, domain)
			}
			return
		}
		headerName = allowedConfig.HeaderName
		headerFormat = allowedConfig.HeaderFormat

	} else {
		// Built-in provider: /broker/{sessionID}/{provider}/path
		providerName = providerParts[0]
		configKey = ConfigKey(sessionID, providerName)
		pathRemainder := ""
		if len(providerParts) > 1 {
			pathRemainder = "/" + strings.Join(providerParts[1:], "/")
		}

		b.mu.RLock()
		config, exists := b.configs[configKey]
		b.mu.RUnlock()

		if !exists {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, fmt.Sprintf(`{"error":"provider_not_configured","message":"E79330: %s not configured","hint":"Add your API key in Environment Variables"}`, providerName), http.StatusNotFound)
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
		if !b.hostAllowed(configKey, targetURL) {
			w.Header().Set("Content-Type", "application/json")
			http.Error(w, `{"error":"host_not_allowed","message":"E79331: Target host does not match provider configuration"}`, http.StatusForbidden)
			return
		}
	}

	// Create outbound request
	outReq, err := http.NewRequest(r.Method, targetURL, r.Body)
	if err != nil {
		log.Printf("broker: failed to create request: %v", err)
		http.Error(w, `{"error":"request_failed","message":"E79332: Failed to create request"}`, http.StatusInternalServerError)
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

	// Always log the FIRST brokered call per (session, LLM-provider) — the
	// zero-config way to confirm e.g. Claude Code is on `openrouter-anthropic`
	// (OpenRouter) vs `anthropic` (native). Once-per-session so it isn't spammy.
	// Only "agent" (LLM) providers; "tool" providers (TTS/ASR) are skipped.
	if spec, ok := Providers[providerName]; ok && spec.Category == "agent" {
		if _, seen := b.loggedRoutes.LoadOrStore(sessionID+":"+providerName, true); !seen {
			host := targetURL
			if parsed, perr := url.Parse(targetURL); perr == nil {
				host = parsed.Host
			}
			log.Printf("[broker] session=%s routing provider=%s → %s", sessionID, providerName, host)
		}
	}

	// Verbose per-request trace (every call, all providers). No secret is logged
	// (auth lives in headers). Enable with ORCABOT_DEBUG_BROKER=1.
	if os.Getenv("ORCABOT_DEBUG_BROKER") == "1" {
		prov := providerName
		if prov == "" {
			prov = "custom"
		}
		log.Printf("[broker] forward session=%s provider=%s %s %s", sessionID, prov, r.Method, targetURL)
	}

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
		log.Printf("broker: request failed for %s: %v", configKey, err)
		w.Header().Set("Content-Type", "application/json")
		http.Error(w, `{"error":"upstream_failed","message":"E79333: Request to upstream API failed"}`, http.StatusBadGateway)
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

	// Surface notable model-provider errors (OpenRouter 429/402/…) to the user as a
	// toast, then forward the body unchanged. Only error statuses are buffered (they
	// are small JSON, never SSE streams), so streaming success paths are untouched.
	if isModelRoutingProvider(providerName) && resp.StatusCode >= 400 {
		errBody, _ := io.ReadAll(resp.Body)
		if b.onProviderError != nil {
			title, message, hint := classifyProviderError(resp.StatusCode, errBody)
			go b.onProviderError(ProviderError{
				SessionID: sessionID,
				Provider:  providerName,
				Status:    resp.StatusCode,
				Title:     title,
				Message:   message,
				Hint:      hint,
			})
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(errBody)
		return
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
// Uses session-namespaced key to isolate approvals per session.
func (b *SecretsBroker) getApprovedDomainConfig(sessionID, secretName, domain string) *ApprovedDomainConfig {
	b.allowlistMu.RLock()
	defer b.allowlistMu.RUnlock()

	key := ConfigKey(sessionID, secretName)
	domains, exists := b.allowlist[key]
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
