// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: drivesync-syncer-v1-initial

package drivesync

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/mcp"
	"github.com/fsnotify/fsnotify"
)

const syncerRevision = "drivesync-syncer-v1-initial"

func init() {
	log.Printf("[drivesync-syncer] REVISION: %s loaded at %s", syncerRevision, time.Now().Format(time.RFC3339))
}

// EventCallback is called by the syncer to broadcast sync status events.
// The caller (session) wires this to Hub.broadcastControl.
type EventCallback func(event SyncEvent)

// SyncEvent represents a sync status update broadcast via WebSocket.
type SyncEvent struct {
	Type      string `json:"type"`                // always "drive_sync"
	Status    string `json:"status"`              // "syncing" | "synced" | "error" | "conflict" | "initial_complete" | "removed"
	Direction string `json:"direction,omitempty"` // "upload" | "download" | ""
	File      string `json:"file,omitempty"`      // relative path
	Error     string `json:"error,omitempty"`     // error message
	FileCount int    `json:"fileCount,omitempty"` // total synced files
}

// Syncer orchestrates bidirectional sync between a local directory and Google Drive.
// It uses fsnotify for local→Drive uploads and the Drive Changes API for Drive→local downloads.
type Syncer struct {
	mountPath     string // e.g. /workspace/drive/
	workspaceRoot string
	gateway       *mcp.GatewayClient
	ptyToken      string // for gateway auth
	state         *SyncState
	watcher       *Watcher
	onEvent       EventCallback
	pollInterval  time.Duration

	stop    chan struct{}
	stopped chan struct{}

	// Retry backoff for rate limiting
	backoffMu    sync.Mutex
	backoffUntil time.Time
	backoffLevel int // 0=none, 1=5s, 2=10s, 3=20s, 4=60s
}

const (
	mountDirName        = "drive"
	defaultPollInterval = 30 * time.Second
)

// New creates a new Drive syncer.
func New(workspaceRoot string, gateway *mcp.GatewayClient, ptyToken string, onEvent EventCallback) *Syncer {
	mountPath := filepath.Join(workspaceRoot, mountDirName)
	return &Syncer{
		mountPath:     mountPath,
		workspaceRoot: workspaceRoot,
		gateway:       gateway,
		ptyToken:      ptyToken,
		state:         NewSyncState(mountPath, workspaceRoot),
		onEvent:       onEvent,
		pollInterval:  defaultPollInterval,
		stop:          make(chan struct{}),
		stopped:       make(chan struct{}),
	}
}

// Start begins the sync process: initial pull, then watch + poll loops.
func (s *Syncer) Start() {
	go s.run()
}

// Stop shuts down sync and removes the mount directory + all synced files.
func (s *Syncer) Stop() {
	select {
	case <-s.stop:
		return // already stopped
	default:
	}
	close(s.stop)
	<-s.stopped
}

func (s *Syncer) run() {
	defer close(s.stopped)

	log.Printf("[drivesync] starting sync, mount=%s", s.mountPath)

	// Create mount directory
	if err := os.MkdirAll(s.mountPath, 0755); err != nil {
		log.Printf("[drivesync] failed to create mount dir: %v", err)
		s.emitError("", fmt.Sprintf("failed to create mount directory: %v", err))
		return
	}

	// Load persisted state
	if err := s.state.Load(); err != nil {
		log.Printf("[drivesync] failed to load state: %v", err)
	}

	// Initial sync: full pull from Drive
	if err := s.initialSync(); err != nil {
		log.Printf("[drivesync] initial sync failed: %v", err)
		s.emitError("", fmt.Sprintf("initial sync failed: %v", err))
		// Continue anyway — poll loop will retry
	}

	// Start file watcher
	watcher, err := NewWatcher(s.mountPath)
	if err != nil {
		log.Printf("[drivesync] failed to create watcher: %v", err)
		s.emitError("", fmt.Sprintf("failed to start file watcher: %v", err))
		return
	}
	s.watcher = watcher
	if err := watcher.Start(); err != nil {
		log.Printf("[drivesync] failed to start watcher: %v", err)
		s.emitError("", fmt.Sprintf("failed to start file watcher: %v", err))
		return
	}

	// Main loop: process local events + periodic remote poll
	pollTicker := time.NewTicker(s.pollInterval)
	defer pollTicker.Stop()
	defer watcher.Stop()

	for {
		select {
		case <-s.stop:
			s.cleanup()
			return

		case event, ok := <-watcher.Events():
			if !ok {
				return
			}
			s.handleLocalEvent(event)

		case <-pollTicker.C:
			if s.isBackedOff() {
				continue
			}
			s.pollRemoteChanges()
		}
	}
}

