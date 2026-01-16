// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package sandbox

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

const defaultFlyAPIURL = "https://api.machines.dev"

var (
	ErrMachineNotFound = errors.New("machine not found")
	ErrTimeout         = errors.New("timeout waiting for machine state")
	ErrAPIError        = errors.New("fly api error")
)

// FlyLauncher implements the Launcher interface using Fly Machines API
type FlyLauncher struct {
	appName      string
	token        string
	baseURL      string
	client       *http.Client
	pollInterval time.Duration
}

// FlyOption configures the FlyLauncher
type FlyOption func(*FlyLauncher)

// WithBaseURL sets a custom API base URL (for testing)
func WithBaseURL(url string) FlyOption {
	return func(l *FlyLauncher) {
		l.baseURL = url
	}
}

// WithHTTPClient sets a custom HTTP client
func WithHTTPClient(client *http.Client) FlyOption {
	return func(l *FlyLauncher) {
		l.client = client
	}
}

// WithPollInterval sets the polling interval for Wait
func WithPollInterval(d time.Duration) FlyOption {
	return func(l *FlyLauncher) {
		l.pollInterval = d
	}
}

// NewFlyLauncher creates a new Fly Machines launcher
func NewFlyLauncher(appName, token string, opts ...FlyOption) *FlyLauncher {
	l := &FlyLauncher{
		appName:      appName,
		token:        token,
		baseURL:      defaultFlyAPIURL,
		client:       &http.Client{Timeout: 30 * time.Second},
		pollInterval: 1 * time.Second,
	}

	for _, opt := range opts {
		opt(l)
	}

	return l
}

// Fly API request/response types
type flyMachineConfig struct {
	Image string            `json:"image"`
	Env   map[string]string `json:"env,omitempty"`
	Guest flyGuestConfig    `json:"guest"`
}

type flyGuestConfig struct {
	CPUs     int `json:"cpus"`
	MemoryMB int `json:"memory_mb"`
}

type flyCreateRequest struct {
	Name   string           `json:"name,omitempty"`
	Region string           `json:"region"`
	Config flyMachineConfig `json:"config"`
}

type flyMachineResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	State     string `json:"state"`
	Region    string `json:"region"`
	PrivateIP string `json:"private_ip"`
	CreatedAt string `json:"created_at"`
}

// Create creates a new machine
func (l *FlyLauncher) Create(spec MachineSpec) (*Machine, error) {
	spec.ApplySize()

	req := flyCreateRequest{
		Name:   spec.Name,
		Region: spec.Region,
		Config: flyMachineConfig{
			Image: spec.Image,
			Env:   spec.Env,
			Guest: flyGuestConfig{
				CPUs:     spec.CPUs,
				MemoryMB: spec.MemoryMB,
			},
		},
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("%s/v1/apps/%s/machines", l.baseURL, l.appName)
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("Authorization", "Bearer "+l.token)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := l.client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: status %d", ErrAPIError, resp.StatusCode)
	}

	var flyResp flyMachineResponse
	if err := json.NewDecoder(resp.Body).Decode(&flyResp); err != nil {
		return nil, err
	}

	return l.toMachine(flyResp, spec), nil
}

// Get retrieves a machine by ID
func (l *FlyLauncher) Get(id string) (*Machine, error) {
	url := fmt.Sprintf("%s/v1/apps/%s/machines/%s", l.baseURL, l.appName, id)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+l.token)

	resp, err := l.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrMachineNotFound
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%w: status %d", ErrAPIError, resp.StatusCode)
	}

	var flyResp flyMachineResponse
	if err := json.NewDecoder(resp.Body).Decode(&flyResp); err != nil {
		return nil, err
	}

	return l.toMachine(flyResp, MachineSpec{}), nil
}

// Start starts a stopped machine
func (l *FlyLauncher) Start(id string) error {
	url := fmt.Sprintf("%s/v1/apps/%s/machines/%s/start", l.baseURL, l.appName, id)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+l.token)

	resp, err := l.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return ErrMachineNotFound
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%w: status %d", ErrAPIError, resp.StatusCode)
	}

	return nil
}

// Stop stops a running machine
func (l *FlyLauncher) Stop(id string) error {
	url := fmt.Sprintf("%s/v1/apps/%s/machines/%s/stop", l.baseURL, l.appName, id)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+l.token)

	resp, err := l.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return ErrMachineNotFound
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%w: status %d", ErrAPIError, resp.StatusCode)
	}

	return nil
}

// Destroy destroys a machine
func (l *FlyLauncher) Destroy(id string) error {
	url := fmt.Sprintf("%s/v1/apps/%s/machines/%s", l.baseURL, l.appName, id)
	req, err := http.NewRequest("DELETE", url, nil)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+l.token)

	resp, err := l.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return ErrMachineNotFound
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%w: status %d", ErrAPIError, resp.StatusCode)
	}

	return nil
}

// Wait waits for a machine to reach the specified state
func (l *FlyLauncher) Wait(id string, state MachineState, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		machine, err := l.Get(id)
		if err != nil {
			return err
		}

		if machine.State == state {
			return nil
		}

		time.Sleep(l.pollInterval)
	}

	return ErrTimeout
}

// toMachine converts a Fly API response to our Machine type
func (l *FlyLauncher) toMachine(resp flyMachineResponse, spec MachineSpec) *Machine {
	createdAt, _ := time.Parse(time.RFC3339, resp.CreatedAt)

	return &Machine{
		ID:        resp.ID,
		Name:      resp.Name,
		State:     l.toState(resp.State),
		PrivateIP: resp.PrivateIP,
		Region:    resp.Region,
		CreatedAt: createdAt,
		Spec:      spec,
	}
}

// toState converts Fly state string to MachineState
func (l *FlyLauncher) toState(state string) MachineState {
	switch state {
	case "created":
		return StateCreated
	case "starting":
		return StateStarting
	case "started":
		return StateStarted
	case "stopping":
		return StateStopping
	case "stopped":
		return StateStopped
	case "destroyed":
		return StateDestroyed
	default:
		return StateUnknown
	}
}

// Verify FlyLauncher implements Launcher interface
var _ Launcher = (*FlyLauncher)(nil)
