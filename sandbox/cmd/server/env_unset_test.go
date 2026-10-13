// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: env-v3-unset-broker-base-urls
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUnsetBuiltinKeyDropsBrokerBaseURL(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	os.WriteFile(path, []byte(strings.Join([]string{
		`export ANTHROPIC_API_KEY="dummy"`,
		`export ANTHROPIC_BASE_URL="http://127.0.0.1:8082/broker/s1/anthropic"`,
		`export OPENAI_API_KEY="dummy"`,
		`export OPENAI_BASE_URL="http://127.0.0.1:8082/broker/s1/openai"`,
		`export MY_KEY="dummy"`,
		`export MY_KEY_BROKER="http://127.0.0.1:8082/broker/s1/custom/MY_KEY"`,
	}, "\n")), 0o644)

	// ANTHROPIC and the custom key are removed; OPENAI is still applied.
	set := map[string]string{"OPENAI_API_KEY": "dummy", "OPENAI_BASE_URL": "http://127.0.0.1:8082/broker/s1/openai"}
	unset := withBrokerEnvKeys([]string{"ANTHROPIC_API_KEY", "MY_KEY", "MY_KEY_BROKER"}, set)
	if err := updateDоtEnv(path, set, unset); err != nil {
		t.Fatal(err)
	}
	out, _ := os.ReadFile(path)
	got := string(out)
	for _, gone := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "MY_KEY"} {
		if strings.Contains(got, gone) {
			t.Errorf("%s left in .env:\n%s", gone, got)
		}
	}
	if !strings.Contains(got, "OPENAI_BASE_URL") {
		t.Errorf("OPENAI_BASE_URL removed:\n%s", got)
	}
}

func TestUnsetKeepsBaseURLSetInSameRequest(t *testing.T) {
	// The user's own ANTHROPIC_BASE_URL env var, sent alongside the unset.
	unset := withBrokerEnvKeys([]string{"ANTHROPIC_API_KEY"}, map[string]string{"ANTHROPIC_BASE_URL": "https://proxy.example"})
	for _, k := range unset {
		if k == "ANTHROPIC_BASE_URL" {
			t.Fatal("base URL set in the same request was unset")
		}
	}
}
