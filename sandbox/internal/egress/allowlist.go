// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-allowlist-v3-chatgpt-localhost-bypass

package egress

import (
	"log"
	"strings"
	"sync"
	"time"
)

const allowlistRevision = "egress-allowlist-v3-chatgpt-localhost-bypass"

func init() {
	log.Printf("[egress-allowlist] REVISION: %s loaded at %s", allowlistRevision, time.Now().Format(time.RFC3339))
}

// Allowlist manages a thread-safe set of allowed domains with glob matching.
// Default domains (package registries, git hosting, CDNs, LLM APIs) are always allowed.
// User-approved domains can be added at runtime.
type Allowlist struct {
	mu       sync.RWMutex
	defaults []string          // glob patterns (e.g., "*.github.com")
	user     map[string]string // domain -> entryID (for revocation tracking)
}

// defaultDomains are always allowed without user approval.
var defaultDomains = []string{
	// Package registries
	"registry.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"rubygems.org",
	"proxy.golang.org",
	"sum.golang.org",
	"crates.io",
	"static.crates.io",
	"index.crates.io",
	"registry.yarnpkg.com",
	"repo.maven.apache.org",
	"repo1.maven.org",
	"plugins.gradle.org",
	"services.gradle.org",
	"*.gradle.org",
	"central.sonatype.com",

	// Git hosting
	"github.com",
	"*.github.com",
	"*.githubusercontent.com",
	"gitlab.com",
	"*.gitlab.com",
	"bitbucket.org",
	"*.bitbucket.org",

	// System packages
	"deb.debian.org",
	"*.debian.org",
	"security.debian.org",
	"archive.ubuntu.com",
	"*.ubuntu.com",
	"dl-cdn.alpinelinux.org",

	// CDNs
	"*.cloudflare.com",
	"*.cloudfront.net",
	"*.fastly.net",
	"*.jsdelivr.net",
	"*.unpkg.com",
	"cdnjs.cloudflare.com",

	// LLM APIs (already brokered, but allow direct too)
	"api.anthropic.com",
	"claude.ai",
	"*.claude.ai",
	"platform.claude.com",
	"api.openai.com",
	"chatgpt.com",
	"*.chatgpt.com",
	"*.googleapis.com",
	"generativelanguage.googleapis.com",
	"api.groq.com",
	"api.together.xyz",
	"api.fireworks.ai",
	"api.mistral.ai",
	"api.cohere.com",
	"api-inference.huggingface.co",

	// TTS providers
	"api.elevenlabs.io",
	"api.deepgram.com",

	// Telemetry / monitoring (used by agents like Claude Code)
	"*.datadoghq.com",
	"*.datadoghq.eu",
	"*.sentry.io",

	// Common dev tools
	"nodejs.org",
	"*.nodejs.org",
	"dl.google.com",
	"storage.googleapis.com",
	"objects.githubusercontent.com",
}

// NewAllowlist creates an Allowlist with default domains.
func NewAllowlist() *Allowlist {
	return &Allowlist{
		defaults: append([]string{}, defaultDomains...),
		user:     make(map[string]string),
	}
}

// IsAllowed checks if a domain is permitted by the default or user allowlist.
func (a *Allowlist) IsAllowed(domain string) bool {
	domain = strings.ToLower(domain)

	a.mu.RLock()
	defer a.mu.RUnlock()

	// Check defaults (glob patterns)
	for _, pattern := range a.defaults {
		if matchGlob(pattern, domain) {
			return true
		}
	}

	// Check user-approved domains (exact match)
	if _, ok := a.user[domain]; ok {
		return true
	}

	return false
}

// AddUserDomain adds a user-approved domain to the allowlist.
func (a *Allowlist) AddUserDomain(domain, entryID string) {
	domain = strings.ToLower(domain)

	a.mu.Lock()
	defer a.mu.Unlock()

	a.user[domain] = entryID
}

// RemoveUserDomain removes a user-approved domain from the allowlist.
func (a *Allowlist) RemoveUserDomain(domain string) {
	domain = strings.ToLower(domain)

	a.mu.Lock()
	defer a.mu.Unlock()

	delete(a.user, domain)
}

// UserDomains returns a copy of all user-approved domains.
func (a *Allowlist) UserDomains() map[string]string {
	a.mu.RLock()
	defer a.mu.RUnlock()

	result := make(map[string]string, len(a.user))
	for k, v := range a.user {
		result[k] = v
	}
	return result
}

// DefaultPatterns returns a copy of the default glob patterns.
func (a *Allowlist) DefaultPatterns() []string {
	a.mu.RLock()
	defer a.mu.RUnlock()

	result := make([]string, len(a.defaults))
	copy(result, a.defaults)
	return result
}

// matchGlob matches a domain against a glob pattern.
// Supported syntax:
//   - "*.example.com" matches "sub.example.com" and "a.b.example.com" but NOT "example.com"
//   - "example.com" matches only "example.com" (exact match)
func matchGlob(pattern, domain string) bool {
	pattern = strings.ToLower(pattern)
	domain = strings.ToLower(domain)

	if pattern == domain {
		return true
	}

	// Handle wildcard prefix: "*.example.com"
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[1:] // ".example.com"
		// domain must end with the suffix AND have at least one char before it
		return strings.HasSuffix(domain, suffix) && len(domain) > len(suffix)
	}

	return false
}
