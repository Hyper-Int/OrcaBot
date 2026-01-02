package sandbox

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFlyLauncherCreate(t *testing.T) {
	// Mock Fly API server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/apps/test-app/machines" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}

		// Verify auth header
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing or invalid auth header")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		// Return created machine
		resp := flyMachineResponse{
			ID:        "machine-123",
			Name:      "test-machine",
			State:     "started",
			Region:    "iad",
			PrivateIP: "10.0.0.1",
			CreatedAt: time.Now().Format(time.RFC3339),
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	launcher := NewFlyLauncher("test-app", "test-token", WithBaseURL(server.URL))

	spec := DefaultSpec()
	spec.Name = "test-machine"

	machine, err := launcher.Create(spec)
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}

	if machine.ID != "machine-123" {
		t.Errorf("expected ID machine-123, got %s", machine.ID)
	}
	if machine.State != StateStarted {
		t.Errorf("expected state started, got %s", machine.State)
	}
}

func TestFlyLauncherGet(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/v1/apps/test-app/machines/machine-123" {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		resp := flyMachineResponse{
			ID:        "machine-123",
			Name:      "test-machine",
			State:     "started",
			Region:    "iad",
			PrivateIP: "10.0.0.1",
			CreatedAt: time.Now().Format(time.RFC3339),
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	launcher := NewFlyLauncher("test-app", "test-token", WithBaseURL(server.URL))

	machine, err := launcher.Get("machine-123")
	if err != nil {
		t.Fatalf("get failed: %v", err)
	}

	if machine.ID != "machine-123" {
		t.Errorf("expected ID machine-123, got %s", machine.ID)
	}
}

func TestFlyLauncherGetNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	launcher := NewFlyLauncher("test-app", "test-token", WithBaseURL(server.URL))

	_, err := launcher.Get("nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent machine")
	}
}

func TestFlyLauncherStart(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/apps/test-app/machines/machine-123/start" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	launcher := NewFlyLauncher("test-app", "test-token", WithBaseURL(server.URL))

	err := launcher.Start("machine-123")
	if err != nil {
		t.Fatalf("start failed: %v", err)
	}
}

func TestFlyLauncherStop(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/apps/test-app/machines/machine-123/stop" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	launcher := NewFlyLauncher("test-app", "test-token", WithBaseURL(server.URL))

	err := launcher.Stop("machine-123")
	if err != nil {
		t.Fatalf("stop failed: %v", err)
	}
}

func TestFlyLauncherDestroy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" || r.URL.Path != "/v1/apps/test-app/machines/machine-123" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	launcher := NewFlyLauncher("test-app", "test-token", WithBaseURL(server.URL))

	err := launcher.Destroy("machine-123")
	if err != nil {
		t.Fatalf("destroy failed: %v", err)
	}
}

func TestFlyLauncherWait(t *testing.T) {
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		state := "starting"
		if callCount >= 3 {
			state = "started"
		}

		resp := flyMachineResponse{
			ID:        "machine-123",
			State:     state,
			CreatedAt: time.Now().Format(time.RFC3339),
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	launcher := NewFlyLauncher("test-app", "test-token",
		WithBaseURL(server.URL),
		WithPollInterval(10*time.Millisecond))

	err := launcher.Wait("machine-123", StateStarted, 5*time.Second)
	if err != nil {
		t.Fatalf("wait failed: %v", err)
	}

	if callCount < 3 {
		t.Errorf("expected at least 3 calls, got %d", callCount)
	}
}

func TestFlyLauncherWaitTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		resp := flyMachineResponse{
			ID:        "machine-123",
			State:     "starting", // Never changes
			CreatedAt: time.Now().Format(time.RFC3339),
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	launcher := NewFlyLauncher("test-app", "test-token",
		WithBaseURL(server.URL),
		WithPollInterval(10*time.Millisecond))

	err := launcher.Wait("machine-123", StateStarted, 50*time.Millisecond)
	if err == nil {
		t.Error("expected timeout error")
	}
}

func TestMachineSpecApplySize(t *testing.T) {
	tests := []struct {
		size     MachineSize
		wantCPU  int
		wantMem  int
	}{
		{SizeSmall, 1, 256},
		{SizeMedium, 2, 512},
		{SizeLarge, 4, 1024},
	}

	for _, tt := range tests {
		t.Run(string(tt.size), func(t *testing.T) {
			spec := MachineSpec{Size: tt.size}
			spec.ApplySize()

			if spec.CPUs != tt.wantCPU {
				t.Errorf("expected %d CPUs, got %d", tt.wantCPU, spec.CPUs)
			}
			if spec.MemoryMB != tt.wantMem {
				t.Errorf("expected %d MB, got %d", tt.wantMem, spec.MemoryMB)
			}
		})
	}
}

func TestMachineSpecApplySizeDoesNotOverride(t *testing.T) {
	spec := MachineSpec{
		Size:     SizeSmall,
		CPUs:     8,
		MemoryMB: 2048,
	}
	spec.ApplySize()

	if spec.CPUs != 8 {
		t.Errorf("expected CPUs to stay 8, got %d", spec.CPUs)
	}
	if spec.MemoryMB != 2048 {
		t.Errorf("expected memory to stay 2048, got %d", spec.MemoryMB)
	}
}

func TestDefaultSpec(t *testing.T) {
	spec := DefaultSpec()

	if spec.Size != SizeMedium {
		t.Errorf("expected medium size, got %s", spec.Size)
	}
	if spec.Region != "iad" {
		t.Errorf("expected region iad, got %s", spec.Region)
	}
	if spec.Env == nil {
		t.Error("expected non-nil Env map")
	}
}
