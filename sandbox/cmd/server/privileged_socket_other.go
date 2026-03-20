// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build !linux

package main

// PrivilegedSocket is the Unix-domain socket server that authenticates callers
// via SO_PEERCRED and serves privileged requests (e.g. Anthropic API key lookup).
// On non-Linux platforms this is a no-op stub.
type PrivilegedSocket struct{}

// NewPrivilegedSocket returns a PrivilegedSocket. No-op on non-Linux.
func NewPrivilegedSocket(_ *Server) *PrivilegedSocket {
	return &PrivilegedSocket{}
}

// Start is a no-op on non-Linux platforms.
func (ps *PrivilegedSocket) Start() error { return nil }
