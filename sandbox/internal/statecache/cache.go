// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: state-cache-v7-full-task-schema
package statecache

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const cacheRevision = "state-cache-v7-full-task-schema"

func init() {
	log.Printf("[state-cache] REVISION: %s loaded at %s", cacheRevision, time.Now().Format(time.RFC3339))
}

// CacheDir is the directory where state cache files are stored
// Note: No leading slash - this is a relative path from workspaceRoot
const CacheDir = ".orcabot"

// CacheFile is the state cache filename
const CacheFile = "state.json"

// TaskEntry represents a cached task
// REVISION: state-cache-v7-full-task-schema
type TaskEntry struct {
	ID          string                 `json:"id"`
	DashboardID string                 `json:"dashboardId,omitempty"`
	SessionID   *string                `json:"sessionId,omitempty"` // nil = dashboard-wide, non-nil = session-scoped (PTY-specific)
	ParentID    *string                `json:"parentId,omitempty"`  // nil = top-level task
	Subject     string                 `json:"subject"`
	Description string                 `json:"description,omitempty"`
	Status      string                 `json:"status"`
	Priority    int                    `json:"priority"`
	OwnerAgent  string                 `json:"ownerAgent,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
	BlockedBy   []string               `json:"blockedBy,omitempty"` // Task IDs this task is blocked by
	Blocks      []string               `json:"blocks,omitempty"`    // Task IDs this task blocks
	CreatedAt   string                 `json:"createdAt"`
	UpdatedAt   string                 `json:"updatedAt"`
	StartedAt   *string                `json:"startedAt,omitempty"`   // When task moved to in_progress
	CompletedAt *string                `json:"completedAt,omitempty"` // When task was completed/cancelled
}

// MemoryEntry represents a cached memory value
type MemoryEntry struct {
	Value      interface{} `json:"value"`
	MemoryType string      `json:"memoryType"`
	UpdatedAt  string      `json:"updatedAt"`
}

// StateCache represents the cached state file
type StateCache struct {
	Version  int                    `json:"version"`
	LastSync string                 `json:"lastSync"`
	Tasks    []TaskEntry            `json:"tasks"`
	Memory   map[string]MemoryEntry `json:"memory"`
}

// Cache manages the workspace state cache
type Cache struct {
	workspaceRoot string
	mu            sync.RWMutex
	state         *StateCache
}

// NewCache creates a new state cache manager
func NewCache(workspaceRoot string) *Cache {
	return &Cache{
		workspaceRoot: workspaceRoot,
		state: &StateCache{
			Version: 1,
			Tasks:   []TaskEntry{},
			Memory:  make(map[string]MemoryEntry),
		},
	}
}

// CachePath returns the full path to the cache file
func (c *Cache) CachePath() string {
	return filepath.Join(c.workspaceRoot, CacheDir, CacheFile)
}

// EnsureDir ensures the cache directory exists
func (c *Cache) EnsureDir() error {
	dir := filepath.Join(c.workspaceRoot, CacheDir)
	return os.MkdirAll(dir, 0755)
}

// Load reads the state cache from disk
func (c *Cache) Load() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	data, err := os.ReadFile(c.CachePath())
	if err != nil {
		if os.IsNotExist(err) {
			// No cache file yet - that's OK
			return nil
		}
		return fmt.Errorf("failed to read cache: %w", err)
	}

	var state StateCache
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("failed to parse cache: %w", err)
	}

	c.state = &state
	return nil
}

// Save writes the state cache to disk
func (c *Cache) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.EnsureDir(); err != nil {
		return fmt.Errorf("failed to create cache dir: %w", err)
	}

	c.state.LastSync = time.Now().UTC().Format(time.RFC3339)

	data, err := json.MarshalIndent(c.state, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal cache: %w", err)
	}

	if err := os.WriteFile(c.CachePath(), data, 0644); err != nil {
		return fmt.Errorf("failed to write cache: %w", err)
	}

	return nil
}

// SetTasks updates the cached tasks
func (c *Cache) SetTasks(tasks []TaskEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state.Tasks = tasks
}

// GetTasks returns the cached tasks
func (c *Cache) GetTasks() []TaskEntry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.state.Tasks
}

// SetMemory updates a cached memory entry
func (c *Cache) SetMemory(key string, entry MemoryEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state.Memory == nil {
		c.state.Memory = make(map[string]MemoryEntry)
	}
	c.state.Memory[key] = entry
}

// GetMemory returns a cached memory entry
func (c *Cache) GetMemory(key string) (MemoryEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.state.Memory[key]
	return entry, ok
}

// DeleteMemory removes a cached memory entry
func (c *Cache) DeleteMemory(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.state.Memory, key)
}

// Clear resets the cache to empty state
func (c *Cache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.state = &StateCache{
		Version: 1,
		Tasks:   []TaskEntry{},
		Memory:  make(map[string]MemoryEntry),
	}
}

// SyncFromServer fetches latest state from control plane and updates cache
// This is called on session start for persistent filesystems (Sprites, Desktop)
// Uses dashboard token to fetch dashboard-wide tasks and memory
func (c *Cache) SyncFromServer(dashboardToken string, controlPlaneURL string) error {
	if dashboardToken == "" || controlPlaneURL == "" {
		log.Printf("[state-cache] SyncFromServer skipped: missing token or URL")
		return nil
	}

	log.Printf("[state-cache] SyncFromServer starting from %s", controlPlaneURL)

	httpClient := &http.Client{Timeout: 30 * time.Second}

	// Fetch tasks
	if err := c.syncTasks(httpClient, dashboardToken, controlPlaneURL); err != nil {
		log.Printf("[state-cache] Failed to sync tasks: %v", err)
		// Continue - partial sync is better than no sync
	}

	// Fetch memory
	if err := c.syncMemory(httpClient, dashboardToken, controlPlaneURL); err != nil {
		log.Printf("[state-cache] Failed to sync memory: %v", err)
	}

	// Save to disk
	if err := c.Save(); err != nil {
		log.Printf("[state-cache] Failed to save cache: %v", err)
		return err
	}

	log.Printf("[state-cache] SyncFromServer completed: %d tasks, %d memory entries",
		len(c.state.Tasks), len(c.state.Memory))
	return nil
}

// syncTasks fetches tasks from the control plane
func (c *Cache) syncTasks(client *http.Client, token, baseURL string) error {
	req, err := http.NewRequest("POST", baseURL+"/internal/gateway/tasks/execute", bytes.NewReader(
		[]byte(`{"action":"tasks.list","args":{"includeCompleted":false}}`),
	))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("X-Dashboard-Token", token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result struct {
		Tasks []TaskEntry `json:"tasks"`
		Error string      `json:"error,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}
	if result.Error != "" {
		return fmt.Errorf("server error: %s", result.Error)
	}

	c.SetTasks(result.Tasks)
	return nil
}

