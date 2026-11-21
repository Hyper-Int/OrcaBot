// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: gemini-approve-v1-allow-once

// Package geminiapprove answers Gemini CLI's "Untrusted Command Flags" prompt with
// "Allow once", for terminals whose Auto-approve flagged commands setting is on.
//
// Gemini CLI (0.68+) marks every tool output as untrusted. Before running a shell
// command that reuses a path, URL or flag value from that output, it asks for
// approval with a "CRITICAL SECURITY WARNING: Untrusted Command Flags Detected"
// dialog. It checks that before --yolo, and no setting turns it off, so an unattended
// Gemini (a benchmark seat) can wait for hours on a prompt nobody sees.
//
// The dialog's options are "1. Allow once" (selected) and "No, suggest changes (esc)",
// so approving is pressing Enter. The watcher reads the terminal's output as users see
// it, and presses Enter once the dialog has been drawn and the output has gone quiet.
// It only fires on that dialog: all of its marker phrases must be in the recent output.
package geminiapprove

import (
	"log"
	"strings"
	"sync"
	"time"
)

const Revision = "gemini-approve-v1-allow-once"

func init() {
	log.Printf("[gemini-approve] REVISION: %s loaded at %s", Revision, time.Now().Format(time.RFC3339))
}

// The dialog's phrases, lowercased with everything but letters and digits removed, so
// colour codes, cursor moves, line wrapping and the dialog's border don't matter.
var markers = []string{
	"untrustedcommandflagsdetected", // the warning title
	"allowexecutionof",              // the question
	"allowonce",                     // option 1 (selected)
	"nosuggestchangesesc",           // the other option
}

const (
	windowMax = 16 * 1024              // normalized recent output kept
	settle    = 400 * time.Millisecond // output quiet this long = the dialog is drawn
)

// Terminal is the part of a PTY hub the watcher needs.
type Terminal interface {
	WriteSystem(data []byte) (int, error)
}

// Watcher watches one terminal. Feed it output with Observe; Stop it with the terminal.
type Watcher struct {
	term  Terminal
	ptyID string
	now   func() time.Time

	mu      sync.Mutex
	window  []byte // normalized recent output
	carry   []byte // an escape sequence cut off at the end of the last chunk
	pending bool   // the dialog is in the window, not yet answered
	timer   *time.Timer
	stopped bool

	approvals int
}

// New returns a watcher for the terminal; ptyID is for the logs.
func New(term Terminal, ptyID string) *Watcher {
	log.Printf("[gemini-approve] pty=%s: auto-approving Gemini's untrusted-flags prompts", ptyID)
	return &Watcher{term: term, ptyID: ptyID, now: time.Now}
}

// Observe takes a chunk of the terminal's output. Cheap; never blocks on the terminal.
func (w *Watcher) Observe(data []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return
	}
	if len(w.carry) > 0 {
		data = append(append([]byte{}, w.carry...), data...)
	}
	var norm []byte
	norm, w.carry = normalize(data)
	if len(norm) > 0 {
		w.window = append(w.window, norm...)
		if len(w.window) > windowMax {
			w.window = append(w.window[:0], w.window[len(w.window)-windowMax:]...)
		}
		if !w.pending && hasDialog(w.window) {
			w.pending = true
		}
	}
	if w.pending {
		// Wait for the output to go quiet: the dialog is fully drawn and taking keys.
		if w.timer == nil {
			w.timer = time.AfterFunc(settle, w.fire)
		} else {
			w.timer.Reset(settle)
		}
	}
}

func (w *Watcher) fire() {
	w.mu.Lock()
	if w.stopped || !w.pending {
		w.mu.Unlock()
		return
	}
	// Answered: forget this dialog. If Gemini draws one again, it's a new prompt.
	w.pending = false
	w.window = w.window[:0]
	w.approvals++
	n := w.approvals
	w.mu.Unlock()

	if _, err := w.term.WriteSystem([]byte("\r")); err != nil {
		log.Printf("[gemini-approve] pty=%s: E79772 couldn't answer the untrusted-flags prompt: %v", w.ptyID, err)
		return
	}
	log.Printf("[gemini-approve] pty=%s: answered Gemini's untrusted-flags prompt with \"Allow once\" (#%d)", w.ptyID, n)
}

// Approvals is how many prompts the watcher has answered.
func (w *Watcher) Approvals() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.approvals
}

// Stop ends the watcher (the terminal is gone).
func (w *Watcher) Stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopped = true
	if w.timer != nil {
		w.timer.Stop()
	}
}

func hasDialog(window []byte) bool {
	s := string(window)
	// The warning title starts the dialog; its question and options follow it.
	i := strings.LastIndex(s, markers[0])
	if i < 0 {
		return false
	}
	rest := s[i:]
	for _, m := range markers[1:] {
		if !strings.Contains(rest, m) {
			return false
		}
	}
	return true
}

// normalize drops escape sequences, then keeps only ASCII letters (lowercased) and
// digits, so the dialog's words match however the terminal drew them. An escape
// sequence cut off at the end comes back as rest, to go in front of the next chunk.
func normalize(data []byte) (out, rest []byte) {
	out = make([]byte, 0, len(data))
	for i := 0; i < len(data); i++ {
		c := data[i]
		if c == 0x1b {
			start := i
			if i+1 >= len(data) {
				return out, cut(data[start:])
			}
			switch data[i+1] {
			case '[': // CSI: ESC [ params final(0x40-0x7e)
				i += 2
				for i < len(data) && (data[i] < 0x40 || data[i] > 0x7e) {
					i++
				}
				if i >= len(data) {
					return out, cut(data[start:])
				}
				continue
			case ']': // OSC: until BEL or ESC \
				i += 2
				for i < len(data) && data[i] != 0x07 && !(data[i] == 0x1b && i+1 < len(data) && data[i+1] == '\\') {
					i++
				}
				if i >= len(data) || (data[i] == 0x1b && i+1 >= len(data)) {
					return out, cut(data[start:])
				}
				if data[i] == 0x1b {
					i++
				}
				continue
			default:
				i++ // two-byte escape
				continue
			}
		}
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			out = append(out, c)
		case c >= 'A' && c <= 'Z':
			out = append(out, c+('a'-'A'))
		}
	}
	return out, nil
}

// cut keeps an unfinished escape sequence for the next chunk, unless it's so long it
// isn't one (then it's dropped, like the rest of the sequence would have been).
func cut(seq []byte) []byte {
	if len(seq) > 256 {
		return nil
	}
	return append([]byte{}, seq...)
}
