// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

//go:build !linux

package egress

import "fmt"

// StartTransparent is not supported on non-Linux platforms.
func (p *EgressProxy) StartTransparent() error {
	return fmt.Errorf("transparent proxy not supported on this platform")
}
