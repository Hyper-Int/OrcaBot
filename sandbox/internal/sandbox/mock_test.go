package sandbox

import (
	"testing"
	"time"
)

func TestMockLauncherCreate(t *testing.T) {
	launcher := NewMockLauncher()

	spec := DefaultSpec()
	spec.Name = "test-machine"

	machine, err := launcher.Create(spec)
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}

	if machine.ID == "" {
		t.Error("expected non-empty ID")
	}
	if machine.Name != "test-machine" {
		t.Errorf("expected name test-machine, got %s", machine.Name)
	}
	if machine.State != StateStarted {
		t.Errorf("expected state started, got %s", machine.State)
	}

	if launcher.Count() != 1 {
		t.Errorf("expected 1 machine, got %d", launcher.Count())
	}
}

func TestMockLauncherGet(t *testing.T) {
	launcher := NewMockLauncher()

	machine, _ := launcher.Create(DefaultSpec())

	retrieved, err := launcher.Get(machine.ID)
	if err != nil {
		t.Fatalf("get failed: %v", err)
	}

	if retrieved.ID != machine.ID {
		t.Errorf("expected ID %s, got %s", machine.ID, retrieved.ID)
	}
}

func TestMockLauncherGetNotFound(t *testing.T) {
	launcher := NewMockLauncher()

	_, err := launcher.Get("nonexistent")
	if err != ErrMachineNotFound {
		t.Errorf("expected ErrMachineNotFound, got %v", err)
	}
}

func TestMockLauncherStartStop(t *testing.T) {
	launcher := NewMockLauncher()

	machine, _ := launcher.Create(DefaultSpec())

	// Stop
	err := launcher.Stop(machine.ID)
	if err != nil {
		t.Fatalf("stop failed: %v", err)
	}

	m, _ := launcher.Get(machine.ID)
	if m.State != StateStopped {
		t.Errorf("expected stopped, got %s", m.State)
	}

	// Start
	err = launcher.Start(machine.ID)
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}

	m, _ = launcher.Get(machine.ID)
	if m.State != StateStarted {
		t.Errorf("expected started, got %s", m.State)
	}
}

func TestMockLauncherDestroy(t *testing.T) {
	launcher := NewMockLauncher()

	machine, _ := launcher.Create(DefaultSpec())

	err := launcher.Destroy(machine.ID)
	if err != nil {
		t.Fatalf("destroy failed: %v", err)
	}

	if launcher.Count() != 0 {
		t.Errorf("expected 0 machines, got %d", launcher.Count())
	}

	_, err = launcher.Get(machine.ID)
	if err != ErrMachineNotFound {
		t.Error("expected machine to be gone")
	}
}

func TestMockLauncherWait(t *testing.T) {
	launcher := NewMockLauncher()

	machine, _ := launcher.Create(DefaultSpec())

	err := launcher.Wait(machine.ID, StateStarted, time.Second)
	if err != nil {
		t.Fatalf("wait failed: %v", err)
	}
}

func TestMockLauncherWaitWrongState(t *testing.T) {
	launcher := NewMockLauncher()

	machine, _ := launcher.Create(DefaultSpec())

	err := launcher.Wait(machine.ID, StateStopped, time.Second)
	if err != ErrTimeout {
		t.Errorf("expected ErrTimeout, got %v", err)
	}
}

func TestMockLauncherFailCreate(t *testing.T) {
	launcher := NewMockLauncher()
	launcher.FailCreate = true

	_, err := launcher.Create(DefaultSpec())
	if err == nil {
		t.Error("expected create to fail")
	}
}

func TestMockLauncherSetState(t *testing.T) {
	launcher := NewMockLauncher()

	machine, _ := launcher.Create(DefaultSpec())
	launcher.SetState(machine.ID, StateStopped)

	m, _ := launcher.Get(machine.ID)
	if m.State != StateStopped {
		t.Errorf("expected stopped, got %s", m.State)
	}
}
