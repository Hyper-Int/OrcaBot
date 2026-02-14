// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-proxy-v5-localhost-bypass

package egress

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
)

const proxyRevision = "egress-proxy-v5-localhost-bypass"

func init() {
	log.Printf("[egress-proxy] REVISION: %s loaded at %s", proxyRevision, time.Now().Format(time.RFC3339))
}

const (
	// ApprovalTimeout is how long to wait for user approval before denying.
	ApprovalTimeout = 60 * time.Second

	// DefaultPort is the default proxy listen port.
	DefaultPort = 8083
)

// Decision values for approval responses.
const (
	DecisionAllowOnce   = "allow_once"
	DecisionAllowAlways = "allow_always"
	DecisionDeny        = "deny"
	DecisionTimeout     = "timeout"
	DecisionDefault     = "default_allowed"
)

// ApprovalRequest is sent when a connection to an unknown domain is held.
type ApprovalRequest struct {
	Domain    string `json:"domain"`
	Port      int    `json:"port"`
	RequestID string `json:"request_id"`
}

// ApprovalResolution is sent when a held connection is resolved (approve/deny/timeout).
type ApprovalResolution struct {
	Domain    string `json:"domain"`
	Port      int    `json:"port"`
	RequestID string `json:"request_id"`
	Decision  string `json:"decision"`
}

// AuditEvent is emitted for runtime egress decisions to support audit logging.
type AuditEvent struct {
	Domain    string `json:"domain"`
	Port      int    `json:"port"`
	RequestID string `json:"request_id,omitempty"`
	Decision  string `json:"decision"`
}

// Pending represents a held connection waiting for user approval.
type Pending struct {
	Domain    string
	Port      int
	RequestID string
	decision  string        // set before closing doneCh
	doneCh    chan struct{} // closed when decision is made
	CreatedAt time.Time
	Waiters   int // coalesced concurrent connections
}

// EgressProxy is an HTTP/HTTPS forward proxy that checks domains against
// an allowlist and holds unknown connections until the user approves.
type EgressProxy struct {
	port             int
	listener         net.Listener
	server           *http.Server
	allowlist        *Allowlist
	pendingByID      map[string]*Pending // requestID -> pending approval
	pendingByDomain  map[string]*Pending // domain -> pending approval
	pendingMu        sync.Mutex
	onApprovalNeeded func(req ApprovalRequest) // callback to broadcast WS event
	onResolved       func(res ApprovalResolution)
	onAuditEvent     func(event AuditEvent)
	auditCh          chan AuditEvent      // buffered channel for async audit delivery
	transport        *http.Transport      // shared transport for plain HTTP forwarding
	stopCh           chan struct{}
}

const auditChannelSize = 256

// NewEgressProxy creates a new egress proxy.
func NewEgressProxy(port int, allowlist *Allowlist) *EgressProxy {
	return &EgressProxy{
		port:            port,
		allowlist:       allowlist,
		pendingByID:     make(map[string]*Pending),
		pendingByDomain: make(map[string]*Pending),
		auditCh:         make(chan AuditEvent, auditChannelSize),
		transport:       &http.Transport{},
		stopCh:          make(chan struct{}),
	}
}

// Allowlist returns the proxy's allowlist for inspection.
func (p *EgressProxy) Allowlist() *Allowlist {
	return p.allowlist
}

// SetApprovalCallback sets the function called when a connection needs user approval.
func (p *EgressProxy) SetApprovalCallback(fn func(req ApprovalRequest)) {
	p.onApprovalNeeded = fn
}

// SetResolutionCallback sets the function called when an approval is resolved.
func (p *EgressProxy) SetResolutionCallback(fn func(res ApprovalResolution)) {
	p.onResolved = fn
}

// SetAuditCallback sets the function called when an egress decision should be audited.
func (p *EgressProxy) SetAuditCallback(fn func(event AuditEvent)) {
	p.onAuditEvent = fn
}

// Start begins listening and serving proxy requests.
func (p *EgressProxy) Start() error {
	addr := fmt.Sprintf("127.0.0.1:%d", p.port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("egress proxy listen: %w", err)
	}
	p.listener = ln

	p.server = &http.Server{
		Handler: p,
	}

	go func() {
		log.Printf("[egress-proxy] Listening on %s", addr)
		if err := p.server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("[egress-proxy] Server error: %v", err)
		}
	}()

	// Background goroutine drains audit events so emitAudit never blocks
	// the request path. Events are dropped if the channel is full.
	go p.drainAuditEvents()

	return nil
}

