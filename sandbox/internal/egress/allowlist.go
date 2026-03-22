// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-allowlist-v7-canonical-default-catalog

package egress

import (
	_ "embed"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"
)

const allowlistRevision = "egress-allowlist-v7-canonical-default-catalog"

func init() {
	log.Printf("[egress-allowlist] REVISION: %s loaded at %s", allowlistRevision, time.Now().Format(time.RFC3339))
}

// Allowlist manages a thread-safe set of allowed domains with glob matching.
// Default domains (package registries, git hosting, CDNs, LLM APIs) are always allowed.
// User-approved domains can be added at runtime.
type Allowlist struct {
	mu       sync.RWMutex
	defaults []string          // glob patterns (e.g., "*.github.com")
	blocked  map[string]bool   // blocked default patterns -> true
	user     map[string]string // domain -> entryID (for revocation tracking)
}

type DefaultCatalog struct {
	Revision string                `json:"revision"`
	Defaults []DefaultCatalogEntry `json:"defaults"`
}

type DefaultCatalogEntry struct {
	Pattern   string `json:"pattern"`
	Category  string `json:"category"`
	Label     string `json:"label"`
	Rationale string `json:"rationale"`
}

//go:embed defaults.json
var defaultCatalogJSON []byte

var defaultCatalog = mustLoadDefaultCatalog()

func mustLoadDefaultCatalog() DefaultCatalog {
	var catalog DefaultCatalog
	if err := json.Unmarshal(defaultCatalogJSON, &catalog); err != nil {
		panic("egress defaults catalog invalid: " + err.Error())
	}

	seen := make(map[string]bool, len(catalog.Defaults))
	filtered := make([]DefaultCatalogEntry, 0, len(catalog.Defaults))
	for _, entry := range catalog.Defaults {
		pattern := strings.TrimSpace(strings.ToLower(entry.Pattern))
		if pattern == "" {
			panic("egress defaults catalog contains empty pattern")
		}
		if seen[pattern] {
			panic("egress defaults catalog contains duplicate pattern: " + pattern)
		}
		seen[pattern] = true
		entry.Pattern = pattern
		filtered = append(filtered, entry)
	}
	catalog.Defaults = filtered
	return catalog
}

func DefaultCatalogRevision() string {
	return defaultCatalog.Revision
}

func DefaultCatalogEntries() []DefaultCatalogEntry {
	result := make([]DefaultCatalogEntry, len(defaultCatalog.Defaults))
	copy(result, defaultCatalog.Defaults)
	return result
}

func DefaultPatterns() []string {
	result := make([]string, 0, len(defaultCatalog.Defaults))
	for _, entry := range defaultCatalog.Defaults {
		result = append(result, entry.Pattern)
	}
	return result
}

// NewAllowlist creates an Allowlist with default domains.
func NewAllowlist() *Allowlist {
	return &Allowlist{
		defaults: DefaultPatterns(),
		blocked:  make(map[string]bool),
		user:     make(map[string]string),
	}
}

// IsAllowed checks if a domain is permitted by the default or user allowlist.
func (a *Allowlist) IsAllowed(domain string) bool {
	domain = strings.ToLower(domain)

	a.mu.RLock()
	defer a.mu.RUnlock()

	// Check defaults (glob patterns), skipping any blocked patterns.
	for _, pattern := range a.defaults {
		if a.blocked[pattern] {
			continue
		}
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

// BlockDefault marks a built-in pattern as requiring approval again.
func (a *Allowlist) BlockDefault(pattern string) {
	pattern = strings.TrimSpace(strings.ToLower(pattern))
	if pattern == "" {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	a.blocked[pattern] = true
}

// UnblockDefault restores a built-in pattern to auto-allow behaviour.
func (a *Allowlist) UnblockDefault(pattern string) {
	pattern = strings.TrimSpace(strings.ToLower(pattern))
	if pattern == "" {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.blocked, pattern)
}

// BlockedDefaults returns a copy of the blocked built-in patterns.
func (a *Allowlist) BlockedDefaults() []string {
	a.mu.RLock()
	defer a.mu.RUnlock()

	result := make([]string, 0, len(a.blocked))
	for pattern := range a.blocked {
		result = append(result, pattern)
	}
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
