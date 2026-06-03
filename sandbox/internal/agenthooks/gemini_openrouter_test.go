// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package agenthooks

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSetAndClearGeminiOpenRouterAuth(t *testing.T) {
	dir := t.TempDir()

	if err := SetGeminiOpenRouterAuth(dir); err != nil {
		t.Fatalf("SetGeminiOpenRouterAuth: %v", err)
	}

	auth := readAuth(t, dir)
	if auth["selectedType"] != "gateway" {
		t.Errorf("selectedType = %v, want gateway", auth["selectedType"])
	}
	if auth["useExternal"] != true {
		t.Errorf("useExternal = %v, want true", auth["useExternal"])
	}

	// Clearing must remove both fields so native auth resumes.
	if err := ClearGeminiOpenRouterAuth(dir); err != nil {
		t.Fatalf("ClearGeminiOpenRouterAuth: %v", err)
	}
	auth = readAuth(t, dir)
	if _, ok := auth["selectedType"]; ok {
		t.Errorf("selectedType should be removed, got %v", auth["selectedType"])
	}
	if _, ok := auth["useExternal"]; ok {
		t.Errorf("useExternal should be removed, got %v", auth["useExternal"])
	}
}

func TestSetGeminiOpenRouterAuth_PreservesOtherSettings(t *testing.T) {
	dir := t.TempDir()
	// Pre-seed an unrelated setting (as mergeGeminiHookSettings would).
	path := geminiSystemSettingsPath(dir)
	_ = writeGeminiSettings(path, map[string]interface{}{
		"ui": map[string]interface{}{"showHomeDirectoryWarning": false},
	})

	if err := SetGeminiOpenRouterAuth(dir); err != nil {
		t.Fatalf("SetGeminiOpenRouterAuth: %v", err)
	}

	settings := readGeminiSettings(path)
	if _, ok := settings["ui"]; !ok {
		t.Errorf("existing ui settings were dropped: %+v", settings)
	}
}

func readAuth(t *testing.T, dir string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(geminiSystemSettingsPath(dir))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	var s map[string]interface{}
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	sec, _ := s["security"].(map[string]interface{})
	auth, _ := sec["auth"].(map[string]interface{})
	if auth == nil {
		return map[string]interface{}{}
	}
	return auth
}
