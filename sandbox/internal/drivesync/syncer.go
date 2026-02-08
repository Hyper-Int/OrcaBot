// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: drivesync-syncer-v6-mount-path-fix

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

const syncerRevision = "drivesync-syncer-v6-mount-path-fix"

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
	state         *SyncState
	watcher       *Watcher
	onEvent       EventCallback
	pollInterval  time.Duration

	// PTY token for gateway auth — updated when new PTYs attach Drive
	tokenMu  sync.RWMutex
	ptyToken string

	stop    chan struct{}
	stopped chan struct{}

	// Retry backoff for rate limiting
	backoffMu    sync.Mutex
	backoffUntil time.Time
	backoffLevel int // 0=none, 1=5s, 2=10s, 3=20s, 4=60s

	// Root folder ID: the user-selected Drive folder to sync.
	// All sync operations are scoped to this folder and its descendants.
	rootFolderID string

	// Folder ID → relative path mapping (built during initial sync)
	folderMapMu     sync.RWMutex
	folderMap       map[string]string
	folderNames     map[string]string // folder ID → name (for re-resolution)
	folderParentIDs map[string]string // folder ID → parent folder ID
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
		folderMap:       make(map[string]string),
		folderNames:     make(map[string]string),
		folderParentIDs: make(map[string]string),
	}
}

