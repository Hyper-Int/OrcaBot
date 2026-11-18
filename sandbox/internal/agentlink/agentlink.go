// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: agent-link-v2-status-detail

// Package agentlink connects a dashboard to the outside AI agents its owner has
// linked (Agent blocks): Grok Bot, Muse, Dots, Claude Code, Codex, ... running on
// their own computers.
//
// Messages to and from those agents are end-to-end encrypted (MLS) and relayed by
// an agent hub. Each dashboard runs one client (the hub's `siren-stdio`, shipped as
// orcabot-agent-link) that drives one hub identity over JSON lines: a **linked
// device of the dashboard owner**. The client makes its own keys and asks the hub
// for a pairing code; the control plane approves it (only for this dashboard's
// device name), and the device token goes straight from the hub to the client. To
// the agents, this device *is* their owner, so its messages wake them.
//
// The client runs as its own OS user (orcabot-agentlink) when that user exists,
// with its state outside /workspace in a 0700 directory, so terminals (pool UIDs)
// can't read its keys and speak as the owner. Terminals reach agents only through
// the sandbox server, and only agents their canvas item has an edge to (the
// control plane decides, from D1 edges).
package agentlink

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const Revision = "agent-link-v2-status-detail"

func init() {
	log.Printf("[agentlink] REVISION: %s loaded at %s", Revision, time.Now().Format(time.RFC3339))
}

// Config is what the control plane tells a dashboard's client.
type Config struct {
	Enabled bool   `json:"enabled"`
	HubURL  string `json:"hubUrl"`
	Device  string `json:"device"`
}

// Agent is an outside agent a terminal is connected to by an edge.
type Agent struct {
	Identity string `json:"identity"`
	Name     string `json:"name"`
	ItemID   string `json:"itemId"`
}

// Message is one message in a dashboard's chat with an agent.
type Message struct {
	Seq   int64  `json:"seq"`
	Agent string `json:"agent"`
	From  string `json:"from"` // "me" | "agent"
	Text  string `json:"text"`
	Ts    int64  `json:"ts"`
}

// ControlPlane is the part of the control plane the client needs.
type ControlPlane interface {
	Config(ctx context.Context, dashboardID string) (Config, error)
	ApproveDevice(ctx context.Context, dashboardID, code string) error
	TerminalAgents(ctx context.Context, dashboardID, ptyID string) ([]Agent, error)
}

// Manager owns one Link per dashboard (desktop runs several dashboards in one VM).
type Manager struct {
	cp        ControlPlane
	bin       string
	stateRoot string
	runAs     *syscall.Credential

	mu    sync.Mutex
	links map[string]*Link

	agentsMu    sync.Mutex
	agentsCache map[string]cachedAgents
}

type cachedAgents struct {
	at     time.Time
	agents []Agent
}

// RunAsUser is the OS user the client runs as when it exists.
const RunAsUser = "orcabot-agentlink"

// NewManager. bin is the client binary; stateRoot holds one 0700 dir per dashboard.
func NewManager(cp ControlPlane, bin, stateRoot string) *Manager {
	m := &Manager{cp: cp, bin: bin, stateRoot: stateRoot, links: map[string]*Link{}, agentsCache: map[string]cachedAgents{}}
	if u, err := user.Lookup(RunAsUser); err == nil && os.Geteuid() == 0 {
		uid, _ := strconv.Atoi(u.Uid)
		gid, _ := strconv.Atoi(u.Gid)
		m.runAs = &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}
	}
	return m
}

// Link returns the dashboard's link, starting its client on first use.
func (m *Manager) Link(dashboardID string) *Link {
	m.mu.Lock()
	defer m.mu.Unlock()
	if l, ok := m.links[dashboardID]; ok {
		return l
	}
	sum := sha256.Sum256([]byte(dashboardID))
	l := &Link{
		m: m, dashboardID: dashboardID,
		dir:     filepath.Join(m.stateRoot, hex.EncodeToString(sum[:8])),
		status:  "connecting",
		chats:   map[string]string{},
		chatOf:  map[string]string{},
		waiters: map[string]chan map[string]any{},
		notify:  make(chan struct{}),
		stop:    make(chan struct{}),
	}
	l.load()
	m.links[dashboardID] = l
	go l.run()
	return l
}

// Close stops every client.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, l := range m.links {
		l.close()
		delete(m.links, id)
	}
}

