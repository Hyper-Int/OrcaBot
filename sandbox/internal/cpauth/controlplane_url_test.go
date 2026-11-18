// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package cpauth

import (
	"os"
	"testing"
)

func TestMachineControlPlaneURLWinsOverTheAppSecret(t *testing.T) {
	t.Setenv("CONTROLPLANE_URL", "https://api.orcabot.com") // the app-wide Fly secret
	t.Setenv(MachineControlPlaneURLEnv, "https://api.dev.orcabot.com/")
	if got := ApplyMachineControlPlaneURL(); got != "https://api.dev.orcabot.com" {
		t.Fatalf("got %q", got)
	}
	if got := os.Getenv("CONTROLPLANE_URL"); got != "https://api.dev.orcabot.com" {
		t.Fatalf("CONTROLPLANE_URL not replaced: %q", got)
	}
}

func TestWithoutTheMachineURLNothingChanges(t *testing.T) {
	t.Setenv("CONTROLPLANE_URL", "https://api.orcabot.com")
	t.Setenv(MachineControlPlaneURLEnv, "  ")
	if got := ApplyMachineControlPlaneURL(); got != "https://api.orcabot.com" {
		t.Fatalf("got %q", got)
	}
	if got := os.Getenv("CONTROLPLANE_URL"); got != "https://api.orcabot.com" {
		t.Fatalf("CONTROLPLANE_URL changed: %q", got)
	}
}
