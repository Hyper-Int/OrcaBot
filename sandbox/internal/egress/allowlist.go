// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-allowlist-v5-expanded-defaults

package egress

import (
	"log"
	"strings"
	"sync"
	"time"
)

const allowlistRevision = "egress-allowlist-v5-expanded-defaults"

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
	"anthropic.com",
	"*.anthropic.com",
	"claude.ai",
	"*.claude.ai",
	"claude.com",
	"*.claude.com",
	"openai.com",
	"*.openai.com",
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

	// Cloud metadata & auth
	"metadata.google.internal",
	"auth-cdn.oaistatic.com",
	"*.oaistatic.com",
	"featureassets.org",     // LaunchDarkly feature flag CDN (used by OpenAI and others)
	"*.featureassets.org",
	"prodregistryv2.org",   // OpenAI production registry
	"*.prodregistryv2.org",
	"cloudflare-dns.com",   // Cloudflare DNS-over-HTTPS (DoH)
	"*.cloudflare-dns.com",
	"statsigapi.net",       // Statsig feature flags / experimentation (used by OpenAI and others)
	"*.statsigapi.net",
	"browser-intake-datadoghq.com",  // Datadog browser RUM intake (already have *.datadoghq.com but this is a separate domain)
	"*.browser-intake-datadoghq.com",
	"intercom.io",          // Intercom support widget
	"*.intercom.io",
	"intercomcdn.com",      // Intercom CDN
	"*.intercomcdn.com",

	// Google auth / OAuth (distinct from *.googleapis.com)
	// accounts.google.com is the OAuth sign-in page; *.gstatic.com serves static
	// assets loaded during the auth flow. Both are needed for browser-based OAuth.
	"accounts.google.com",
	"google.com",
	"*.google.com",
	"*.gstatic.com",

	// Docker registries
	"registry-1.docker.io",
	"auth.docker.io",
	"*.docker.com",
	"ghcr.io",
	"*.ghcr.io",
	"gcr.io",
	"*.gcr.io",
	"pkg.dev",
	"*.pkg.dev",

	// Rust toolchain
	"sh.rustup.rs",
	"static.rust-lang.org",

	// Additional package managers
	"pnpm.io",
	"*.pnpm.io",
	"install.python-poetry.org",
	"python-poetry.org",
	"get.deno.land",
	"dl.deno.land",
	"bun.sh",

	// HuggingFace (top-level domain missing; only inference API was listed)
	"huggingface.co",
	"*.huggingface.co",
	"*.hf.co",

	// HashiCorp / Terraform
	"releases.hashicorp.com",
	"registry.terraform.io",
	"checkpoint-api.hashicorp.com",

	// Microsoft / Azure OAuth and APIs
	"login.microsoftonline.com",
	"*.microsoft.com",
	"*.azure.com",
	"*.azureedge.net",
	"*.windows.net",

	// Supported dashboard integrations with credentialed API access.
	// These remain a conscious user risk because successful use still requires
	// provider credentials or an attached integration; the allowlist only removes
	// the network approval prompt for the provider's first-party domains.
	"slack.com",
	"*.slack.com",
	"discord.com",
	"*.discord.com",
	"api.telegram.org",
	"graph.facebook.com",
	"api.box.com",
	"account.box.com",
	"*.box.com",
	"api.twitter.com",
	"x.com",
	"*.x.com",
	"developer.x.com",
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