// TerminalAgents: the agents a terminal may use (edges to Agent blocks), cached briefly.
func (m *Manager) TerminalAgents(ctx context.Context, dashboardID, ptyID string) ([]Agent, error) {
	key := dashboardID + "\x00" + ptyID
	m.agentsMu.Lock()
	c, ok := m.agentsCache[key]
	m.agentsMu.Unlock()
	if ok && time.Since(c.at) < 10*time.Second {
		return c.agents, nil
	}
	agents, err := m.cp.TerminalAgents(ctx, dashboardID, ptyID)
	if err != nil {
		return nil, err
	}
	m.agentsMu.Lock()
	m.agentsCache[key] = cachedAgents{at: time.Now(), agents: agents}
	m.agentsMu.Unlock()
	return agents, nil
}

// Allowed: the agent the terminal named, if it's connected to it.
func (m *Manager) Allowed(ctx context.Context, dashboardID, ptyID, agent string) (Agent, bool, error) {
	agents, err := m.TerminalAgents(ctx, dashboardID, ptyID)
	if err != nil {
		return Agent{}, false, err
	}
	for _, a := range agents {
		if a.Identity == agent || a.Name == agent {
			return a, true, nil
		}
	}
	return Agent{}, false, nil
}

// Link is one dashboard's connection to the hub.
type Link struct {
	m           *Manager
	dashboardID string
	dir         string

	mu      sync.Mutex
	status  string // connecting | pairing | ready | disabled | error
	detail  string
	stdin   io.WriteCloser
	proc    *exec.Cmd
	chats   map[string]string // agent identity -> chat id (where we write to it)
	chatOf  map[string]string // chat id -> agent identity
	msgs    []Message
	seq     int64
	waiters map[string]chan map[string]any
	refN    int
	notify  chan struct{} // closed and replaced on every new message or status change
	stop    chan struct{}
	closed  bool
}

// Status of the link: connecting | pairing | ready | disabled | error, and a detail.
func (l *Link) Status() (string, string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.status, l.detail
}

// brief keeps a status detail short enough to show in the Agent block.
func brief(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 240 {
		s = s[:240] + "…"
	}
	return s
}

func (l *Link) setStatus(status, detail string) {
	l.mu.Lock()
	l.status, l.detail = status, detail
	l.bumpLocked()
	l.mu.Unlock()
}

func (l *Link) bumpLocked() {
	close(l.notify)
	l.notify = make(chan struct{})
}

func (l *Link) close() {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	close(l.stop)
	proc := l.proc
	l.mu.Unlock()
	if proc != nil && proc.Process != nil {
		_ = syscall.Kill(-proc.Process.Pid, syscall.SIGTERM)
	}
}

// --- persistence (the client's own MLS state is in dir too) ------------------------

func (l *Link) load() {
	if data, err := os.ReadFile(filepath.Join(l.dir, "chats.json")); err == nil {
		_ = json.Unmarshal(data, &l.chats)
		for a, c := range l.chats {
			l.chatOf[c] = a
		}
	}
	if f, err := os.Open(filepath.Join(l.dir, "messages.jsonl")); err == nil {
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for sc.Scan() {
			var msg Message
			if json.Unmarshal(sc.Bytes(), &msg) == nil {
				l.msgs = append(l.msgs, msg)
				if msg.Seq > l.seq {
					l.seq = msg.Seq
				}
			}
		}
		f.Close()
		// The file is in arrival order; a reply can land before the "sent" it answers.
		sort.SliceStable(l.msgs, func(i, j int) bool { return l.msgs[i].Seq < l.msgs[j].Seq })
	}
}

func (l *Link) saveChatsLocked() {
	data, _ := json.Marshal(l.chats)
	_ = os.WriteFile(filepath.Join(l.dir, "chats.json"), data, 0o600)
}

func (l *Link) appendLocked(agent, from, text string) Message {
	l.seq++
	return l.appendSeqLocked(l.seq, agent, from, text)
}

