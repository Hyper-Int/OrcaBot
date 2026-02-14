// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package egress

import (
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSplitHostPort(t *testing.T) {
	tests := []struct {
		input       string
		defaultPort int
		wantHost    string
		wantPort    int
	}{
		{"example.com:443", 80, "example.com", 443},
		{"example.com:8080", 80, "example.com", 8080},
		{"example.com", 443, "example.com", 443},
		{"EXAMPLE.COM:443", 80, "example.com", 443},
		{"sub.example.com:443", 80, "sub.example.com", 443},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			host, port := splitHostPort(tt.input, tt.defaultPort)
			if host != tt.wantHost || port != tt.wantPort {
				t.Errorf("splitHostPort(%q, %d) = (%q, %d), want (%q, %d)",
					tt.input, tt.defaultPort, host, port, tt.wantHost, tt.wantPort)
			}
		})
	}
}

func TestExtractHTTPDestination(t *testing.T) {
	req := httptest.NewRequest("GET", "http://registry.npmjs.org/express", nil)
	req.Host = "registry.npmjs.org"

	u, host, port, err := extractHTTPDestination(req)
	if err != nil {
		t.Fatalf("extractHTTPDestination returned error: %v", err)
	}
	if got := u.String(); got != "http://registry.npmjs.org/express" {
		t.Fatalf("unexpected URL: %s", got)
	}
	if host != "registry.npmjs.org" || port != 80 {
		t.Fatalf("unexpected host/port: %s:%d", host, port)
	}
}

func TestExtractHTTPDestination_HostSpoofRejected(t *testing.T) {
	req := httptest.NewRequest("GET", "http://evil.example/path", nil)
	req.Host = "registry.npmjs.org"

	_, _, _, err := extractHTTPDestination(req)
	if err == nil || !strings.Contains(err.Error(), "host mismatch") {
		t.Fatalf("expected host mismatch error, got: %v", err)
	}
}

func TestProxy_Resolve(t *testing.T) {
	al := NewAllowlist()
	proxy := NewEgressProxy(0, al)

	// Simulate a pending approval
	pending := &Pending{
		Domain:    "unknown-api.com",
		Port:      443,
		RequestID: "test-req-1",
		doneCh:    make(chan struct{}),
		CreatedAt: time.Now(),
		Waiters:   1,
	}
	proxy.pendingByID["test-req-1"] = pending
	proxy.pendingByDomain["unknown-api.com"] = pending

	// Resolve with allow_always
	resolved := proxy.Resolve("test-req-1", "unknown-api.com", DecisionAllowAlways)
	if !resolved {
		t.Error("Expected Resolve to return true for pending domain")
	}

	// The domain should now be in the allowlist
	if !al.IsAllowed("unknown-api.com") {
		t.Error("Expected domain to be in allowlist after allow_always")
	}

	// Resolve non-existent domain
	resolved = proxy.Resolve("not-pending", "not-pending.com", DecisionDeny)
	if resolved {
		t.Error("Expected Resolve to return false for non-pending domain")
	}
}

func TestProxy_ResolveAllowOnce(t *testing.T) {
	al := NewAllowlist()
	proxy := NewEgressProxy(0, al)

	pending := &Pending{
		Domain:    "once-api.com",
		Port:      443,
		RequestID: "test-req-2",
		doneCh:    make(chan struct{}),
		CreatedAt: time.Now(),
		Waiters:   1,
	}
	proxy.pendingByID["test-req-2"] = pending
	proxy.pendingByDomain["once-api.com"] = pending

	proxy.Resolve("test-req-2", "once-api.com", DecisionAllowOnce)

	// allow_once should NOT add to allowlist
	if al.IsAllowed("once-api.com") {
		t.Error("Expected allow_once to NOT add domain to allowlist")
	}
}

