// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build !linux

package pty

import "os"

// writeSilentPlatform on non-Linux platforms falls back to a regular write
// since termios ioctl constants (TCGETS/TCSETS) are Linux-specific.
func writeSilentPlatform(file *os.File, data []byte) (int, error) {
	return file.Write(data)
}