// appendSeqLocked records a message under a seq reserved earlier (kept in seq order),
// so a reply that arrives before the send returns still sorts after it.
func (l *Link) appendSeqLocked(seq int64, agent, from, text string) Message {
	msg := Message{Seq: seq, Agent: agent, From: from, Text: text, Ts: time.Now().UnixMilli()}
	i := len(l.msgs)
	for i > 0 && l.msgs[i-1].Seq > seq {
		i--
	}
	l.msgs = append(l.msgs, Message{})
	copy(l.msgs[i+1:], l.msgs[i:])
	l.msgs[i] = msg
	if len(l.msgs) > 5000 {
		l.msgs = l.msgs[len(l.msgs)-5000:]
	}
	if f, err := os.OpenFile(filepath.Join(l.dir, "messages.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		line, _ := json.Marshal(msg)
		_, _ = f.Write(append(line, '\n'))
		f.Close()
	}
	l.bumpLocked()
	return msg
}

// --- the client process -------------------------------------------------------------

func (l *Link) prepareDir() error {
	if err := os.MkdirAll(l.dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(l.dir, 0o700); err != nil {
		return err
	}
	if l.m.runAs != nil {
		_ = filepath.Walk(l.dir, func(p string, _ os.FileInfo, err error) error {
			if err == nil {
				_ = os.Lchown(p, int(l.m.runAs.Uid), int(l.m.runAs.Gid))
			}
			return nil
		})
	}
	return nil
}

func (l *Link) run() {
	backoff := 2 * time.Second
	for {
		select {
		case <-l.stop:
			return
		default:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		cfg, err := l.m.cp.Config(ctx, l.dashboardID)
		cancel()
		switch {
		case err != nil:
			// Logged every try (backoff caps it at about one a minute): without this a VM
			// pointed at the wrong control plane fails silently.
			log.Printf("[agentlink] dashboard %s: control plane config: %v", l.dashboardID, err)
			l.setStatus("error", "couldn't get settings from the control plane: "+brief(err.Error()))
		case !cfg.Enabled:
			log.Printf("[agentlink] dashboard %s: agent linking isn't configured on the control plane", l.dashboardID)
			l.setStatus("disabled", "agent linking isn't set up on this Orcabot")
			backoff = 5 * time.Minute
		default:
			started := time.Now()
			if err := l.runClient(cfg); err != nil {
				log.Printf("[agentlink] dashboard %s: client: %v", l.dashboardID, err)
				l.setStatus("error", err.Error())
			}
			if time.Since(started) > time.Minute {
				backoff = 2 * time.Second
			}
		}
		select {
		case <-l.stop:
			return
		case <-time.After(backoff):
		}
		if backoff < time.Minute {
			backoff *= 2
		}
	}
}

func (l *Link) runClient(cfg Config) error {
	if err := l.prepareDir(); err != nil {
		return fmt.Errorf("state dir: %w", err)
	}
	cmd := exec.Command(l.m.bin, "--server", cfg.HubURL, "--state", filepath.Join(l.dir, "client"),
		"--device", cfg.Device, "--label", "Orcabot dashboard", "--name", "Orcabot")
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "HOME=" + l.dir}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: l.m.runAs}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = &prefixLog{prefix: "[agentlink:" + short(l.dashboardID) + "] "}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", l.m.bin, err)
	}
	l.mu.Lock()
	l.proc, l.stdin = cmd, stdin
	l.status, l.detail = "connecting", ""
	l.bumpLocked()
	l.mu.Unlock()

	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for sc.Scan() {
		var ev map[string]any
		if json.Unmarshal(sc.Bytes(), &ev) == nil {
			l.handle(ev)
		}
	}
	err = cmd.Wait()
	l.mu.Lock()
	l.proc, l.stdin = nil, nil
	for ref, ch := range l.waiters {
		ch <- map[string]any{"ev": "error", "error": "the agent link restarted"}
		delete(l.waiters, ref)
	}
	l.mu.Unlock()
	if err != nil {
		return fmt.Errorf("client exited: %w", err)
	}
	return errors.New("client exited")
}

func (l *Link) handle(ev map[string]any) {
	str := func(k string) string { s, _ := ev[k].(string); return s }
	switch str("ev") {
	case "pairing":
		l.setStatus("pairing", "")
		code := str("code")
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			if err := l.m.cp.ApproveDevice(ctx, l.dashboardID, code); err != nil {
				log.Printf("[agentlink] dashboard %s: approving the device failed: %v", l.dashboardID, err)
				l.setStatus("error", "couldn't link this dashboard to your agents")
			}
		}()
	case "ready":
		l.setStatus("ready", "")
		log.Printf("[agentlink] dashboard %s: ready as %s", l.dashboardID, str("identity"))
	case "message":
		chat, sender, text := str("chat"), str("sender"), str("text")
		l.mu.Lock()
		agent := l.chatOf[chat]
		if agent == "" && strings.Contains(sender, "/agent:") {
			agent = sender
			l.chatOf[chat] = agent
			if _, ok := l.chats[agent]; !ok {
				l.chats[agent] = chat
				l.saveChatsLocked()
			}
		}
		if agent != "" && sender == agent {
			l.appendLocked(agent, "agent", text)
		}
		l.mu.Unlock()
	case "joined", "members":
		// An agent started a chat with its owner (us): remember it as that agent's.
		members, _ := ev["members"].([]any)
		l.mu.Lock()
		for _, mm := range members {
			if s, _ := mm.(string); strings.Contains(s, "/agent:") {
				l.chatOf[str("chat")] = s
				if _, ok := l.chats[s]; !ok {
					l.chats[s] = str("chat")
					l.saveChatsLocked()
				}
			}
		}
		l.mu.Unlock()
	default:
		if ref := str("ref"); ref != "" {
			l.mu.Lock()
			ch := l.waiters[ref]
			delete(l.waiters, ref)
			l.mu.Unlock()
			if ch != nil {
				ch <- ev
			}
		} else if str("ev") == "error" {
			log.Printf("[agentlink] dashboard %s: %s", l.dashboardID, str("error"))
		}
	}
}

