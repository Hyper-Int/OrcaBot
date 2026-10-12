// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

// sign mirrors controlplane/src/sandbox/request-signing.ts.
func sign(t *testing.T, priv ed25519.PrivateKey, c signedClaims) string {
	t.Helper()
	payload, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	p := base64.RawURLEncoding.EncodeToString(payload)
	sig := ed25519.Sign(priv, []byte(signingContext+p))
	return p + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func newSignedMiddleware(t *testing.T, staticToken string) (*Middleware, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("SANDBOX_AUTH_PUBLIC_KEY", base64.RawURLEncoding.EncodeToString(pub))
	t.Setenv("SANDBOX_INTERNAL_TOKEN", staticToken)
	t.Setenv("FLY_MACHINE_ID", "machine-b")
	t.Setenv("FLY_ALLOC_ID", "")
	return NewMiddleware(), priv
}

func validClaims(method, path string) signedClaims {
	now := time.Now().Unix()
	return signedClaims{MachineID: "machine-b", Method: method, Path: path, IssuedAt: now, ExpiresAt: now + 60}
}

func TestSignedRequestAccepted(t *testing.T) {
	m, priv := newSignedMiddleware(t, "")
	r := httptest.NewRequest("POST", "/sessions/s1/ptys/p1/write?x=a%2Bb", nil)
	r.Header.Set(SignedRequestHeader, sign(t, priv, validClaims("POST", "/sessions/s1/ptys/p1/write?x=a%2Bb")))
	if !m.isAuthenticated(r) {
		t.Fatal("valid signed request rejected")
	}
}

func TestSignedRequestRejections(t *testing.T) {
	m, priv := newSignedMiddleware(t, "")
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now().Unix()

	cases := []struct {
		name   string
		method string
		path   string
		token  func() string
	}{
		{"signed for another machine", "GET", "/sessions/s1/ptys", func() string {
			c := validClaims("GET", "/sessions/s1/ptys")
			c.MachineID = "machine-a"
			return sign(t, priv, c)
		}},
		{"no machine id while this VM has one", "GET", "/sessions/s1/ptys", func() string {
			c := validClaims("GET", "/sessions/s1/ptys")
			c.MachineID = ""
			return sign(t, priv, c)
		}},
		{"method swapped", "DELETE", "/sessions/s1", func() string {
			return sign(t, priv, validClaims("GET", "/sessions/s1"))
		}},
		{"path swapped", "POST", "/sessions/s2/ptys/p9/write", func() string {
			return sign(t, priv, validClaims("POST", "/sessions/s1/ptys/p1/write"))
		}},
		{"query swapped", "GET", "/sessions/s1/file?path=/etc/shadow", func() string {
			return sign(t, priv, validClaims("GET", "/sessions/s1/file?path=notes.txt"))
		}},
		{"expired", "GET", "/sessions/s1/ptys", func() string {
			c := validClaims("GET", "/sessions/s1/ptys")
			c.IssuedAt, c.ExpiresAt = now-600, now-300
			return sign(t, priv, c)
		}},
		{"issued in the future", "GET", "/sessions/s1/ptys", func() string {
			c := validClaims("GET", "/sessions/s1/ptys")
			c.IssuedAt, c.ExpiresAt = now+600, now+660
			return sign(t, priv, c)
		}},
		{"signed by a different key", "GET", "/sessions/s1/ptys", func() string {
			return sign(t, otherPriv, validClaims("GET", "/sessions/s1/ptys"))
		}},
		{"garbage", "GET", "/sessions/s1/ptys", func() string { return "not-a-token" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			r.Header.Set(SignedRequestHeader, tc.token())
			if m.isAuthenticated(r) {
				t.Fatal("request accepted, want rejection")
			}
		})
	}
}

// Once SANDBOX_INTERNAL_TOKEN is withheld from VMs, a token copied from some
// older VM must not work.
func TestStaticTokenRejectedWhenNotConfigured(t *testing.T) {
	m, _ := newSignedMiddleware(t, "")
	r := httptest.NewRequest("GET", "/sessions/s1/ptys", nil)
	r.Header.Set("X-Internal-Token", "old-shared-token")
	if m.isAuthenticated(r) {
		t.Fatal("static token accepted with static auth disabled")
	}
}

func TestStaticTokenStillAcceptedDuringMigration(t *testing.T) {
	m, _ := newSignedMiddleware(t, "shared")
	r := httptest.NewRequest("GET", "/sessions/s1/ptys", nil)
	r.Header.Set("X-Internal-Token", "shared")
	if !m.isAuthenticated(r) {
		t.Fatal("static token rejected while configured")
	}
	r = httptest.NewRequest("GET", "/sessions/s1/ptys", nil)
	r.Header.Set("Authorization", "Bearer shared")
	if !m.isAuthenticated(r) {
		t.Fatal("static bearer rejected while configured")
	}
}

// An invalid signature must not fall through to the static token.
func TestBadSignatureDoesNotFallBackToStatic(t *testing.T) {
	m, _ := newSignedMiddleware(t, "shared")
	r := httptest.NewRequest("GET", "/sessions/s1/ptys", nil)
	r.Header.Set(SignedRequestHeader, "bogus.sig")
	r.Header.Set("X-Internal-Token", "shared")
	if m.isAuthenticated(r) {
		t.Fatal("bad signature fell back to static token")
	}
}

func TestNothingConfiguredFailsClosed(t *testing.T) {
	t.Setenv("SANDBOX_AUTH_PUBLIC_KEY", "")
	t.Setenv("SANDBOX_INTERNAL_TOKEN", "")
	m := NewMiddleware()
	r := httptest.NewRequest("GET", "/sessions", nil)
	r.Header.Set("X-Internal-Token", "")
	if m.IsEnabled() || m.isAuthenticated(r) {
		t.Fatal("auth should be disabled and reject everything")
	}
}

// Desktop / local docker: no FLY_MACHINE_ID, control plane signs with mid "".
func TestSignedRequestWithoutFlyMachine(t *testing.T) {
	m, priv := newSignedMiddleware(t, "")
	m.machineID = ""
	c := validClaims("GET", "/sessions/s1/ptys")
	c.MachineID = ""
	r := httptest.NewRequest("GET", "/sessions/s1/ptys", nil)
	r.Header.Set(SignedRequestHeader, sign(t, priv, c))
	if !m.isAuthenticated(r) {
		t.Fatal("signed request without machine id rejected on a machine without one")
	}
}
