// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package sandbox

import "time"

// MachineSize represents predefined machine configurations
type MachineSize string

const (
	SizeSmall  MachineSize = "small"  // 1 CPU, 256MB RAM
	SizeMedium MachineSize = "medium" // 2 CPU, 512MB RAM
	SizeLarge  MachineSize = "large"  // 4 CPU, 1GB RAM
)

// MachineSpec defines the configuration for a sandbox machine
type MachineSpec struct {
	// Name is a human-readable identifier
	Name string

	// Image is the Docker image to run
	Image string

	// Size is the machine size preset
	Size MachineSize

	// CPUs is the number of CPU cores (overrides Size)
	CPUs int

	// MemoryMB is the memory in megabytes (overrides Size)
	MemoryMB int

	// Region is the Fly.io region (e.g., "iad", "lax", "cdg")
	Region string

	// Env is the environment variables for the machine
	Env map[string]string

	// WorkspaceSize is the size of the workspace volume in GB
	WorkspaceSize int
}

// DefaultSpec returns a default machine spec
func DefaultSpec() MachineSpec {
	return MachineSpec{
		Image:         "orcabot-sandbox:latest",
		Size:          SizeMedium,
		Region:        "iad",
		Env:           make(map[string]string),
		WorkspaceSize: 10,
	}
}

// ApplySize applies CPU and memory based on size preset
func (s *MachineSpec) ApplySize() {
	switch s.Size {
	case SizeSmall:
		if s.CPUs == 0 {
			s.CPUs = 1
		}
		if s.MemoryMB == 0 {
			s.MemoryMB = 256
		}
	case SizeMedium:
		if s.CPUs == 0 {
			s.CPUs = 2
		}
		if s.MemoryMB == 0 {
			s.MemoryMB = 512
		}
	case SizeLarge:
		if s.CPUs == 0 {
			s.CPUs = 4
		}
		if s.MemoryMB == 0 {
			s.MemoryMB = 1024
		}
	default:
		// Default to medium
		if s.CPUs == 0 {
			s.CPUs = 2
		}
		if s.MemoryMB == 0 {
			s.MemoryMB = 512
		}
	}
}

// MachineState represents the current state of a machine
type MachineState string

const (
	StateCreated   MachineState = "created"
	StateStarting  MachineState = "starting"
	StateStarted   MachineState = "started"
	StateStopping  MachineState = "stopping"
	StateStopped   MachineState = "stopped"
	StateDestroyed MachineState = "destroyed"
	StateUnknown   MachineState = "unknown"
)

// Machine represents a running sandbox machine
type Machine struct {
	// ID is the unique machine identifier from Fly
	ID string

	// Name is the human-readable name
	Name string

	// State is the current machine state
	State MachineState

	// PrivateIP is the internal IP address
	PrivateIP string

	// Region is the region where the machine is running
	Region string

	// CreatedAt is when the machine was created
	CreatedAt time.Time

	// Spec is the machine specification used to create this machine
	Spec MachineSpec
}

// Launcher defines the interface for creating and managing sandbox machines
type Launcher interface {
	// Create creates a new machine with the given spec
	Create(spec MachineSpec) (*Machine, error)

	// Get retrieves a machine by ID
	Get(id string) (*Machine, error)

	// Start starts a stopped machine
	Start(id string) error

	// Stop stops a running machine
	Stop(id string) error

	// Destroy destroys a machine
	Destroy(id string) error

	// Wait waits for a machine to reach the specified state
	Wait(id string, state MachineState, timeout time.Duration) error
}
