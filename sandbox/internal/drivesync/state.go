// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: drivesync-state-v2-remove-folder

// Package drivesync implements bidirectional sync between /workspace/drive/ and Google Drive.
// All Drive API calls go through the control plane gateway — OAuth tokens never leave the
// control plane. The sync daemon runs in the sandbox, watches the local directory with
// fsnotify, and polls for remote changes via the Drive Changes API.
package drivesync

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const stateRevision = "drivesync-state-v2-remove-folder"

func init() {
	log.Printf("[drivesync-state] REVISION: %s loaded at %s", stateRevision, time.Now().Format(time.RFC3339))
}

// SyncState tracks the state of all synced files and the Changes API cursor.
// Persisted to /workspace/.orcabot/drive-sync-state.json.
type SyncState struct {
	mu sync.RWMutex

	MountPath       string                 `json:"mountPath"`
	Files           map[string]*SyncedFile `json:"files"`           // key: relative path from mount
	Folders         map[string]string      `json:"folders"`         // key: relative path, value: Drive folder ID
	ChangesToken    string                 `json:"changesToken"`    // Drive Changes API page token
	LastPoll        time.Time              `json:"lastPoll"`
	TotalSyncedSize int64                  `json:"totalSyncedSize"` // bytes currently synced
	MaxSyncSize     int64                  `json:"maxSyncSize"`     // limit in bytes (default 500MB)

	statePath string // filesystem path for persistence
}

// SyncedFile tracks the sync state of a single file.
type SyncedFile struct {
	DriveFileID  string    `json:"driveFileId"`
	LocalPath    string    `json:"localPath"`    // relative to mount
	DriveModTime time.Time `json:"driveModTime"`
	LocalModTime time.Time `json:"localModTime"`
	Size         int64     `json:"size"`
	Checksum     string    `json:"checksum"`    // MD5 from Drive (matches Drive's md5Checksum field)
	LastSyncDir  string    `json:"lastSyncDir"` // "up" | "down"
	MimeType     string    `json:"mimeType"`
	IsGoogleDoc  bool      `json:"isGoogleDoc"` // Google Docs/Sheets/Slides — read-only
}

const (
	DefaultMaxSyncSize = 500 * 1024 * 1024 // 500MB
	DefaultMaxFileSize = 50 * 1024 * 1024  // 50MB per file
	stateFileName      = "drive-sync-state.json"
	stateDir           = ".orcabot"
)

// NewSyncState creates a new empty sync state.
func NewSyncState(mountPath, workspaceRoot string) *SyncState {
	return &SyncState{
		MountPath:   mountPath,
		Files:       make(map[string]*SyncedFile),
		Folders:     make(map[string]string),
		MaxSyncSize: DefaultMaxSyncSize,
		statePath:   filepath.Join(workspaceRoot, stateDir, stateFileName),
	}
}

// Load reads sync state from disk. Returns a fresh state if file doesn't exist.
func (s *SyncState) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.statePath)
	if err != nil {
		if os.IsNotExist(err) {
			log.Printf("[drivesync-state] no existing state file, starting fresh")
			return nil
		}
		return err
	}

	// Unmarshal into a temporary struct to preserve our statePath
	var loaded SyncState
	if err := json.Unmarshal(data, &loaded); err != nil {
		log.Printf("[drivesync-state] corrupt state file, starting fresh: %v", err)
		return nil
	}

	s.Files = loaded.Files
	s.Folders = loaded.Folders
	s.ChangesToken = loaded.ChangesToken
	s.LastPoll = loaded.LastPoll
	s.TotalSyncedSize = loaded.TotalSyncedSize
	if loaded.MaxSyncSize > 0 {
		s.MaxSyncSize = loaded.MaxSyncSize
	}

	// Ensure maps are initialized
	if s.Files == nil {
		s.Files = make(map[string]*SyncedFile)
	}
	if s.Folders == nil {
		s.Folders = make(map[string]string)
	}

	log.Printf("[drivesync-state] loaded state: %d files, %d folders, changesToken=%q",
		len(s.Files), len(s.Folders), s.ChangesToken)
	return nil
}

// Save persists sync state to disk atomically (write to temp + rename).
func (s *SyncState) Save() error {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Ensure state directory exists
	dir := filepath.Dir(s.statePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}

	// Write atomically: temp file + rename
	tmp := s.statePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, s.statePath)
}

// Delete removes the state file from disk.
func (s *SyncState) Delete() error {
	return os.Remove(s.statePath)
}

// GetFile returns the sync state for a file, or nil if not tracked.
func (s *SyncState) GetFile(relPath string) *SyncedFile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Files[relPath]
}

// SetFile updates or adds a file to the sync state.
func (s *SyncState) SetFile(relPath string, f *SyncedFile) {
	s.mu.Lock()
	defer s.mu.Unlock()

	old := s.Files[relPath]
	if old != nil {
		s.TotalSyncedSize -= old.Size
	}
	s.Files[relPath] = f
	s.TotalSyncedSize += f.Size
}

// RemoveFile removes a file from the sync state.
func (s *SyncState) RemoveFile(relPath string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if f, ok := s.Files[relPath]; ok {
		s.TotalSyncedSize -= f.Size
		delete(s.Files, relPath)
	}
}

// SetFolder records a folder mapping.
func (s *SyncState) SetFolder(relPath, driveID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Folders[relPath] = driveID
}

// GetFolderID returns the Drive folder ID for a local path, or empty string.
func (s *SyncState) GetFolderID(relPath string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Folders[relPath]
}

// SetChangesToken updates the Drive Changes API cursor.
func (s *SyncState) SetChangesToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ChangesToken = token
}

// GetChangesToken returns the current Changes API cursor.
func (s *SyncState) GetChangesToken() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ChangesToken
}

// WouldExceedLimit checks if adding a file of the given size would exceed the sync limit.
func (s *SyncState) WouldExceedLimit(size int64) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.TotalSyncedSize+size > s.MaxSyncSize
}

// FileCount returns the number of tracked files.
func (s *SyncState) FileCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.Files)
}

// AllFiles returns a snapshot of all tracked files.
func (s *SyncState) AllFiles() map[string]*SyncedFile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]*SyncedFile, len(s.Files))
	for k, v := range s.Files {
		copy := *v
		result[k] = &copy
	}
	return result
}

// RemoveFolder removes a folder from the sync state.
func (s *SyncState) RemoveFolder(relPath string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.Folders, relPath)
}

// AllFolders returns a snapshot of all tracked folders.
func (s *SyncState) AllFolders() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make(map[string]string, len(s.Folders))
	for k, v := range s.Folders {
		result[k] = v
	}
	return result
}
