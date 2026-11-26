// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: cpauth-v8-machine-controlplane-url

package cpauth

import (
	"log"
	"os"
	"strings"
)

// MachineControlPlaneURLEnv is set on each VM by the control plane that created it.
//
// Every VM must talk to the control plane that created it (production and dev share one
// Fly app and one database). The control plane puts its URL in the machine's env as
// CONTROLPLANE_URL, but the Fly app also has CONTROLPLANE_URL as an app secret
// (production's), and Fly secrets override a machine's own env: so every VM, dev ones
// included, reported to production. This name has no app secret, so it survives, and
// ApplyMachineControlPlaneURL makes it CONTROLPLANE_URL for this process and its children.
const MachineControlPlaneURLEnv = "ORCABOT_CONTROLPLANE_URL"

// ApplyMachineControlPlaneURL copies ORCABOT_CONTROLPLANE_URL over CONTROLPLANE_URL when
// set (call it first thing in main, before anything reads CONTROLPLANE_URL). VMs created
// before the control plane set it keep CONTROLPLANE_URL as it is. Returns the URL in use.
func ApplyMachineControlPlaneURL() string {
	current := os.Getenv("CONTROLPLANE_URL")
	want := strings.TrimRight(strings.TrimSpace(os.Getenv(MachineControlPlaneURLEnv)), "/")
	if want == "" {
		return current
	}
	if want != strings.TrimRight(current, "/") {
		log.Printf("[cpauth] REVISION: cpauth-v8-machine-controlplane-url: control plane %s (this machine's), not %q (app-wide)", want, current)
	}
	_ = os.Setenv("CONTROLPLANE_URL", want)
	return want
}
