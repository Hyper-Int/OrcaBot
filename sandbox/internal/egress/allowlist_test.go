// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package egress

import "testing"

func TestMatchGlob(t *testing.T) {
	tests := []struct {
		pattern string
		domain  string
		want    bool
	}{
		// Exact match
		{"example.com", "example.com", true},
		{"example.com", "other.com", false},

		// Wildcard prefix
		{"*.example.com", "sub.example.com", true},
		{"*.example.com", "a.b.example.com", true},
		{"*.example.com", "example.com", false}, // wildcard requires at least one subdomain
		{"*.example.com", "notexample.com", false},

		// Case insensitivity
		{"*.EXAMPLE.COM", "sub.example.com", true},
		{"example.com", "EXAMPLE.COM", true},

		// Real defaults
		{"*.github.com", "raw.githubusercontent.com", false}, // different domain
		{"*.github.com", "api.github.com", true},
		{"*.github.com", "github.com", false},
		{"github.com", "github.com", true},
		{"*.googleapis.com", "storage.googleapis.com", true},
		{"*.googleapis.com", "generativelanguage.googleapis.com", true},
	}

	for _, tt := range tests {
		t.Run(tt.pattern+"_"+tt.domain, func(t *testing.T) {
			got := matchGlob(tt.pattern, tt.domain)
			if got != tt.want {
				t.Errorf("matchGlob(%q, %q) = %v, want %v", tt.pattern, tt.domain, got, tt.want)
			}
		})
	}
}

func TestAllowlist_DefaultDomains(t *testing.T) {
	al := NewAllowlist()

	allowed := []string{
		"registry.npmjs.org",
		"pypi.org",
		"github.com",
		"api.github.com",
		"raw.githubusercontent.com",
		"api.anthropic.com",
		"api.openai.com",
		"storage.googleapis.com",
		"deb.debian.org",
		"cdnjs.cloudflare.com",
		"index.crates.io",
		"repo1.maven.org",
		"plugins.gradle.org",
	}

	for _, domain := range allowed {
		if !al.IsAllowed(domain) {
			t.Errorf("Expected %q to be allowed (default)", domain)
		}
	}

	blocked := []string{
		"evil-site.com",
		"exfiltrate-data.io",
		"random-api.example.com",
		"attacker.dev",
	}

	for _, domain := range blocked {
		if al.IsAllowed(domain) {
			t.Errorf("Expected %q to be blocked", domain)
		}
	}
}

func TestAllowlist_UserDomains(t *testing.T) {
	al := NewAllowlist()

	// Initially blocked
	if al.IsAllowed("custom-api.example.com") {
		t.Error("Expected custom-api.example.com to be blocked initially")
	}

	// Add user domain
	al.AddUserDomain("custom-api.example.com", "entry-1")
	if !al.IsAllowed("custom-api.example.com") {
		t.Error("Expected custom-api.example.com to be allowed after adding")
	}

	// Case insensitive
	if !al.IsAllowed("CUSTOM-API.EXAMPLE.COM") {
		t.Error("Expected case-insensitive match for user domains")
	}

	// List user domains
	domains := al.UserDomains()
	if domains["custom-api.example.com"] != "entry-1" {
		t.Error("Expected user domain to be in list")
	}

	// Remove user domain
	al.RemoveUserDomain("custom-api.example.com")
	if al.IsAllowed("custom-api.example.com") {
		t.Error("Expected custom-api.example.com to be blocked after removal")
	}
}

