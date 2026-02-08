// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package pty

import (
	"os"
)

// DefaultShell returns the preferred shell for PTY sessions.
// Honors SHELL env var when available, otherwise falls back to /bin/bash or /bin/sh.
func DefaultShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	if _, err := os.Stat("/bin/bash"); err == nil {
		return "/bin/bash"
	}
	return "/bin/sh"
}
