// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build !linux

package main

// checkNetAdmin always returns false on non-Linux platforms.
func checkNetAdmin() bool { return false }

// setupEgressIptables is a no-op on non-Linux platforms.
func setupEgressIptables() error { return nil }

// setupPoolMCPIptables is a no-op on non-Linux platforms.
func setupPoolMCPIptables(_ string) error { return nil }