// cleanup removes the mount directory and all synced files on detach.
func (s *Syncer) cleanup() {
	log.Printf("[drivesync] cleaning up mount directory %s", s.mountPath)

	if err := os.RemoveAll(s.mountPath); err != nil {
		log.Printf("[drivesync] failed to remove mount dir: %v", err)
	}

	// Remove state file
	if err := s.state.Delete(); err != nil && !os.IsNotExist(err) {
		log.Printf("[drivesync] failed to delete state file: %v", err)
	}

	s.emit(SyncEvent{Type: "drive_sync", Status: "removed"})
	log.Printf("[drivesync] cleanup complete")
}

// ============================================
// Initial Sync
// ============================================

func (s *Syncer) initialSync() error {
	log.Printf("[drivesync] starting initial sync")
	s.emit(SyncEvent{Type: "drive_sync", Status: "syncing", Direction: "download"})

	// Get the changes start token for future incremental polls
	startToken, err := s.getChangesStartToken()
	if err != nil {
		return fmt.Errorf("failed to get changes start token: %w", err)
	}

	// List all files from Drive (policy-filtered by gateway)
	files, err := s.listAllDriveFiles()
	if err != nil {
		return fmt.Errorf("failed to list drive files: %w", err)
	}

	log.Printf("[drivesync] found %d files in Drive", len(files))

	downloaded := 0
	for _, df := range files {
		select {
		case <-s.stop:
			return fmt.Errorf("sync stopped")
		default:
		}

		if err := s.downloadFile(df); err != nil {
			log.Printf("[drivesync] failed to download %s: %v", df.Name, err)
			s.emitError(df.Name, err.Error())
			continue
		}
		downloaded++
	}

	// Save changes token for incremental polling
	s.state.SetChangesToken(startToken)
	if err := s.state.Save(); err != nil {
		log.Printf("[drivesync] failed to save state: %v", err)
	}

	log.Printf("[drivesync] initial sync complete: %d files downloaded", downloaded)
	s.emit(SyncEvent{
		Type:      "drive_sync",
		Status:    "initial_complete",
		FileCount: downloaded,
	})

	return nil
}

// ============================================
// Local → Drive (Upload)
// ============================================

func (s *Syncer) handleLocalEvent(event FileEvent) {
	switch {
	case event.Op.Has(fsnotify.Remove) || event.Op.Has(fsnotify.Rename):
		s.handleLocalDelete(event)
	case event.Op.Has(fsnotify.Create) || event.Op.Has(fsnotify.Write):
		s.handleLocalCreateOrUpdate(event)
	}
}

