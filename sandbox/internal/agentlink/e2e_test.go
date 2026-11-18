// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: agent-link-v1-device-client

//go:build agentlink_e2e

// End to end against a real agent hub, with no phone anywhere: an Orcabot-issued
// owner, a real agent connector paired by code, and this package's client linked as
// the dashboard's device the way the control plane does it. Opt-in:
//
//	AGENTLINK_E2E_HUB=http://localhost:8798 AGENTLINK_E2E_SECRET=... \
//	AGENTLINK_E2E_CLIENT=/path/to/siren-stdio AGENTLINK_E2E_AGENT=+447700900001/agent:grok \
//	AGENTLINK_E2E_OWNER_TOKEN=... go test -tags agentlink_e2e -run TestE2E ./internal/agentlink/
//
// The harness script starts the hub, issues the owner, pairs the agent and runs its
// scripted brain; this test is the dashboard side.
package agentlink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// hubCP does what the control plane does, against the real hub.
type hubCP struct {
	hub, ownerToken, device, agent string
}

func (c *hubCP) call(method, path string, body any, out any) error {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, c.hub+path, rd)
	req.Header.Set("authorization", "Bearer "+c.ownerToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: %d", method, path, resp.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func (c *hubCP) Config(context.Context, string) (Config, error) {
	return Config{Enabled: true, HubURL: c.hub, Device: c.device}, nil
}

func (c *hubCP) ApproveDevice(_ context.Context, _ string, code string) error {
	code = strings.ReplaceAll(code, "-", "")
	var info struct{ Kind, Name string }
	if err := c.call("GET", "/agents/pair/info?code="+code, nil, &info); err != nil {
		return err
	}
	if info.Kind != "device" || info.Name != c.device {
		return fmt.Errorf("refused: %s %s", info.Kind, info.Name)
	}
	return c.call("POST", "/agents/pair/approve", map[string]string{"code": code, "kind": "device"}, nil)
}

func (c *hubCP) TerminalAgents(context.Context, string, string) ([]Agent, error) {
	return []Agent{{Identity: c.agent, Name: "grok"}}, nil
}

func TestE2E(t *testing.T) {
	cp := &hubCP{
		hub: os.Getenv("AGENTLINK_E2E_HUB"), ownerToken: os.Getenv("AGENTLINK_E2E_OWNER_TOKEN"),
		device: "dash-e2e", agent: os.Getenv("AGENTLINK_E2E_AGENT"),
	}
	m := NewManager(cp, os.Getenv("AGENTLINK_E2E_CLIENT"), t.TempDir())
	m.runAs = nil
	defer m.Close()
	link := m.Link("dash-e2e")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := link.WaitReady(ctx); err != nil {
		t.Fatalf("device never linked: %v", err)
	}
	t.Log("linked as the owner's device")

	// 1. Owner -> agent -> reply in the same chat.
	sent, err := link.Send(ctx, cp.agent, "hello grok")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	reply := link.Messages(ctx, cp.agent, sent.Seq, 90*time.Second)
	if len(reply) == 0 || !strings.Contains(reply[0].Text, "echo: hello grok") {
		t.Fatalf("no reply from the agent: %+v", reply)
	}
	t.Logf("agent replied: %q", reply[0].Text)

	// 2. The agent reaches its owner unprompted (notify_owner): the owner has no keys
	// of its own, so that chat is with its devices: this one.
	asked, err := link.Send(ctx, cp.agent, "please ping owner")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		for _, msg := range link.Messages(ctx, cp.agent, asked.Seq, 10*time.Second) {
			if strings.Contains(msg.Text, "hello owner") {
				t.Logf("agent reached its owner: %q", msg.Text)
				return
			}
		}
	}
	t.Fatal("the agent's message to its owner never arrived")
}