// Stop resolves all pending approvals as denied and shuts down the proxy.
func (p *EgressProxy) Stop() {
	close(p.stopCh)

	// Deny all pending approvals
	p.pendingMu.Lock()
	for requestID, pending := range p.pendingByID {
		log.Printf("[egress-proxy] Shutdown: denying pending approval for %s", pending.Domain)
		pending.decision = DecisionDeny
		close(pending.doneCh) // unblocks all waiters
		delete(p.pendingByID, requestID)
		delete(p.pendingByDomain, pending.Domain)
	}
	p.pendingMu.Unlock()

	if p.server != nil {
		p.server.Close()
	}
	if p.transport != nil {
		p.transport.CloseIdleConnections()
	}
}

// Resolve delivers a user decision for a pending approval by request ID.
func (p *EgressProxy) Resolve(requestID, domain, decision string) bool {
	requestID = strings.TrimSpace(requestID)
	domain = strings.ToLower(domain)

	p.pendingMu.Lock()
	pending, ok := p.pendingByID[requestID]
	if !ok {
		p.pendingMu.Unlock()
		return false
	}
	if domain != "" && domain != pending.Domain {
		// Domain mismatch indicates stale/malformed client state.
		p.pendingMu.Unlock()
		return false
	}
	delete(p.pendingByID, requestID)
	delete(p.pendingByDomain, pending.Domain)
	p.pendingMu.Unlock()

	// If always allow, add to allowlist
	if decision == DecisionAllowAlways {
		p.allowlist.AddUserDomain(pending.Domain, "runtime-"+pending.RequestID)
	}

	// Broadcast decision to all waiting goroutines
	pending.decision = decision
	close(pending.doneCh) // all waiters will read pending.decision
	p.emitResolution(pending, decision)
	// Note: no emitAudit here — user decisions (allow_once/always/deny) are logged
	// by the control plane approve endpoint. Only default_allowed and timeout are
	// forwarded via the audit channel.

	log.Printf("[egress-proxy] Resolved %s (request_id=%s): %s (waiters: %d)", pending.Domain, pending.RequestID, decision, pending.Waiters)
	return true
}

// PendingApprovals returns a list of currently pending domain approvals.
func (p *EgressProxy) PendingApprovals() []ApprovalRequest {
	p.pendingMu.Lock()
	defer p.pendingMu.Unlock()

	result := make([]ApprovalRequest, 0, len(p.pendingByID))
	for _, pending := range p.pendingByID {
		result = append(result, ApprovalRequest{
			Domain:    pending.Domain,
			Port:      pending.Port,
			RequestID: pending.RequestID,
		})
	}
	return result
}

// ServeHTTP handles proxy requests: CONNECT for HTTPS, regular for HTTP.
func (p *EgressProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.handleConnect(w, r)
	} else {
		p.handleHTTP(w, r)
	}
}

// isLocalhost returns true for loopback addresses that should always bypass the proxy.
func isLocalhost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// handleConnect handles HTTPS CONNECT tunneling.
func (p *EgressProxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	host, port := splitHostPort(r.Host, 443)

	// Localhost always bypasses — never hold or prompt for loopback traffic.
	if isLocalhost(host) {
		p.tunnelConnect(w, host, port)
		return
	}

	if p.allowlist.IsAllowed(host) {
		p.emitAudit(host, port, "", DecisionDefault)
		p.tunnelConnect(w, host, port)
		return
	}

	// Hold the connection and wait for approval
	decision := p.holdForApproval(host, port)

	switch decision {
	case DecisionAllowOnce, DecisionAllowAlways:
		p.tunnelConnect(w, host, port)
	default:
		// Deny: send 403 and close
		http.Error(w, "Egress denied: domain not approved", http.StatusForbidden)
	}
}