func (s *Syncer) handleLocalCreateOrUpdate(event FileEvent) {
	// Check if this is a Google Doc (read-only, don't sync back)
	existing := s.state.GetFile(event.RelPath)
	if existing != nil && existing.IsGoogleDoc {
		return
	}

	// Read file info
	info, err := os.Stat(event.AbsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return // File was deleted between event and handler
		}
		log.Printf("[drivesync] stat error for %s: %v", event.RelPath, err)
		return
	}

	// Skip directories
	if info.IsDir() {
		return
	}

	// Check file size limit
	if info.Size() > DefaultMaxFileSize {
		log.Printf("[drivesync] skipping %s: too large (%d bytes)", event.RelPath, info.Size())
		s.emitError(event.RelPath, fmt.Sprintf("file too large: %d bytes (max %d)", info.Size(), DefaultMaxFileSize))
		return
	}

	// Check total sync size limit
	if s.state.WouldExceedLimit(info.Size()) {
		log.Printf("[drivesync] skipping %s: would exceed sync limit", event.RelPath)
		s.emitError(event.RelPath, "sync size limit exceeded")
		return
	}

	s.emit(SyncEvent{Type: "drive_sync", Status: "syncing", Direction: "upload", File: event.RelPath})

	// Read file content
	content, err := os.ReadFile(event.AbsPath)
	if err != nil {
		log.Printf("[drivesync] read error for %s: %v", event.RelPath, err)
		s.emitError(event.RelPath, err.Error())
		return
	}

	// Determine MIME type
	mimeType := detectMimeType(event.RelPath)

	// Determine if we need base64 encoding for binary files
	contentStr, isBinary := encodeContent(content, mimeType)

	// Determine folder ID for the file's parent directory
	parentDir := filepath.Dir(event.RelPath)
	folderID := ""
	if parentDir != "." {
		folderID = s.state.GetFolderID(parentDir)
	}

	if existing != nil && existing.DriveFileID != "" {
		// Update existing file
		args := map[string]interface{}{
			"fileId":   existing.DriveFileID,
			"content":  contentStr,
			"mimeType": mimeType,
		}
		resp, err := s.gatewayExecute("drive.update", args)
		if err != nil {
			s.handleGatewayError(event.RelPath, "upload", err)
			return
		}
		_ = resp // Update response not needed for state
	} else {
		// Create new file
		args := map[string]interface{}{
			"name":     filepath.Base(event.RelPath),
			"content":  contentStr,
			"mimeType": mimeType,
		}
		if isBinary {
			args["encoding"] = "base64"
		}
		if folderID != "" {
			args["folderId"] = folderID
		}
		resp, err := s.gatewayExecute("drive.create", args)
		if err != nil {
			s.handleGatewayError(event.RelPath, "upload", err)
			return
		}

		// Extract file ID from response
		fileID := extractStringField(resp, "id")
		if fileID != "" {
			s.state.SetFile(event.RelPath, &SyncedFile{
				DriveFileID:  fileID,
				LocalPath:    event.RelPath,
				DriveModTime: time.Now(),
				LocalModTime: info.ModTime(),
				Size:         info.Size(),
				MimeType:     mimeType,
				LastSyncDir:  "up",
			})
		}
	}

	// Update state
	if existing != nil {
		existing.LocalModTime = info.ModTime()
		existing.DriveModTime = time.Now()
		existing.Size = info.Size()
		existing.LastSyncDir = "up"
		s.state.SetFile(event.RelPath, existing)
	}

	if err := s.state.Save(); err != nil {
		log.Printf("[drivesync] failed to save state after upload: %v", err)
	}

	s.emit(SyncEvent{Type: "drive_sync", Status: "synced", Direction: "upload", File: event.RelPath})
}

func (s *Syncer) handleLocalDelete(event FileEvent) {
	existing := s.state.GetFile(event.RelPath)
	if existing == nil || existing.DriveFileID == "" {
		return // Not tracked, nothing to do
	}

	// Don't delete Google Docs from Drive
	if existing.IsGoogleDoc {
		s.state.RemoveFile(event.RelPath)
		return
	}

	s.emit(SyncEvent{Type: "drive_sync", Status: "syncing", Direction: "upload", File: event.RelPath})

	args := map[string]interface{}{
		"fileId": existing.DriveFileID,
	}
	_, err := s.gatewayExecute("drive.delete", args)
	if err != nil {
		log.Printf("[drivesync] failed to delete %s from Drive: %v", event.RelPath, err)
		s.emitError(event.RelPath, err.Error())
		// Remove from state anyway — the local file is gone
	}

	s.state.RemoveFile(event.RelPath)
	if err := s.state.Save(); err != nil {
		log.Printf("[drivesync] failed to save state after delete: %v", err)
	}

	s.emit(SyncEvent{Type: "drive_sync", Status: "synced", Direction: "upload", File: event.RelPath})
}

