// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: agent-link-v1-device-client

package agentlink

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// The test binary doubles as a fake client (the hub's siren-stdio): run with the
// client's flags, it pairs, then answers each "say" to an agent with a reply from it.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "--server" {
		fakeClient()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakeClient() {
	out := json.NewEncoder(os.Stdout)
	_ = out.Encode(map[string]any{"ev": "pairing", "code": "ABCD-EFGH", "link": "x", "expires_in": 600})
	time.Sleep(100 * time.Millisecond)
	_ = out.Encode(map[string]any{"ev": "ready", "identity": "orca:o/device:dash-1"})
	chats := map[string]string{}
	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		var op map[string]any
		if json.Unmarshal(sc.Bytes(), &op) != nil {
			continue
		}
		switch op["op"] {
		case "chat":
			with, _ := op["with"].(string)
			chats["chat-"+with] = with
			_ = out.Encode(map[string]any{"ev": "chat", "ref": op["ref"], "chat": "chat-" + with, "with": with})
		case "say":
			chat, _ := op["chat"].(string)
			text, _ := op["text"].(string)
			_ = out.Encode(map[string]any{"ev": "sent", "ref": op["ref"], "chat": chat, "id": "m1"})
			if strings.Contains(text, "fail") {
				continue
			}
			_ = out.Encode(map[string]any{"ev": "message", "chat": chat, "sender": chats[chat], "text": "re: " + text})
			// Someone else's message in the chat is not the agent's.
			_ = out.Encode(map[string]any{"ev": "message", "chat": chat, "sender": "orca:o/device:other", "text": "noise"})
		}
	}
}

type fakeCP struct {
	mu       sync.Mutex
	enabled  bool
	approved []string
	agents   []Agent
	asked    int
}

func (f *fakeCP) Config(context.Context, string) (Config, error) {
	return Config{Enabled: f.enabled, HubURL: "http://hub.test", Device: "dash-1"}, nil
}

func (f *fakeCP) ApproveDevice(_ context.Context, _ string, code string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.approved = append(f.approved, code)
	return nil
}

func (f *fakeCP) TerminalAgents(_ context.Context, _ string, ptyID string) ([]Agent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked++
	if ptyID == "pty-connected" {
		return f.agents, nil
	}
	return nil, nil
}

func newTestManager(t *testing.T, cp *fakeCP) (*Manager, string) {
	t.Helper()
	dir := t.TempDir()
	m := NewManager(cp, os.Args[0], dir)
	m.runAs = nil // the tests run unprivileged
	t.Cleanup(m.Close)
	return m, dir
}

const grok = "orca:o/agent:grok"

func TestPairsAsDeviceThenChats(t *testing.T) {
	cp := &fakeCP{enabled: true}
	m, _ := newTestManager(t, cp)
	link := m.Link("dash-1")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := link.WaitReady(ctx); err != nil {
		t.Fatalf("not ready: %v", err)
	}
	time.Sleep(50 * time.Millisecond)
	cp.mu.Lock()
	approved := fmt.Sprint(cp.approved)
	cp.mu.Unlock()
	if approved != "[ABCD-EFGH]" {
		t.Fatalf("device code not approved through the control plane: %s", approved)
	}

	sent, err := link.Send(ctx, grok, "hello")
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	msgs := link.Messages(ctx, grok, sent.Seq, 5*time.Second) // waits for the reply
	if len(msgs) != 1 || msgs[0].From != "agent" || msgs[0].Text != "re: hello" {
		t.Fatalf("expected the agent's reply only, got %+v", msgs)
	}
	all := link.Messages(ctx, grok, 0, 0)
	if len(all) != 2 || all[0].From != "me" {
		t.Fatalf("expected my message and the reply, got %+v", all)
	}
	// A second message reuses the chat.
	if _, err := link.Send(ctx, grok, "again"); err != nil {
		t.Fatalf("second send: %v", err)
	}
	if got := link.chats[grok]; got != "chat-"+grok {
		t.Fatalf("chat not remembered: %q", got)
	}
}

func TestHistorySurvivesARestart(t *testing.T) {
	cp := &fakeCP{enabled: true}
	m, dir := newTestManager(t, cp)
	link := m.Link("dash-1")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = link.WaitReady(ctx)
	sent, err := link.Send(ctx, grok, "remember me")
	if err != nil {
		t.Fatal(err)
	}
	link.Messages(ctx, grok, sent.Seq, 5*time.Second)
	m.Close()

	m2 := NewManager(cp, os.Args[0], dir)
	m2.runAs = nil
	defer m2.Close()
	again := m2.Link("dash-1")
	msgs := again.Messages(ctx, grok, 0, 0)
	if len(msgs) != 2 || msgs[0].Text != "remember me" {
		t.Fatalf("history lost: %+v", msgs)
	}
	if again.chats[grok] == "" {
		t.Fatal("chat ids lost")
	}
}

func TestDisabledWithoutAHub(t *testing.T) {
	m, _ := newTestManager(t, &fakeCP{enabled: false})
	link := m.Link("dash-1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := link.WaitReady(ctx)
	if err == nil || !strings.Contains(err.Error(), "isn't set up") {
		t.Fatalf("expected disabled, got %v", err)
	}
	if _, err := link.Send(ctx, grok, "hi"); err == nil {
		t.Fatal("sending without a hub should fail")
	}
}

func TestTerminalsOnlyReachConnectedAgents(t *testing.T) {
	cp := &fakeCP{enabled: true, agents: []Agent{{Identity: grok, Name: "grok", ItemID: "i1"}}}
	m, _ := newTestManager(t, cp)
	ctx := context.Background()
	for _, name := range []string{grok, "grok"} {
		if a, ok, err := m.Allowed(ctx, "dash-1", "pty-connected", name); err != nil || !ok || a.Identity != grok {
			t.Fatalf("%s: expected allowed, got %v %v %v", name, a, ok, err)
		}
	}
	if _, ok, _ := m.Allowed(ctx, "dash-1", "pty-connected", "orca:o/agent:muse"); ok {
		t.Fatal("an agent the terminal isn't connected to must be refused")
	}
	if _, ok, _ := m.Allowed(ctx, "dash-1", "pty-other", "grok"); ok {
		t.Fatal("another terminal must be refused")
	}
	asked := cp.asked
	_, _, _ = m.Allowed(ctx, "dash-1", "pty-connected", "grok")
	if cp.asked != asked {
		t.Fatal("expected the answer to be cached briefly")
	}
}

func TestSendValidates(t *testing.T) {
	m, _ := newTestManager(t, &fakeCP{enabled: true})
	link := m.Link("dash-1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := link.Send(ctx, "not-an-agent", "hi"); err == nil {
		t.Fatal("non-agent identities must be refused")
	}
	if _, err := link.Send(ctx, grok, "  "); err == nil {
		t.Fatal("empty messages must be refused")
	}
}
