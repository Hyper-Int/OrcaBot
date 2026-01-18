// Copyright 2026 Robert Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package drive

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
)

type ManifestEntry struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Path         string `json:"path"`
	MimeType     string `json:"mimeType"`
	Size         int64  `json:"size"`
	ModifiedTime string `json:"modifiedTime"`
	Md5Checksum  string `json:"md5Checksum"`
	CacheStatus  string `json:"cacheStatus"`
	Placeholder  string `json:"placeholder"`
}

type Manifest struct {
	Version    int           `json:"version"`
	FolderID   string        `json:"folderId"`
	FolderName string        `json:"folderName"`
	FolderPath string        `json:"folderPath"`
	UpdatedAt  string        `json:"updatedAt"`
	Directories []string     `json:"directories"`
	Entries    []ManifestEntry `json:"entries"`
}

type Mirror struct {
	baseURL string
	token   string
	client  *http.Client
}

func NewMirrorFromEnv() *Mirror {
	baseURL := strings.TrimSuffix(os.Getenv("CONTROLPLANE_URL"), "/")
	token := os.Getenv("INTERNAL_API_TOKEN")
	return &Mirror{
		baseURL: baseURL,
		token:   token,
		client:  &http.Client{},
	}
}

func (m *Mirror) Enabled() bool {
	return m.baseURL != "" && m.token != ""
}

func (m *Mirror) FetchManifest(ctx context.Context, dashboardID string) (*Manifest, error) {
	if !m.Enabled() {
		return nil, errors.New("drive mirror not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.baseURL+"/internal/drive/manifest?dashboard_id="+dashboardID, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Internal-Token", m.token)

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("failed to fetch manifest")
	}

	var manifest Manifest
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		return nil, err
	}
	return &manifest, nil
}

func (m *Mirror) FetchFile(ctx context.Context, dashboardID, fileID string) (io.ReadCloser, http.Header, error) {
	if !m.Enabled() {
		return nil, nil, errors.New("drive mirror not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.baseURL+"/internal/drive/file?dashboard_id="+dashboardID+"&file_id="+fileID, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("X-Internal-Token", m.token)

	resp, err := m.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, nil, errors.New("failed to fetch drive file")
	}

	return resp.Body, resp.Header, nil
}

func (m *Mirror) ReportProgress(ctx context.Context, payload map[string]interface{}) error {
	if !m.Enabled() {
		return errors.New("drive mirror not configured")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.baseURL+"/internal/drive/sync/progress", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("X-Internal-Token", m.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New("failed to report drive progress")
	}
	return nil
}