// ============================================
// Drive → Local (Download via Changes API)
// ============================================

func (s *Syncer) pollRemoteChanges() {
	token := s.state.GetChangesToken()
	if token == "" {
		log.Printf("[drivesync] no changes token, skipping poll")
		return
	}

	args := map[string]interface{}{
		"pageToken": token,
	}
	resp, err := s.gatewayExecute("drive.changes_list", args)
	if err != nil {
		s.handleGatewayError("", "poll", err)
		return
	}

	// Reset backoff on success
	s.resetBackoff()

	changes := extractArrayField(resp, "changes")
	newToken := extractStringField(resp, "newStartPageToken")

	if len(changes) > 0 {
		log.Printf("[drivesync] processing %d remote changes", len(changes))
	}

	for _, change := range changes {
		select {
		case <-s.stop:
			return
		default:
		}

		changeMap, ok := change.(map[string]interface{})
		if !ok {
			continue
		}

		s.processChange(changeMap)
	}

	// Update the changes token
	if newToken != "" {
		s.state.SetChangesToken(newToken)
	}

	if err := s.state.Save(); err != nil {
		log.Printf("[drivesync] failed to save state after poll: %v", err)
	}
}

func (s *Syncer) processChange(change map[string]interface{}) {
	fileID, _ := change["fileId"].(string)
	removed, _ := change["removed"].(bool)

	if removed {
		// File was deleted in Drive — find and remove locally
		s.handleRemoteDelete(fileID)
		return
	}

	// File was created or modified
	fileData, ok := change["file"].(map[string]interface{})
	if !ok {
		return
	}

	name, _ := fileData["name"].(string)
	mimeType, _ := fileData["mimeType"].(string)
	modifiedTime, _ := fileData["modifiedTime"].(string)
	sizeStr, _ := fileData["size"].(string)
	md5, _ := fileData["md5Checksum"].(string)
	trashed, _ := fileData["trashed"].(bool)

	if trashed {
		s.handleRemoteDelete(fileID)
		return
	}

	// Skip Google Drive folders — we track them but don't create local dirs for them yet
	if mimeType == "application/vnd.google-apps.folder" {
		return
	}

	// Find existing local file by Drive ID
	relPath := s.findLocalPathByDriveID(fileID)

	// Check if file changed since our last sync
	if relPath != "" {
		existing := s.state.GetFile(relPath)
		if existing != nil && existing.Checksum == md5 && md5 != "" {
			return // No change
		}
	}

	driveFile := &driveFileInfo{
		ID:           fileID,
		Name:         name,
		MimeType:     mimeType,
		ModifiedTime: modifiedTime,
		Size:         sizeStr,
		MD5Checksum:  md5,
	}

	if relPath != "" {
		// File exists locally — check for conflict
		existing := s.state.GetFile(relPath)
		if existing != nil {
			localInfo, err := os.Stat(filepath.Join(s.mountPath, relPath))
			if err == nil && localInfo.ModTime().After(existing.LocalModTime) {
				// Local file was also modified — conflict
				s.handleConflict(relPath, driveFile)
				return
			}
		}

		// No conflict — download updated version
		s.downloadFileUpdate(relPath, driveFile)
	} else {
		// New file from Drive
		if err := s.downloadFile(driveFile); err != nil {
			log.Printf("[drivesync] failed to download new file %s: %v", name, err)
			s.emitError(name, err.Error())
		}
	}
}

func (s *Syncer) handleRemoteDelete(fileID string) {
	relPath := s.findLocalPathByDriveID(fileID)
	if relPath == "" {
		return // Not tracked locally
	}

	absPath := filepath.Join(s.mountPath, relPath)

	// Mark as downloading so watcher doesn't trigger an upload
	if s.watcher != nil {
		s.watcher.MarkDownloading(relPath)
		defer s.watcher.UnmarkDownloading(relPath)
	}

	if err := os.Remove(absPath); err != nil && !os.IsNotExist(err) {
		log.Printf("[drivesync] failed to remove locally deleted file %s: %v", relPath, err)
	}

	s.state.RemoveFile(relPath)
	log.Printf("[drivesync] removed locally: %s (deleted from Drive)", relPath)
}