// call sends one op to the client and waits for its reply (same ref).
func (l *Link) call(ctx context.Context, op map[string]any) (map[string]any, error) {
	l.mu.Lock()
	if l.stdin == nil || l.status != "ready" {
		status := l.status
		l.mu.Unlock()
		return nil, fmt.Errorf("the agent link isn't ready (%s)", status)
	}
	l.refN++
	ref := "r" + strconv.Itoa(l.refN)
	ch := make(chan map[string]any, 1)
	l.waiters[ref] = ch
	op["ref"] = ref
	line, _ := json.Marshal(op)
	_, err := l.stdin.Write(append(line, '\n'))
	l.mu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case ev := <-ch:
		if ev["ev"] == "error" {
			return nil, fmt.Errorf("%v", ev["error"])
		}
		return ev, nil
	case <-ctx.Done():
		l.mu.Lock()
		delete(l.waiters, ref)
		l.mu.Unlock()
		return nil, ctx.Err()
	}
}

// WaitReady waits up to ctx for the link to be ready.
func (l *Link) WaitReady(ctx context.Context) error {
	for {
		l.mu.Lock()
		status, notify := l.status, l.notify
		l.mu.Unlock()
		switch status {
		case "ready":
			return nil
		case "disabled":
			return errors.New("agent linking isn't set up on this Orcabot")
		}
		select {
		case <-notify:
		case <-ctx.Done():
			return fmt.Errorf("the agent link isn't ready (%s)", status)
		}
	}
}

// Send a message to an agent, opening a chat with it first if there isn't one.
func (l *Link) Send(ctx context.Context, agent, text string) (Message, error) {
	if !strings.Contains(agent, "/agent:") || strings.TrimSpace(text) == "" {
		return Message{}, errors.New("an agent identity and some text are needed")
	}
	if len(text) > 48*1024 {
		return Message{}, errors.New("message too long")
	}
	if err := l.WaitReady(ctx); err != nil {
		return Message{}, err
	}
	l.mu.Lock()
	chat := l.chats[agent]
	l.mu.Unlock()
	if chat == "" {
		ev, err := l.call(ctx, map[string]any{"op": "chat", "with": agent})
		if err != nil {
			return Message{}, fmt.Errorf("couldn't open a chat with the agent: %w", err)
		}
		chat, _ = ev["chat"].(string)
		l.mu.Lock()
		l.chats[agent] = chat
		l.chatOf[chat] = agent
		l.saveChatsLocked()
		l.mu.Unlock()
	}
	// Reserve my message's seq first: the agent's reply can arrive before "sent" does.
	l.mu.Lock()
	l.seq++
	mine := l.seq
	l.mu.Unlock()
	if _, err := l.call(ctx, map[string]any{"op": "say", "chat": chat, "text": text}); err != nil {
		return Message{}, err // the seq is simply skipped
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.appendSeqLocked(mine, agent, "me", text), nil
}

// Messages with an agent after seq; with wait > 0, waits that long for one to arrive.
func (l *Link) Messages(ctx context.Context, agent string, after int64, wait time.Duration) []Message {
	deadline := time.Now().Add(wait)
	for {
		l.mu.Lock()
		var out []Message
		for _, m := range l.msgs {
			if m.Seq > after && (agent == "" || m.Agent == agent) {
				out = append(out, m)
			}
		}
		notify := l.notify
		l.mu.Unlock()
		left := time.Until(deadline)
		if len(out) > 0 || left <= 0 {
			if len(out) > 200 {
				out = out[len(out)-200:]
			}
			return out
		}
		select {
		case <-notify:
		case <-time.After(left):
		case <-ctx.Done():
			return nil
		}
	}
}

type prefixLog struct{ prefix string }

func (p *prefixLog) Write(b []byte) (int, error) {
	for _, line := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if line != "" {
			log.Print(p.prefix + line)
		}
	}
	return len(b), nil
}

func short(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}