// UpdateToken replaces the PTY token used for gateway authentication.
// Called when a new PTY attaches Drive while sync is already running.
func (s *Syncer) UpdateToken(token string) {
	s.tokenMu.Lock()
	defer s.tokenMu.Unlock()
	s.ptyToken = token
	log.Printf("[drivesync] updated PTY token for gateway auth")
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

	// Load sync config first — this may adjust mountPath to include folder name
	if err := s.loadSyncConfig(); err != nil {
		log.Printf("[drivesync] failed to load sync config: %v", err)
		// Continue without folder scoping
	}

	// Create mount directory (after loadSyncConfig which may update mountPath)
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

	// Try to remove the parent /workspace/drive/ directory if it's now empty
	driveDir := filepath.Join(s.workspaceRoot, mountDirName)
	if driveDir != s.mountPath {
		_ = os.Remove(driveDir) // only succeeds if empty, which is fine
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

	// Note: loadSyncConfig() is called in run() before initialSync() —
	// rootFolderID and mountPath are already set.

	// Get the changes start token for future incremental polls
	startToken, err := s.getChangesStartToken()
	if err != nil {
		return fmt.Errorf("failed to get changes start token: %w", err)
	}

	// List all items from Drive (policy-filtered by gateway)
	allItems, err := s.listAllDriveFiles()
	if err != nil {
		return fmt.Errorf("failed to list drive files: %w", err)
	}

	// Build folder hierarchy mapping and separate files from folders
	s.buildFolderMapping(allItems)
	var files []*driveFileInfo
	for _, item := range allItems {
		if item.MimeType != "application/vnd.google-apps.folder" {
			files = append(files, item)
		}
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

	// Check total sync size limit (subtract existing file size for updates)
	additionalSize := info.Size()
	if existing != nil {
		additionalSize -= existing.Size
	}
	if additionalSize > 0 && s.state.WouldExceedLimit(additionalSize) {
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

	// Determine (or create) folder ID for the file's parent directory
	parentDir := filepath.Dir(event.RelPath)
	folderID := ""
	if parentDir != "." && parentDir != "" {
		var folderErr error
		folderID, folderErr = s.ensureDriveFolder(parentDir)
		if folderErr != nil {
			log.Printf("[drivesync] failed to ensure Drive folder for %s: %v", parentDir, folderErr)
		}
	} else if s.rootFolderID != "" {
		// Root-level file → parent is the user's selected Drive folder
		folderID = s.rootFolderID
	}

	if existing != nil && existing.DriveFileID != "" {
		// Update existing file
		args := map[string]interface{}{
			"fileId":   existing.DriveFileID,
			"content":  contentStr,
			"mimeType": mimeType,
		}
		if isBinary {
			args["encoding"] = "base64"
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
		if err := s.state.Save(); err != nil {
			log.Printf("[drivesync] failed to save state after removing Google Doc: %v", err)
		}
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

	// Separate folder and file changes. Folders are collected first:
	// processFolderChange stores metadata, then resolveFolderPaths
	// computes correct paths using the complete parent/child tree.
	// This prevents mis-placement when a child change arrives before
	// its parent in the same batch.
	var folderChanges []map[string]interface{}
	var fileChanges []map[string]interface{}
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

		if fileData, ok := changeMap["file"].(map[string]interface{}); ok {
			if mt, _ := fileData["mimeType"].(string); mt == "application/vnd.google-apps.folder" {
				folderChanges = append(folderChanges, changeMap)
				continue
			}
		}
		fileChanges = append(fileChanges, changeMap)
	}

	// Process folder metadata, then resolve all paths at once
	for _, changeMap := range folderChanges {
		s.processFolderChange(changeMap)
	}
	if len(folderChanges) > 0 {
		s.resolveFolderPaths()
	}

	for _, changeMap := range fileChanges {
		select {
		case <-s.stop:
			return
		default:
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
		s.handleRemoteDelete(fileID)
		return
	}

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

	// Folders are handled in the first pass (processFolderChange)
	if mimeType == "application/vnd.google-apps.folder" {
		return
	}

	parents := extractStringArrayFromMap(fileData, "parents")

	// Skip files outside the synced folder tree
	if !s.isInSyncScope(parents) {
		return
	}

	driveFile := &driveFileInfo{
		ID:           fileID,
		Name:         name,
		MimeType:     mimeType,
		ModifiedTime: modifiedTime,
		Size:         sizeStr,
		MD5Checksum:  md5,
		Parents:      parents,
	}

	// Find existing local file by Drive ID
	relPath := s.findLocalPathByDriveID(fileID)

	if relPath != "" {
		// Check for rename/move first
		expectedName := name
		if strings.HasPrefix(mimeType, "application/vnd.google-apps") {
			expectedName = googleDocLocalName(name, mimeType)
		}
		newRelPath := s.resolveFilePath(expectedName, parents)

		if newRelPath != relPath {
			s.handleRemoteFileRename(relPath, newRelPath, driveFile)
			relPath = newRelPath
		}

		// Check if content changed (by checksum)
		existing := s.state.GetFile(relPath)
		if existing != nil && existing.Checksum == md5 && md5 != "" {
			return // No content change
		}

		// Check for conflict (local also modified since last sync)
		if existing != nil {
			localInfo, err := os.Stat(filepath.Join(s.mountPath, relPath))
			if err == nil && localInfo.ModTime().After(existing.LocalModTime) {
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

	// Suppress watcher events for the rename. Without this, the Rename
	// event triggers handleLocalDelete → drive.delete, which would
	// delete the Drive file and violate the "Drive wins" resolution.
	if s.watcher != nil {
		s.watcher.MarkDownloading(relPath)
		s.watcher.MarkDownloading(conflictPath)
		defer s.watcher.UnmarkDownloading(conflictPath)
	}

	if err := os.Rename(absPath, conflictAbs); err != nil {
		log.Printf("[drivesync] failed to rename conflict file: %v", err)
	}

	// Release relPath before downloadFileUpdate, which has its own mark/unmark
	if s.watcher != nil {
		s.watcher.UnmarkDownloading(relPath)
	}

	// Download the remote version (Drive wins)
	s.downloadFileUpdate(relPath, driveFile)
}

// ============================================
// Folder Change Handling (Changes API)
// ============================================

// processFolderChange stores folder metadata from a Changes API event.
// Actual path resolution and filesystem operations are deferred to
// resolveFolderPaths(), which runs after all folder changes in a batch
// are collected — this prevents ordering issues where a child arrives
// before its parent.
func (s *Syncer) processFolderChange(change map[string]interface{}) {
	fileID, _ := change["fileId"].(string)
	removed, _ := change["removed"].(bool)

	if removed {
		s.handleFolderDelete(fileID)
		return
	}

	fileData, ok := change["file"].(map[string]interface{})
	if !ok {
		return
	}

	name, _ := fileData["name"].(string)
	trashed, _ := fileData["trashed"].(bool)
	parents := extractStringArrayFromMap(fileData, "parents")

	if trashed {
		s.handleFolderDelete(fileID)
		return
	}

	// Skip folders outside the synced folder tree
	if !s.isInSyncScope(parents) {
		return
	}

	// Store metadata; resolveFolderPaths() handles path resolution
	s.folderMapMu.Lock()
	s.folderNames[fileID] = name
	if len(parents) > 0 {
		s.folderParentIDs[fileID] = parents[0]
	} else {
		delete(s.folderParentIDs, fileID)
	}
	s.folderMapMu.Unlock()
}

// resolveFolderPaths re-resolves all folder paths from stored name/parent
// metadata. This handles out-of-order parent/child changes: the full tree
// of folder names and parent IDs is available, so resolution always produces
// correct paths regardless of the order changes were received.
func (s *Syncer) resolveFolderPaths() {
	s.folderMapMu.Lock()
	defer s.folderMapMu.Unlock()

	// Resolve all paths from stored metadata
	resolved := make(map[string]string)
	var resolve func(id string) string
	resolve = func(id string) string {
		if path, ok := resolved[id]; ok {
			return path
		}
		name, ok := s.folderNames[id]
		if !ok {
			return "" // Unknown folder (root or outside scope)
		}
		parentPath := ""
		if parentID, ok := s.folderParentIDs[id]; ok {
			parentPath = resolve(parentID)
		}
		var path string
		if parentPath != "" {
			path = filepath.Join(parentPath, name)
		} else {
			path = name
		}
		resolved[id] = path
		return path
	}

	for id := range s.folderNames {
		resolve(id)
	}

	// Apply changes: create new folders, rename moved ones
	for id, newPath := range resolved {
		oldPath, exists := s.folderMap[id]
		if !exists {
			// New folder — create locally
			s.folderMap[id] = newPath
			s.state.SetFolder(newPath, id)
			absPath := filepath.Join(s.mountPath, newPath)
			if err := os.MkdirAll(absPath, 0755); err != nil {
				log.Printf("[drivesync] failed to create folder %s: %v", newPath, err)
			}
			log.Printf("[drivesync] created folder from remote: %s", newPath)
		} else if oldPath != newPath {
			// Path changed — rename locally (only update mapping on success)
			if s.renameFolderLocked(oldPath, newPath) {
				s.folderMap[id] = newPath
				// renameFolderLocked already updated state and child mappings
			}
			// If rename failed, keep old path until next poll
		}
	}

	if err := s.state.Save(); err != nil {
		log.Printf("[drivesync] failed to save state after folder resolution: %v", err)
	}
}

// handleFolderDelete removes a folder and all its contents locally.
func (s *Syncer) handleFolderDelete(folderID string) {
	s.folderMapMu.Lock()
	oldPath, exists := s.folderMap[folderID]
	if !exists {
		// Clean up metadata even if path mapping is gone
		delete(s.folderNames, folderID)
		delete(s.folderParentIDs, folderID)
		s.folderMapMu.Unlock()
		return
	}
	delete(s.folderMap, folderID)
	delete(s.folderNames, folderID)
	delete(s.folderParentIDs, folderID)

	// Also remove child folders from the mapping and metadata
	prefix := oldPath + "/"
	for id, path := range s.folderMap {
		if strings.HasPrefix(path, prefix) {
			delete(s.folderMap, id)
			delete(s.folderNames, id)
			delete(s.folderParentIDs, id)
		}
	}
	s.folderMapMu.Unlock()

	// Suppress watcher events for files in this folder
	allFiles := s.state.AllFiles()
	var affectedPaths []string
	for relPath := range allFiles {
		if strings.HasPrefix(relPath, prefix) {
			affectedPaths = append(affectedPaths, relPath)
			if s.watcher != nil {
				s.watcher.MarkDownloading(relPath)
			}
		}
	}

	// Remove files from state
	for _, relPath := range affectedPaths {
		s.state.RemoveFile(relPath)
	}

	// Remove folder entries from state
	allFolders := s.state.AllFolders()
	for path := range allFolders {
		if path == oldPath || strings.HasPrefix(path, prefix) {
			s.state.RemoveFolder(path)
		}
	}

	// Remove local directory
	absPath := filepath.Join(s.mountPath, oldPath)
	if err := os.RemoveAll(absPath); err != nil {
		log.Printf("[drivesync] failed to remove folder %s: %v", oldPath, err)
	}

	// Unmark files
	for _, relPath := range affectedPaths {
		if s.watcher != nil {
			s.watcher.UnmarkDownloading(relPath)
		}
	}

	if err := s.state.Save(); err != nil {
		log.Printf("[drivesync] failed to save state after folder delete: %v", err)
	}
	log.Printf("[drivesync] removed folder from remote delete: %s", oldPath)
}

// renameFolderLocked renames a local folder and updates all affected state.
// Must be called with folderMapMu held.
func (s *Syncer) renameFolderLocked(oldPath, newPath string) bool {
	oldAbs := filepath.Join(s.mountPath, oldPath)
	newAbs := filepath.Join(s.mountPath, newPath)

	// Suppress watcher events for the rename
	if s.watcher != nil {
		s.watcher.MarkDownloading(oldPath)
		s.watcher.MarkDownloading(newPath)
		defer s.watcher.UnmarkDownloading(oldPath)
		defer s.watcher.UnmarkDownloading(newPath)
	}

	if err := os.MkdirAll(filepath.Dir(newAbs), 0755); err != nil {
		log.Printf("[drivesync] failed to create parent for folder rename: %v", err)
	}

	if err := os.Rename(oldAbs, newAbs); err != nil {
		log.Printf("[drivesync] failed to rename folder %s → %s: %v", oldPath, newPath, err)
		return false
	}

	// Update child folder mappings
	oldPrefix := oldPath + "/"
	for id, path := range s.folderMap {
		if strings.HasPrefix(path, oldPrefix) {
			newSubPath := newPath + path[len(oldPath):]
			s.folderMap[id] = newSubPath
		}
	}

	// Update folder state entries
	allFolders := s.state.AllFolders()
	for path, id := range allFolders {
		if path == oldPath || strings.HasPrefix(path, oldPrefix) {
			s.state.RemoveFolder(path)
			newSubPath := newPath + path[len(oldPath):]
			s.state.SetFolder(newSubPath, id)
		}
	}

	// Update file state entries
	allFiles := s.state.AllFiles()
	for relPath, file := range allFiles {
		if strings.HasPrefix(relPath, oldPrefix) {
			newRelPath := newPath + relPath[len(oldPath):]
			s.state.RemoveFile(relPath)
			file.LocalPath = newRelPath
			s.state.SetFile(newRelPath, file)
		}
	}

	log.Printf("[drivesync] renamed folder: %s → %s", oldPath, newPath)
	return true
}

// ============================================
// Remote File Rename/Move
// ============================================

// handleRemoteFileRename renames a local file when Drive reports a name/parent change.
func (s *Syncer) handleRemoteFileRename(oldRelPath, newRelPath string, df *driveFileInfo) {
	if s.watcher != nil {
		s.watcher.MarkDownloading(oldRelPath)
		s.watcher.MarkDownloading(newRelPath)
		defer s.watcher.UnmarkDownloading(oldRelPath)
		defer s.watcher.UnmarkDownloading(newRelPath)
	}

	oldAbs := filepath.Join(s.mountPath, oldRelPath)
	newAbs := filepath.Join(s.mountPath, newRelPath)

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(newAbs), 0755); err != nil {
		log.Printf("[drivesync] failed to create dir for rename: %v", err)
	}

	if err := os.Rename(oldAbs, newAbs); err != nil {
		log.Printf("[drivesync] failed to rename %s → %s: %v", oldRelPath, newRelPath, err)
		// On failure, clean up old state; processChange will re-download at new path
		s.state.RemoveFile(oldRelPath)
		return
	}

	// Update state: move tracking from old to new path
	existing := s.state.GetFile(oldRelPath)
	if existing != nil {
		s.state.RemoveFile(oldRelPath)
		existing.LocalPath = newRelPath
		s.state.SetFile(newRelPath, existing)
	}

	if err := s.state.Save(); err != nil {
		log.Printf("[drivesync] failed to save state after rename: %v", err)
	}

	log.Printf("[drivesync] renamed: %s → %s (remote rename)", oldRelPath, newRelPath)
}

// ============================================
// Drive Folder Creation (Local → Drive)
// ============================================

// ensureDriveFolder ensures a Drive folder exists for the given relative directory path.
// Creates parent folders recursively on Drive if needed. Returns the Drive folder ID.
func (s *Syncer) ensureDriveFolder(relDir string) (string, error) {
	if relDir == "." || relDir == "" {
		return "", nil
	}

	// Check if we already have this folder
	if id := s.state.GetFolderID(relDir); id != "" {
		return id, nil
	}

	// Ensure parent exists first (recursive)
	parentDir := filepath.Dir(relDir)
	parentID := ""
	if parentDir != "." && parentDir != "" {
		var err error
		parentID, err = s.ensureDriveFolder(parentDir)
		if err != nil {
			return "", err
		}
	} else if s.rootFolderID != "" {
		// Top-level folder → parent is the user's selected Drive folder
		parentID = s.rootFolderID
	}

	// Create the folder on Drive
	folderName := filepath.Base(relDir)
	args := map[string]interface{}{
		"name":     folderName,
		"content":  "",
		"mimeType": "application/vnd.google-apps.folder",
	}
	if parentID != "" {
		args["folderId"] = parentID
	}

	resp, err := s.gatewayExecute("drive.create", args)
	if err != nil {
		return "", fmt.Errorf("failed to create Drive folder %s: %w", relDir, err)
	}

	folderID := extractStringField(resp, "id")
	if folderID == "" {
		return "", fmt.Errorf("no folder ID in response for %s", relDir)
	}

	// Update mapping
	s.folderMapMu.Lock()
	s.folderMap[folderID] = relDir
	s.folderMapMu.Unlock()
	s.state.SetFolder(relDir, folderID)

	log.Printf("[drivesync] created Drive folder: %s (id=%s)", relDir, folderID)
	return folderID, nil
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

// loadSyncConfig fetches the user's selected Drive folder from the control plane.
// This scopes all sync operations to the selected folder and its descendants.
// It also adjusts mountPath to include the folder name (e.g. /workspace/drive/MyFolder)
// so the local path matches what the manifest-based sync uses.
func (s *Syncer) loadSyncConfig() error {
	resp, err := s.gatewayExecute("drive.sync_config", map[string]interface{}{})
	if err != nil {
		return fmt.Errorf("sync config request failed: %w", err)
	}

	folderID := extractStringField(resp, "folderId")
	folderName := extractStringField(resp, "folderName")

	if folderID == "" {
		log.Printf("[drivesync] no root folder configured — syncing entire Drive")
		return nil
	}

	s.rootFolderID = folderID

	// Adjust mount path to include folder name so it matches the manifest sync path
	// (e.g. /workspace/drive/MyFolder instead of /workspace/drive/)
	if folderName != "" {
		safeName := sanitizeFolderName(folderName)
		s.mountPath = filepath.Join(s.workspaceRoot, mountDirName, safeName)
		s.state = NewSyncState(s.mountPath, s.workspaceRoot)
		log.Printf("[drivesync] mount path adjusted to %s", s.mountPath)
	}

	log.Printf("[drivesync] scoped to folder: %s (id=%s)", folderName, folderID)
	return nil
}

// sanitizeFolderName cleans a folder name for use as a local directory name.
// Matches the control plane's sanitizePathSegment logic.
func sanitizeFolderName(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "Drive"
	}
	// Replace path separators with dashes (same as control plane)
	trimmed = strings.ReplaceAll(trimmed, "/", "-")
	trimmed = strings.ReplaceAll(trimmed, "\\", "-")
	return trimmed
}

// isInSyncScope checks whether a file or folder belongs within the synced folder tree.
// Returns true if the item's parent is either the root folder or a known subfolder.
// When no root folder is set (full Drive sync), all items are in scope.
func (s *Syncer) isInSyncScope(parents []string) bool {
	if s.rootFolderID == "" {
		return true // No folder scoping — everything is in scope
	}
	if len(parents) == 0 {
		return false // No parent info — can't determine scope
	}

	parent := parents[0]

	// Direct child of the synced root folder
	if parent == s.rootFolderID {
		return true
	}

	// Child of a known subfolder within the tree
	s.folderMapMu.RLock()
	_, known := s.folderMap[parent]
	s.folderMapMu.RUnlock()
	return known
}

func (s *Syncer) listAllDriveFiles() ([]*driveFileInfo, error) {
	args := map[string]interface{}{}
	if s.rootFolderID != "" {
		args["folderId"] = s.rootFolderID
	}
	resp, err := s.gatewayExecute("drive.sync_list", args)
	if err != nil {
		return nil, err
	}

	filesRaw := extractArrayField(resp, "files")
	var items []*driveFileInfo

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
			Parents:      extractStringArrayFromMap(fm, "parents"),
		}

		items = append(items, df)
	}

	return items, nil
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
	// Account for already-tracked file size (e.g. after restart, state
	// is loaded but files are re-downloaded during initial sync).
	downloadAdditional := fileSize
	if existingPath := s.findLocalPathByDriveID(df.ID); existingPath != "" {
		if existing := s.state.GetFile(existingPath); existing != nil {
			downloadAdditional -= existing.Size
		}
	}
	if downloadAdditional > 0 && s.state.WouldExceedLimit(downloadAdditional) {
		return fmt.Errorf("sync size limit would be exceeded")
	}

	isGoogleDoc := strings.HasPrefix(df.MimeType, "application/vnd.google-apps")

	// Determine local filename
	localName := df.Name
	if isGoogleDoc {
		localName = googleDocLocalName(df.Name, df.MimeType)
	}

	relPath := s.resolveFilePath(localName, df.Parents)

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
		var decodeErr error
		data, decodeErr = base64.StdEncoding.DecodeString(content)
		if decodeErr != nil {
			log.Printf("[drivesync] base64 decode error for %s: %v", relPath, decodeErr)
			s.emitError(relPath, fmt.Sprintf("base64 decode error: %v", decodeErr))
			return
		}
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

	s.tokenMu.RLock()
	token := s.ptyToken
	s.tokenMu.RUnlock()

	resp, err := s.gateway.Execute("google_drive", token, req)
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

func extractStringArrayFromMap(m map[string]interface{}, field string) []string {
	arr, ok := m[field].([]interface{})
	if !ok {
		return nil
	}
	result := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			result = append(result, s)
		}
	}
	return result
}

// buildFolderMapping builds a mapping from Drive folder IDs to relative local paths.
// It also stores the mapping in the sync state and creates local directories.
func (s *Syncer) buildFolderMapping(allItems []*driveFileInfo) {
	// Collect folders and store metadata for incremental re-resolution
	folders := make(map[string]*driveFileInfo)
	names := make(map[string]string)
	parentIDs := make(map[string]string)
	for _, item := range allItems {
		if item.MimeType == "application/vnd.google-apps.folder" {
			folders[item.ID] = item
			names[item.ID] = item.Name
			if len(item.Parents) > 0 {
				parentIDs[item.ID] = item.Parents[0]
			}
		}
	}

	mapping := make(map[string]string) // folder ID → relative path

	var resolve func(id string) string
	resolve = func(id string) string {
		if path, ok := mapping[id]; ok {
			return path
		}
		folder, ok := folders[id]
		if !ok {
			return "" // Unknown folder (root or outside scope)
		}
		parentPath := ""
		if len(folder.Parents) > 0 {
			parentPath = resolve(folder.Parents[0])
		}
		var path string
		if parentPath != "" {
			path = filepath.Join(parentPath, folder.Name)
		} else {
			path = folder.Name
		}
		mapping[id] = path
		return path
	}

	// Resolve all folders
	for id := range folders {
		resolve(id)
	}

	// Store mapping, metadata, and create local directories
	s.folderMapMu.Lock()
	s.folderMap = mapping
	s.folderNames = names
	s.folderParentIDs = parentIDs
	s.folderMapMu.Unlock()

	for id, relPath := range mapping {
		s.state.SetFolder(relPath, id)
		absPath := filepath.Join(s.mountPath, relPath)
		if err := os.MkdirAll(absPath, 0755); err != nil {
			log.Printf("[drivesync] failed to create folder %s: %v", relPath, err)
		}
	}

	log.Printf("[drivesync] built folder mapping: %d folders", len(mapping))
}

// resolveFilePath determines the local relative path for a Drive file
// by looking up its parent folder in the folder mapping.
func (s *Syncer) resolveFilePath(localName string, parents []string) string {
	if len(parents) == 0 {
		return localName
	}

	s.folderMapMu.RLock()
	parentPath := s.folderMap[parents[0]]
	s.folderMapMu.RUnlock()

	if parentPath != "" {
		return filepath.Join(parentPath, localName)
	}
	return localName
}
