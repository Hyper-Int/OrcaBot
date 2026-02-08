// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/drive"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/sessions"
)

const driveManifestFile = ".orcabot-drive-manifest.json"

type driveSyncRequest struct {
	DashboardID string `json:"dashboard_id"`
}

func (s *Server) handleDriveSync(w http.ResponseWriter, r *http.Request) {
	session := s.getSessiоnOrErrоr(w, r.PathValue("sessionId"))
	if session == nil {
		return
	}
	if s.driveMirror == nil || !s.driveMirror.Enabled() {
		http.Error(w, "E79730: Drive mirror not configured", http.StatusServiceUnavailable)
		return
	}

	var req driveSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DashboardID == "" {
		http.Error(w, "E79731: dashboard_id required", http.StatusBadRequest)
		return
	}

	if !s.startDriveSync(req.DashboardID) {
		http.Error(w, "E79732: Drive sync already running", http.StatusConflict)
		return
	}

	go func() {
		defer s.finishDriveSync(req.DashboardID)
		if err := s.runDriveSync(context.Background(), session, req.DashboardID); err != nil {
			log.Printf("drive sync error: %v", err)
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	w.Write([]byte(`{"status":"started"}`))
}

func (s *Server) startDriveSync(dashboardID string) bool {
	s.driveSyncMu.Lock()
	defer s.driveSyncMu.Unlock()
	if s.driveSyncActive[dashboardID] {
		return false
	}
	s.driveSyncActive[dashboardID] = true
	return true
}

func (s *Server) finishDriveSync(dashboardID string) {
	s.driveSyncMu.Lock()
	delete(s.driveSyncActive, dashboardID)
	s.driveSyncMu.Unlock()
}

func (s *Server) runDriveSync(ctx context.Context, session *sessions.Session, dashboardID string) error {
	manifest, err := s.driveMirror.FetchManifest(ctx, dashboardID)
	if err != nil {
		s.reportDriveError(ctx, dashboardID, err)
		return err
	}

	root := filepath.Join(session.Wоrkspace().Root(), filepath.FromSlash(manifest.FolderPath))
	if err := os.MkdirAll(root, 0755); err != nil {
		s.reportDriveError(ctx, dashboardID, err)
		return err
	}

	for _, dir := range manifest.Directories {
		dirPath := filepath.Join(root, filepath.FromSlash(dir))
		if pathWithinRoot(root, dirPath) {
			_ = os.MkdirAll(dirPath, 0755)
		}
	}

	oldManifest, _ := readLocalManifest(filepath.Join(root, driveManifestFile))
	oldEntries := map[string]drive.ManifestEntry{}
	for _, entry := range oldManifest.Entries {
		oldEntries[entry.ID] = entry
	}

	newEntries := map[string]drive.ManifestEntry{}
	workspaceSyncedFiles := 0
	workspaceSyncedBytes := int64(0)

	s.reportDriveProgress(ctx, dashboardID, workspaceSyncedFiles, workspaceSyncedBytes, "syncing_workspace", "")

	for _, entry := range manifest.Entries {
		newEntries[entry.ID] = entry
		targetPath := filepath.Join(root, filepath.FromSlash(entry.Path))
		if !pathWithinRoot(root, targetPath) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			continue
		}

		downloaded := false
		if entry.CacheStatus == "cached" {
			oldEntry, ok := oldEntries[entry.ID]
			if ok && oldEntry.Md5Checksum == entry.Md5Checksum && oldEntry.ModifiedTime == entry.ModifiedTime {
				if fileExists(targetPath) {
					downloaded = true
				}
			}
			if !downloaded {
				if err := s.downloadDriveFile(ctx, dashboardID, entry.ID, targetPath); err != nil {
					entry.CacheStatus = "skipped_unsupported"
					entry.Placeholder = "Failed to download drive file."
				} else {
					downloaded = true
				}
			}
		}

		if entry.CacheStatus != "cached" || !downloaded {
			if err := writePlaceholder(targetPath, entry.Placeholder); err != nil {
				continue
			}
		}

		workspaceSyncedFiles += 1
		if entry.CacheStatus == "cached" && downloaded {
			workspaceSyncedBytes += entry.Size
		}
		s.reportDriveProgress(ctx, dashboardID, workspaceSyncedFiles, workspaceSyncedBytes, "syncing_workspace", "")
	}

	for id, entry := range oldEntries {
		if _, ok := newEntries[id]; ok {
			continue
		}
		targetPath := filepath.Join(root, filepath.FromSlash(entry.Path))
		if pathWithinRoot(root, targetPath) {
			os.Remove(targetPath)
		}
	}

	if err := writeLocalManifest(filepath.Join(root, driveManifestFile), manifest); err != nil {
		log.Printf("drive manifest write failed: %v", err)
	}

	s.reportDriveProgress(ctx, dashboardID, workspaceSyncedFiles, workspaceSyncedBytes, "ready", "")
	return nil
}

func (s *Server) downloadDriveFile(ctx context.Context, dashboardID, fileID, targetPath string) error {
	body, _, err := s.driveMirror.FetchFile(ctx, dashboardID, fileID)
	if err != nil {
		return err
	}
	defer body.Close()

	tmpPath := targetPath + ".orcabot.tmp"
	tmpFile, err := os.Create(tmpPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(tmpFile, body); err != nil {
		tmpFile.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmpFile.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return os.Rename(tmpPath, targetPath)
}

func (s *Server) reportDriveProgress(ctx context.Context, dashboardID string, files int, bytes int64, status string, errMsg string) {
	payload := map[string]interface{}{
		"dashboardId":          dashboardID,
		"workspaceSyncedFiles": files,
		"workspaceSyncedBytes": bytes,
		"status":               status,
	}
	if errMsg != "" {
		payload["syncError"] = errMsg
	}
	if err := s.driveMirror.ReportProgress(ctx, payload); err != nil {
		log.Printf("drive progress update failed: %v", err)
	}
}

func (s *Server) reportDriveError(ctx context.Context, dashboardID string, err error) {
	msg := "Drive sync failed"
	if err != nil {
		msg = err.Error()
	}
	s.reportDriveProgress(ctx, dashboardID, 0, 0, "error", msg)
}

func pathWithinRoot(root, target string) bool {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	if root == target {
		return true
	}
	return strings.HasPrefix(target, root+string(os.PathSeparator))
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func writePlaceholder(path string, message string) error {
	if message == "" {
		message = "Drive file not synced. Use OrcaBot to sync this file."
	}
	return os.WriteFile(path, []byte(message+"\n"), 0644)
}

func readLocalManifest(path string) (*drive.Manifest, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return &drive.Manifest{}, err
	}
	var manifest drive.Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return &drive.Manifest{}, err
	}
	return &manifest, nil
}

func writeLocalManifest(path string, manifest *drive.Manifest) error {
	data, err := json.Marshal(manifest)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