func (s *Syncer) handleConflict(relPath string, driveFile *driveFileInfo) {
	log.Printf("[drivesync] conflict detected for %s", relPath)
	s.emit(SyncEvent{Type: "drive_sync", Status: "conflict", File: relPath})

	absPath := filepath.Join(s.mountPath, relPath)

	// Rename local version to .local-conflict
	ext := filepath.Ext(relPath)
	base := strings.TrimSuffix(relPath, ext)
	conflictPath := base + ".local-conflict" + ext
	conflictAbs := filepath.Join(s.mountPath, conflictPath)

	if err := os.Rename(absPath, conflictAbs); err != nil {
		log.Printf("[drivesync] failed to rename conflict file: %v", err)
	}

	// Download the remote version (Drive wins)
	s.downloadFileUpdate(relPath, driveFile)
}

// ============================================
// Gateway Helpers
// ============================================

type driveFileInfo struct {
	ID           string
	Name         string
	MimeType     string
	ModifiedTime string
	Size         string
	MD5Checksum  string
	Parents      []string
}

func (s *Syncer) getChangesStartToken() (string, error) {
	resp, err := s.gatewayExecute("drive.changes_start_token", map[string]interface{}{})
	if err != nil {
		return "", err
	}
	return extractStringField(resp, "startPageToken"), nil
}

func (s *Syncer) listAllDriveFiles() ([]*driveFileInfo, error) {
	resp, err := s.gatewayExecute("drive.sync_list", map[string]interface{}{})
	if err != nil {
		return nil, err
	}

	filesRaw := extractArrayField(resp, "files")
	var files []*driveFileInfo

	for _, f := range filesRaw {
		fm, ok := f.(map[string]interface{})
		if !ok {
			continue
		}

		df := &driveFileInfo{
			ID:           extractString(fm, "id"),
			Name:         extractString(fm, "name"),
			MimeType:     extractString(fm, "mimeType"),
			ModifiedTime: extractString(fm, "modifiedTime"),
			Size:         extractString(fm, "size"),
			MD5Checksum:  extractString(fm, "md5Checksum"),
		}

		// Skip folders (we handle them separately)
		if df.MimeType == "application/vnd.google-apps.folder" {
			continue
		}

		files = append(files, df)
	}

	return files, nil
}

func (s *Syncer) downloadFile(df *driveFileInfo) error {
	// Check size limit
	var fileSize int64
	if df.Size != "" {
		fmt.Sscanf(df.Size, "%d", &fileSize)
	}
	if fileSize > DefaultMaxFileSize {
		return fmt.Errorf("file too large: %d bytes", fileSize)
	}
	if s.state.WouldExceedLimit(fileSize) {
		return fmt.Errorf("sync size limit would be exceeded")
	}

	isGoogleDoc := strings.HasPrefix(df.MimeType, "application/vnd.google-apps")

	// Determine local filename
	localName := df.Name
	if isGoogleDoc {
		localName = googleDocLocalName(df.Name, df.MimeType)
	}

	relPath := localName // Root-level for now; TODO: folder mapping

	s.emit(SyncEvent{Type: "drive_sync", Status: "syncing", Direction: "download", File: relPath})

	// Mark as downloading so watcher skips events
	if s.watcher != nil {
		s.watcher.MarkDownloading(relPath)
		defer s.watcher.UnmarkDownloading(relPath)
	}

	// Download via gateway
	args := map[string]interface{}{
		"fileId": df.ID,
	}
	resp, err := s.gatewayExecute("drive.download", args)
	if err != nil {
		return err
	}

	content := extractStringField(resp, "content")
	encoding := extractStringField(resp, "encoding")
	respMimeType := extractStringField(resp, "mimeType")

	// Write to disk
	absPath := filepath.Join(s.mountPath, relPath)

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(absPath), 0755); err != nil {
		return err
	}

	var data []byte
	if encoding == "base64" {
		data, err = base64.StdEncoding.DecodeString(content)
		if err != nil {
			return fmt.Errorf("base64 decode error: %w", err)
		}
	} else {
		data = []byte(content)
	}

	if err := os.WriteFile(absPath, data, 0644); err != nil {
		return err
	}

	// Parse modification time
	modTime := time.Now()
	if df.ModifiedTime != "" {
		if parsed, err := time.Parse(time.RFC3339, df.ModifiedTime); err == nil {
			modTime = parsed
		}
	}

	// Track in state
	actualMimeType := respMimeType
	if actualMimeType == "" {
		actualMimeType = df.MimeType
	}

	s.state.SetFile(relPath, &SyncedFile{
		DriveFileID:  df.ID,
		LocalPath:    relPath,
		DriveModTime: modTime,
		LocalModTime: time.Now(),
		Size:         int64(len(data)),
		Checksum:     df.MD5Checksum,
		MimeType:     actualMimeType,
		LastSyncDir:  "down",
		IsGoogleDoc:  isGoogleDoc,
	})

	s.emit(SyncEvent{Type: "drive_sync", Status: "synced", Direction: "download", File: relPath})
	return nil
}