// handleHTTP handles plain HTTP proxy requests.
func (p *EgressProxy) handleHTTP(w http.ResponseWriter, r *http.Request) {
	targetURL, host, port, err := extractHTTPDestination(r)
	if err != nil {
		http.Error(w, "Bad proxy request", http.StatusBadRequest)
		return
	}

	// Localhost always bypasses — never hold or prompt for loopback traffic.
	if isLocalhost(host) {
		// fall through to forward
	} else if !p.allowlist.IsAllowed(host) {
		decision := p.holdForApproval(host, port)
		if decision != DecisionAllowOnce && decision != DecisionAllowAlways {
			http.Error(w, "Egress denied: domain not approved", http.StatusForbidden)
			return
		}
	} else {
		p.emitAudit(host, port, "", DecisionDefault)
	}

	// Forward the request
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL.String(), r.Body)
	if err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	outReq.Header = r.Header.Clone()
	// Remove hop-by-hop headers
	outReq.Header.Del("Proxy-Connection")
	outReq.Header.Del("Proxy-Authorization")

	resp, err := p.transport.RoundTrip(outReq)
	if err != nil {
		http.Error(w, "Upstream error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// holdForApproval blocks the current goroutine until the user approves/denies
// or the timeout expires. Multiple connections to the same domain coalesce.
func (p *EgressProxy) holdForApproval(domain string, port int) string {
	domain = strings.ToLower(domain)

	p.pendingMu.Lock()
	if existing, ok := p.pendingByDomain[domain]; ok {
		// Coalesce: another connection to the same domain is already pending
		existing.Waiters++
		p.pendingMu.Unlock()

		return p.waitForDecision(existing)
	}

	// Create new pending entry
	requestID, err := id.New()
	if err != nil {
		requestID = fmt.Sprintf("fallback-%d", time.Now().UnixNano())
	}

	pending := &Pending{
		Domain:    domain,
		Port:      port,
		RequestID: requestID,
		doneCh:    make(chan struct{}),
		CreatedAt: time.Now(),
		Waiters:   1,
	}
	p.pendingByID[requestID] = pending
	p.pendingByDomain[domain] = pending
	p.pendingMu.Unlock()

	// Start timeout goroutine that cleans up the pending entry.
	// This ensures timed-out entries don't stay in the map and block future connections.
	go func() {
		timer := time.NewTimer(ApprovalTimeout)
		defer timer.Stop()
		select {
		case <-pending.doneCh:
			// Resolved by user or shutdown — nothing to clean up
		case <-timer.C:
			var timedOut bool
			p.pendingMu.Lock()
			// Only clean up if this is still the same pending entry (not replaced)
			if current, ok := p.pendingByID[pending.RequestID]; ok && current == pending {
				delete(p.pendingByID, pending.RequestID)
				delete(p.pendingByDomain, pending.Domain)
				pending.decision = DecisionTimeout
				close(pending.doneCh)
				timedOut = true
			}
			p.pendingMu.Unlock()
			// Emit callbacks outside the lock to avoid blocking pending operations
			// on slow HTTP calls (forwardEgressAudit has a 5s timeout).
			if timedOut {
				p.emitResolution(pending, DecisionTimeout)
				p.emitAudit(pending.Domain, pending.Port, pending.RequestID, DecisionTimeout)
				log.Printf("[egress-proxy] Timeout: auto-denied %s (request_id=%s) and cleaned up pending entry", domain, pending.RequestID)
			}
		case <-p.stopCh:
			// Proxy shutting down — Stop() handles cleanup
		}
	}()

	// Notify frontend
	if p.onApprovalNeeded != nil {
		p.onApprovalNeeded(ApprovalRequest{
			Domain:    domain,
			Port:      port,
			RequestID: requestID,
		})
	}

	log.Printf("[egress-proxy] Holding connection to %s:%d (request_id=%s)", domain, port, requestID)

	return p.waitForDecision(pending)
}

// waitForDecision blocks until a decision arrives or the proxy stops.
// The timeout goroutine in holdForApproval handles expiry by closing doneCh.
func (p *EgressProxy) waitForDecision(pending *Pending) string {
	select {
	case <-pending.doneCh:
		if pending.decision == "" {
			return DecisionDeny
		}
		return pending.decision
	case <-p.stopCh:
		return DecisionDeny
	}
}

// tunnelConnect establishes a TCP tunnel for CONNECT requests.
func (p *EgressProxy) tunnelConnect(w http.ResponseWriter, host string, port int) {
	target := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	upstream, err := net.DialTimeout("tcp", target, 10*time.Second)
	if err != nil {
		http.Error(w, "Cannot connect to upstream", http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	// Hijack the client connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return
	}

	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, "Hijack failed", http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	// Send 200 Connection Established
	clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))

	// Bidirectional relay
	done := make(chan struct{}, 2)
	go func() {
		io.Copy(upstream, clientConn)
		done <- struct{}{}
	}()
	go func() {
		io.Copy(clientConn, upstream)
		done <- struct{}{}
	}()
	<-done
}

// splitHostPort extracts host and port from a host:port string.
// If no port is specified, defaultPort is used.
func splitHostPort(hostport string, defaultPort int) (string, int) {
	host, portStr, err := net.SplitHostPort(hostport)
	if err != nil {
		// No port specified
		return strings.ToLower(hostport), defaultPort
	}
	port := defaultPort
	if portStr != "" {
		fmt.Sscanf(portStr, "%d", &port)
	}
	return strings.ToLower(host), port
}

func (p *EgressProxy) emitResolution(pending *Pending, decision string) {
	if p.onResolved == nil || pending == nil {
		return
	}
	p.onResolved(ApprovalResolution{
		Domain:    pending.Domain,
		Port:      pending.Port,
		RequestID: pending.RequestID,
		Decision:  decision,
	})
}

// emitAudit enqueues an audit event for async delivery. Never blocks the caller;
// drops the event if the channel is full (audit is best-effort telemetry).
// Only runtime-only decisions (default_allowed, timeout) are enqueued; user
// decisions (allow_once/always/deny) are logged by the control plane approve
// endpoint and are filtered out here to avoid wasting channel capacity.
func (p *EgressProxy) emitAudit(domain string, port int, requestID string, decision string) {
	if decision != DecisionDefault && decision != DecisionTimeout {
		return
	}
	event := AuditEvent{
		Domain:    strings.ToLower(domain),
		Port:      port,
		RequestID: requestID,
		Decision:  decision,
	}
	select {
	case p.auditCh <- event:
	default:
		// Channel full — drop this event rather than block a proxy request.
	}
}

// drainAuditEvents runs in a background goroutine, delivering queued audit
// events to the callback. Exits when stopCh is closed and the channel is drained.
func (p *EgressProxy) drainAuditEvents() {
	for {
		select {
		case event := <-p.auditCh:
			if p.onAuditEvent != nil {
				p.onAuditEvent(event)
			}
		case <-p.stopCh:
			// Drain remaining events before exiting.
			for {
				select {
				case event := <-p.auditCh:
					if p.onAuditEvent != nil {
						p.onAuditEvent(event)
					}
				default:
					return
				}
			}
		}
	}
}

func extractHTTPDestination(r *http.Request) (*url.URL, string, int, error) {
	if r == nil || r.URL == nil {
		return nil, "", 0, fmt.Errorf("missing URL")
	}

	targetURL := r.URL
	if !targetURL.IsAbs() {
		// Some clients send origin-form requests through a proxy.
		host, port := splitHostPort(r.Host, 80)
		if host == "" {
			return nil, "", 0, fmt.Errorf("missing host")
		}
		hostPort := host
		if port != 80 {
			hostPort = net.JoinHostPort(host, strconv.Itoa(port))
		}
		targetURL = &url.URL{
			Scheme:   "http",
			Host:     hostPort,
			Path:     r.URL.Path,
			RawPath:  r.URL.RawPath,
			RawQuery: r.URL.RawQuery,
		}
	}

	targetHost := strings.ToLower(targetURL.Hostname())
	if targetHost == "" {
		return nil, "", 0, fmt.Errorf("missing target host")
	}

	targetPort := 80
	if rawPort := targetURL.Port(); rawPort != "" {
		parsedPort, err := strconv.Atoi(rawPort)
		if err != nil || parsedPort <= 0 || parsedPort > 65535 {
			return nil, "", 0, fmt.Errorf("invalid target port")
		}
		targetPort = parsedPort
	}

	if r.Host != "" {
		claimedHost, _ := splitHostPort(r.Host, targetPort)
		if claimedHost != "" && claimedHost != targetHost {
			return nil, "", 0, fmt.Errorf("host mismatch")
		}
	}

	return targetURL, targetHost, targetPort, nil
}
