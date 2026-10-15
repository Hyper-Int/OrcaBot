// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-kernel-v11-browser-user-port-block

//go:build !linux

package main

// checkNetAdmin always returns false on non-Linux platforms.
func checkNetAdmin() bool { return false }

// setupEgressIptables is a no-op on non-Linux platforms.
func setupEgressIptables() error { return nil }

// setupPoolMCPIptables is a no-op on non-Linux platforms.
func setupPoolMCPIptables(_ string) error { return nil }

// setupPoolBrowserPortBlock is a no-op on non-Linux platforms.
func setupPoolBrowserPortBlock() error { return nil }

// setupPoolEgressDenyIptables is a no-op on non-Linux platforms.
func setupPoolEgressDenyIptables() error { return nil }

// installBrowserUserPortBlock is a no-op on non-Linux platforms.
func installBrowserUserPortBlock() error { return nil }