func (s *Syncer) downloadFileUpdate(relPath string, df *driveFileInfo) {
	if s.watcher != nil {
		s.watcher.MarkDownloading(relPath)
		defer s.watcher.UnmarkDownloading(relPath)
	}

	s.emit(SyncEvent{Type: "drive_sync", Status: "syncing", Direction: "download", File: relPath})

	args := map[string]interface{}{
		"fileId": df.ID,
	}
	resp, err := s.gatewayExecute("drive.download", args)
	if err != nil {
		log.Printf("[drivesync] failed to download update for %s: %v", relPath, err)
		s.emitError(relPath, err.Error())
		return
	}

	content := extractStringField(resp, "content")
	encoding := extractStringField(resp, "encoding")
	absPath := filepath.Join(s.mountPath, relPath)

	var data []byte
	if encoding == "base64" {
		data, _ = base64.StdEncoding.DecodeString(content)
	} else {
		data = []byte(content)
	}

	if err := os.WriteFile(absPath, data, 0644); err != nil {
		log.Printf("[drivesync] failed to write update for %s: %v", relPath, err)
		s.emitError(relPath, err.Error())
		return
	}

	// Parse modification time
	modTime := time.Now()
	if df.ModifiedTime != "" {
		if parsed, err := time.Parse(time.RFC3339, df.ModifiedTime); err == nil {
			modTime = parsed
		}
	}

	s.state.SetFile(relPath, &SyncedFile{
		DriveFileID:  df.ID,
		LocalPath:    relPath,
		DriveModTime: modTime,
		LocalModTime: time.Now(),
		Size:         int64(len(data)),
		Checksum:     df.MD5Checksum,
		MimeType:     df.MimeType,
		LastSyncDir:  "down",
	})

	s.emit(SyncEvent{Type: "drive_sync", Status: "synced", Direction: "download", File: relPath})
}

// ============================================
// Gateway Execution
// ============================================

func (s *Syncer) gatewayExecute(action string, args map[string]interface{}) (json.RawMessage, error) {
	req := mcp.ExecuteRequest{
		Action: action,
		Args:   args,
	}

	resp, err := s.gateway.Execute("google_drive", s.ptyToken, req)
	if err != nil {
		return nil, fmt.Errorf("gateway error: %w", err)
	}

	if !resp.Allowed {
		errMsg := resp.Error
		if errMsg == "" {
			errMsg = resp.Reason
		}
		if resp.Error == "RATE_LIMITED" {
			s.increaseBackoff()
			return nil, fmt.Errorf("rate limited: %s", resp.Reason)
		}
		return nil, fmt.Errorf("gateway denied: %s — %s", resp.Error, resp.Reason)
	}

	return resp.FilteredResponse, nil
}