// syncMemory fetches memory entries from the control plane
func (c *Cache) syncMemory(client *http.Client, token, baseURL string) error {
	req, err := http.NewRequest("POST", baseURL+"/internal/gateway/memory/execute", bytes.NewReader(
		[]byte(`{"action":"memory.list","args":{}}`),
	))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("X-Dashboard-Token", token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result struct {
		Memories []struct {
			Key        string      `json:"key"`
			Value      interface{} `json:"value"`
			MemoryType string      `json:"memoryType"`
			UpdatedAt  string      `json:"updatedAt"`
		} `json:"memories"`
		Error string `json:"error,omitempty"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}
	if result.Error != "" {
		return fmt.Errorf("server error: %s", result.Error)
	}

	c.mu.Lock()
	c.state.Memory = make(map[string]MemoryEntry)
	for _, m := range result.Memories {
		c.state.Memory[m.Key] = MemoryEntry{
			Value:      m.Value,
			MemoryType: m.MemoryType,
			UpdatedAt:  m.UpdatedAt,
		}
	}
	c.mu.Unlock()
	return nil
}

// UpdateTask updates or adds a task in the cache
func (c *Cache) UpdateTask(task TaskEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for i, t := range c.state.Tasks {
		if t.ID == task.ID {
			c.state.Tasks[i] = task
			return
		}
	}
	// Not found, add it
	c.state.Tasks = append(c.state.Tasks, task)
}

// DeleteTask removes a task from the cache
func (c *Cache) DeleteTask(taskID string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	for i, t := range c.state.Tasks {
		if t.ID == taskID {
			c.state.Tasks = append(c.state.Tasks[:i], c.state.Tasks[i+1:]...)
			return
		}
	}
}

// GetTask returns a specific task by ID
func (c *Cache) GetTask(taskID string) (TaskEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	for _, t := range c.state.Tasks {
		if t.ID == taskID {
			return t, true
		}
	}
	return TaskEntry{}, false
}

// GetAllMemory returns all cached memory entries
func (c *Cache) GetAllMemory() map[string]MemoryEntry {
	c.mu.RLock()
	defer c.mu.RUnlock()

	result := make(map[string]MemoryEntry, len(c.state.Memory))
	for k, v := range c.state.Memory {
		result[k] = v
	}
	return result
}

// LastSyncTime returns when the cache was last synced
func (c *Cache) LastSyncTime() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()

	if c.state.LastSync == "" {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339, c.state.LastSync)
	return t
}

// IsFresh returns true if the cache was synced within the given duration
func (c *Cache) IsFresh(maxAge time.Duration) bool {
	lastSync := c.LastSyncTime()
	if lastSync.IsZero() {
		return false
	}
	return time.Since(lastSync) < maxAge
}
