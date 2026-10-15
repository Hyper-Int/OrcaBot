// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: guest-timesync-v2-error-codes
//go:build !linux

package main

import "fmt"

// serve is Linux-only (AF_VSOCK + settimeofday); the guest is always Linux.
func serve(port uint32) error {
	return fmt.Errorf("guest-timesync only runs inside the Linux sandbox VM (port %d)", port)
}