func (s *Syncer) handleGatewayError(file, direction string, err error) {
	errStr := err.Error()
	log.Printf("[drivesync] gateway error (%s %s): %v", direction, file, err)
	if strings.Contains(errStr, "rate limited") || strings.Contains(errStr, "RATE_LIMITED") {
		s.increaseBackoff()
	}
	s.emitError(file, errStr)
}

// ============================================
// Rate Limit Backoff
// ============================================

var backoffDurations = []time.Duration{0, 5 * time.Second, 10 * time.Second, 20 * time.Second, 60 * time.Second}

func (s *Syncer) increaseBackoff() {
	s.backoffMu.Lock()
	defer s.backoffMu.Unlock()
	if s.backoffLevel < len(backoffDurations)-1 {
		s.backoffLevel++
	}
	s.backoffUntil = time.Now().Add(backoffDurations[s.backoffLevel])
	log.Printf("[drivesync] backing off for %v (level %d)", backoffDurations[s.backoffLevel], s.backoffLevel)
}

func (s *Syncer) resetBackoff() {
	s.backoffMu.Lock()
	defer s.backoffMu.Unlock()
	s.backoffLevel = 0
	s.backoffUntil = time.Time{}
}

func (s *Syncer) isBackedOff() bool {
	s.backoffMu.Lock()
	defer s.backoffMu.Unlock()
	return time.Now().Before(s.backoffUntil)
}

// ============================================
// Event Emission
// ============================================

func (s *Syncer) emit(event SyncEvent) {
	if s.onEvent != nil {
		s.onEvent(event)
	}
}

func (s *Syncer) emitError(file, errMsg string) {
	s.emit(SyncEvent{
		Type:   "drive_sync",
		Status: "error",
		File:   file,
		Error:  errMsg,
	})
}

// ============================================
// Utility Functions
// ============================================

func (s *Syncer) findLocalPathByDriveID(fileID string) string {
	files := s.state.AllFiles()
	for relPath, f := range files {
		if f.DriveFileID == fileID {
			return relPath
		}
	}
	return ""
}

func detectMimeType(relPath string) string {
	ext := filepath.Ext(relPath)
	if ext == "" {
		return "application/octet-stream"
	}
	mt := mime.TypeByExtension(ext)
	if mt == "" {
		return "application/octet-stream"
	}
	return mt
}

// encodeContent returns the content string suitable for the gateway.
// For text files, returns the raw string. For binary, returns base64.
func encodeContent(data []byte, mimeType string) (string, bool) {
	if isTextMime(mimeType) {
		return string(data), false
	}
	return base64.StdEncoding.EncodeToString(data), true
}

func isTextMime(mimeType string) bool {
	if strings.HasPrefix(mimeType, "text/") {
		return true
	}
	textTypes := []string{
		"application/json",
		"application/xml",
		"application/javascript",
		"application/typescript",
		"application/x-yaml",
		"application/toml",
		"application/csv",
		"application/sql",
		"application/graphql",
	}
	for _, t := range textTypes {
		if strings.HasPrefix(mimeType, t) {
			return true
		}
	}
	return false
}

func googleDocLocalName(name, mimeType string) string {
	switch mimeType {
	case "application/vnd.google-apps.document":
		return name + ".gdoc.txt"
	case "application/vnd.google-apps.spreadsheet":
		return name + ".gsheet.csv"
	case "application/vnd.google-apps.presentation":
		return name + ".gslides.txt"
	default:
		return name + ".gdoc.txt"
	}
}

// JSON extraction helpers
func extractStringField(raw json.RawMessage, field string) string {
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return ""
	}
	return extractString(m, field)
}

func extractString(m map[string]interface{}, field string) string {
	v, ok := m[field]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return s
}

func extractArrayField(raw json.RawMessage, field string) []interface{} {
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	arr, ok := m[field].([]interface{})
	if !ok {
		return nil
	}
	return arr
}
