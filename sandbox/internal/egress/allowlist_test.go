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