func TestAllowlist_DeniedDomains(t *testing.T) {
	al := NewAllowlist()

	// Initially not denied
	if al.IsDenied("tracker.example.com") {
		t.Error("Expected tracker.example.com to not be denied initially")
	}

	// Deny always
	al.AddDeniedDomain("tracker.example.com", "deny-1")
	if !al.IsDenied("tracker.example.com") {
		t.Error("Expected tracker.example.com to be denied after AddDeniedDomain")
	}

	// Case insensitive
	if !al.IsDenied("TRACKER.EXAMPLE.COM") {
		t.Error("Expected case-insensitive match for denied domains")
	}

	// Denying a domain clears any prior user-allow entry (deny is unambiguous)
	al.AddUserDomain("dual.example.com", "allow-1")
	al.AddDeniedDomain("dual.example.com", "deny-2")
	if al.IsAllowed("dual.example.com") {
		t.Error("Expected AddDeniedDomain to remove the matching user-allow entry")
	}
	if !al.IsDenied("dual.example.com") {
		t.Error("Expected dual.example.com to be denied")
	}

	// List denied domains
	denied := al.DeniedDomains()
	if denied["tracker.example.com"] != "deny-1" {
		t.Error("Expected denied domain to be in list")
	}

	// Un-deny
	al.RemoveDeniedDomain("tracker.example.com")
	if al.IsDenied("tracker.example.com") {
		t.Error("Expected tracker.example.com to no longer be denied after removal")
	}
}

func TestAllowlist_Trackers(t *testing.T) {
	al := NewAllowlist()

	// Known trackers match.
	for _, tracker := range []string{
		"www.googletagmanager.com",
		"www.google-analytics.com",
		"region1.google-analytics.com", // matches *.google-analytics.com
		"connect.facebook.net",
		"stats.g.doubleclick.net",       // matches *.doubleclick.net
		"www.googleadservices.com",      // ad conversion
		"pagead2.googlesyndication.com", // matches *.googlesyndication.com
		"widget.criteo.com",             // matches *.criteo.com
		"bat.bing.com",                  // bing ads pixel
		"cdn.branch.io",                 // matches *.branch.io (attribution)
		"events.appsflyer.com",          // matches *.appsflyer.com (attribution)
	} {
		if !al.IsTracker(tracker) {
			t.Errorf("Expected %s to be detected as a tracker", tracker)
		}
	}

	// Non-trackers are not flagged.
	for _, ok := range []string{"github.com", "api.anthropic.com", "registry.npmjs.org"} {
		if al.IsTracker(ok) {
			t.Errorf("Did not expect %s to be flagged as a tracker", ok)
		}
	}

	// A tracker is not auto-allowed by the default/user allowlist.
	if al.IsAllowed("www.googletagmanager.com") {
		t.Error("Expected tracker to NOT be in the allowlist by default")
	}

	// Precedence: an explicit user "Always Allow" makes IsAllowed true, which the
	// proxy checks BEFORE IsTracker — so a user can still allow a tracker if they insist.
	al.AddUserDomain("www.googletagmanager.com", "user-1")
	if !al.IsAllowed("www.googletagmanager.com") {
		t.Error("Expected user-approved tracker to be allowed (user allow wins)")
	}
}

func TestAllowlist_DefaultPatterns(t *testing.T) {
	al := NewAllowlist()
	patterns := al.DefaultPatterns()

	if len(patterns) == 0 {
		t.Error("Expected non-empty default patterns")
	}

	// Verify it's a copy
	patterns[0] = "modified"
	origPatterns := al.DefaultPatterns()
	if origPatterns[0] == "modified" {
		t.Error("DefaultPatterns should return a copy")
	}
}

func TestDefaultCatalog_HasUniquePatterns(t *testing.T) {
	patterns := DefaultPatterns()
	if len(patterns) == 0 {
		t.Fatal("expected built-in defaults to be non-empty")
	}

	seen := map[string]bool{}
	for _, pattern := range patterns {
		if seen[pattern] {
			t.Fatalf("duplicate pattern in default catalog: %s", pattern)
		}
		seen[pattern] = true
	}
}

func TestAllowlist_BlockedDefaults(t *testing.T) {
	al := NewAllowlist()

	if !al.IsAllowed("api.openai.com") {
		t.Fatal("expected api.openai.com to be allowed by default")
	}

	al.BlockDefault("*.openai.com")
	if al.IsAllowed("api.openai.com") {
		t.Fatal("expected api.openai.com to require approval after blocking *.openai.com")
	}

	al.UnblockDefault("*.openai.com")
	if !al.IsAllowed("api.openai.com") {
		t.Fatal("expected api.openai.com to be allowed again after unblocking *.openai.com")
	}
}
