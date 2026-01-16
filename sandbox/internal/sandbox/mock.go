// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package sandbox

import (
	"sync"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/id"
)

// MockLauncher implements Launcher for testing without real Fly API calls
type MockLauncher struct {
	mu       sync.RWMutex
	machines map[string]*Machine

	// CreateDelay simulates machine creation time
	CreateDelay time.Duration

	// FailCreate causes Create to fail
	FailCreate bool

	// FailStart causes Start to fail
	FailStart bool

	// FailStop causes Stop to fail
	FailStop bool
}

// NewMockLauncher creates a new mock launcher
func NewMockLauncher() *MockLauncher {
	return &MockLauncher{
		machines: make(map[string]*Machine),
	}
}

// Create creates a mock machine
func (m *MockLauncher) Create(spec MachineSpec) (*Machine, error) {
	if m.FailCreate {
		return nil, ErrAPIError
	}

	if m.CreateDelay > 0 {
		time.Sleep(m.CreateDelay)
	}

	spec.ApplySize()

	machineID, err := id.New()
	if err != nil {
		return nil, err
	}
	privateSuffix, err := id.New()
	if err != nil {
		return nil, err
	}

	machine := &Machine{
		ID:        machineID,
		Name:      spec.Name,
		State:     StateStarted,
		PrivateIP: "10.0.0." + privateSuffix[:1],
		Region:    spec.Region,
		CreatedAt: time.Now(),
		Spec:      spec,
	}

	m.mu.Lock()
	m.machines[machine.ID] = machine
	m.mu.Unlock()

	return machine, nil
}

// Get retrieves a mock machine
func (m *MockLauncher) Get(id string) (*Machine, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	machine, ok := m.machines[id]
	if !ok {
		return nil, ErrMachineNotFound
	}

	return machine, nil
}

// Start starts a mock machine
func (m *MockLauncher) Start(id string) error {
	if m.FailStart {
		return ErrAPIError
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	machine, ok := m.machines[id]
	if !ok {
		return ErrMachineNotFound
	}

	machine.State = StateStarted
	return nil
}

// Stop stops a mock machine
func (m *MockLauncher) Stop(id string) error {
	if m.FailStop {
		return ErrAPIError
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	machine, ok := m.machines[id]
	if !ok {
		return ErrMachineNotFound
	}

	machine.State = StateStopped
	return nil
}

// Destroy destroys a mock machine
func (m *MockLauncher) Destroy(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.machines[id]; !ok {
		return ErrMachineNotFound
	}

	delete(m.machines, id)
	return nil
}

// Wait waits for a mock machine to reach a state (instant in mock)
func (m *MockLauncher) Wait(id string, state MachineState, timeout time.Duration) error {
	machine, err := m.Get(id)
	if err != nil {
		return err
	}

	if machine.State != state {
		return ErrTimeout
	}

	return nil
}

// SetState sets a machine's state (test helper)
func (m *MockLauncher) SetState(id string, state MachineState) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if machine, ok := m.machines[id]; ok {
		machine.State = state
	}
}

// Count returns the number of machines (test helper)
func (m *MockLauncher) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.machines)
}

// Verify MockLauncher implements Launcher interface
var _ Launcher = (*MockLauncher)(nil)
