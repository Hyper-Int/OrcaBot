// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: browser-process-v1-waitid-nowait

//go:build !linux

package browser

import "os/exec"

// processRunning: the browser stack only runs in the Linux sandbox; elsewhere
// this only has to compile.
func processRunning(cmd *exec.Cmd) bool {
	return cmd != nil && cmd.Process != nil && cmd.ProcessState == nil
}