func TestProxy_PendingApprovals(t *testing.T) {
	al := NewAllowlist()
	proxy := NewEgressProxy(0, al)

	// Empty initially
	pending := proxy.PendingApprovals()
	if len(pending) != 0 {
		t.Errorf("Expected 0 pending, got %d", len(pending))
	}

	// Add some pending entries
	proxy.pendingByID["r1"] = &Pending{
		Domain:    "a.com",
		Port:      443,
		RequestID: "r1",
		doneCh:    make(chan struct{}),
		CreatedAt: time.Now(),
		Waiters:   1,
	}
	proxy.pendingByID["r2"] = &Pending{
		Domain:    "b.com",
		Port:      80,
		RequestID: "r2",
		doneCh:    make(chan struct{}),
		CreatedAt: time.Now(),
		Waiters:   2,
	}
	proxy.pendingByDomain["a.com"] = proxy.pendingByID["r1"]
	proxy.pendingByDomain["b.com"] = proxy.pendingByID["r2"]

	pending = proxy.PendingApprovals()
	if len(pending) != 2 {
		t.Errorf("Expected 2 pending, got %d", len(pending))
	}
}

func TestProxy_Coalescing(t *testing.T) {
	al := NewAllowlist()
	proxy := NewEgressProxy(0, al)

	var callbackCount atomic.Int32
	proxy.SetApprovalCallback(func(req ApprovalRequest) {
		callbackCount.Add(1)
	})

	// Simulate multiple goroutines requesting the same domain
	var wg sync.WaitGroup
	decisions := make([]string, 3)

	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			decisions[idx] = proxy.holdForApproval("coalesce-test.com", 443)
		}(i)
	}

	// Give goroutines time to start
	time.Sleep(100 * time.Millisecond)

	// Only one callback should have fired
	if got := callbackCount.Load(); got != 1 {
		t.Errorf("Expected 1 callback, got %d", got)
	}

	// Check waiters count
	proxy.pendingMu.Lock()
	p := proxy.pendingByDomain["coalesce-test.com"]
	if p != nil && p.Waiters != 3 {
		t.Errorf("Expected 3 waiters, got %d", p.Waiters)
	}
	proxy.pendingMu.Unlock()

	// Resolve
	requestID := ""
	proxy.pendingMu.Lock()
	if p != nil {
		requestID = p.RequestID
	}
	proxy.pendingMu.Unlock()
	if requestID == "" {
		t.Fatal("expected request ID for coalesced pending entry")
	}
	proxy.Resolve(requestID, "coalesce-test.com", DecisionAllowOnce)

	wg.Wait()

	// All should have received allow_once
	for i, d := range decisions {
		if d != DecisionAllowOnce {
			t.Errorf("Decision[%d] = %q, want %q", i, d, DecisionAllowOnce)
		}
	}
}

func TestProxy_Stop(t *testing.T) {
	al := NewAllowlist()
	proxy := NewEgressProxy(0, al)

	// Add pending entry
	pending := &Pending{
		Domain:    "stop-test.com",
		Port:      443,
		RequestID: "stop-req",
		doneCh:    make(chan struct{}),
		CreatedAt: time.Now(),
		Waiters:   1,
	}
	proxy.pendingByID["stop-req"] = pending
	proxy.pendingByDomain["stop-test.com"] = pending

	// Stop should close all pending channels
	proxy.Stop()

	// Pending should be cleared
	if len(proxy.pendingByID) != 0 || len(proxy.pendingByDomain) != 0 {
		t.Errorf("Expected 0 pending after stop, got ids=%d domains=%d", len(proxy.pendingByID), len(proxy.pendingByDomain))
	}
}

func TestProxy_CaseInsensitive(t *testing.T) {
	al := NewAllowlist()
	proxy := NewEgressProxy(0, al)

	pending := &Pending{
		Domain:    "mixed-case.com",
		Port:      443,
		RequestID: "case-req",
		doneCh:    make(chan struct{}),
		CreatedAt: time.Now(),
		Waiters:   1,
	}
	proxy.pendingByID["case-req"] = pending
	proxy.pendingByDomain["mixed-case.com"] = pending

	// Resolve with different case
	resolved := proxy.Resolve("case-req", "MIXED-CASE.COM", DecisionAllowAlways)
	if !resolved {
		t.Error("Expected case-insensitive resolve")
	}
}
