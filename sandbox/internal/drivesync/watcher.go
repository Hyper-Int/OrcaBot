// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: drivesync-watcher-v1-initial

package drivesync

import (
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

const watcherRevision = "drivesync-watcher-v1-initial"

func init() {
	log.Printf("[drivesync-watcher] REVISION: %s loaded at %s", watcherRevision, time.Now().Format(time.RFC3339))
}

// FileEvent represents a debounced filesystem change.
type FileEvent struct {
	RelPath string         // path relative to mount directory
	AbsPath string         // absolute filesystem path
	Op      fsnotify.Op    // CREATE, WRITE, REMOVE, RENAME
	Time    time.Time
}

// Watcher wraps fsnotify with debouncing and filtering.
// It watches the Drive mount directory and emits debounced events
// for the syncer to act on.
type Watcher struct {
	mountPath string
	fsw       *fsnotify.Watcher
	events    chan FileEvent
	stop      chan struct{}
	stopped   chan struct{}

	// Debounce: per-file timer that resets on each event.
	// Only fires after 2s of quiet for that file.
	debounceMu sync.Mutex
	debounceTimers map[string]*time.Timer

	// Files currently being downloaded — skip fsnotify events for these.
	downloadingMu sync.RWMutex
	downloading   map[string]bool
}

const debounceInterval = 2 * time.Second

// NewWatcher creates a watcher for the given mount directory.
// Events are delivered on the returned channel.
func NewWatcher(mountPath string) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	w := &Watcher{
		mountPath:      mountPath,
		fsw:            fsw,
		events:         make(chan FileEvent, 100),
		stop:           make(chan struct{}),
		stopped:        make(chan struct{}),
		debounceTimers: make(map[string]*time.Timer),
		downloading:    make(map[string]bool),
	}

	return w, nil
}

// Events returns the channel of debounced file events.
func (w *Watcher) Events() <-chan FileEvent {
	return w.events
}

// Start begins watching the mount directory and all subdirectories.
func (w *Watcher) Start() error {
	// Add the mount directory itself
	if err := w.fsw.Add(w.mountPath); err != nil {
		return err
	}

	// Walk existing subdirectories and watch them too
	err := filepath.Walk(w.mountPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip errors
		}
		if info.IsDir() && path != w.mountPath {
			// Skip hidden directories
			if filepath.Base(path)[0] == '.' {
				return filepath.SkipDir
			}
			if watchErr := w.fsw.Add(path); watchErr != nil {
				log.Printf("[drivesync-watcher] failed to watch %s: %v", path, watchErr)
			}
		}
		return nil
	})
	if err != nil {
		log.Printf("[drivesync-watcher] walk error during init: %v", err)
	}

	go w.loop()
	return nil
}

// Stop shuts down the watcher.
func (w *Watcher) Stop() {
	select {
	case <-w.stop:
		return // already stopped
	default:
	}
	close(w.stop)
	w.fsw.Close()
	<-w.stopped
}

// MarkDownloading marks a file as being downloaded (suppress fsnotify events).
func (w *Watcher) MarkDownloading(relPath string) {
	w.downloadingMu.Lock()
	defer w.downloadingMu.Unlock()
	w.downloading[relPath] = true
}

// UnmarkDownloading removes the downloading flag for a file.
func (w *Watcher) UnmarkDownloading(relPath string) {
	w.downloadingMu.Lock()
	defer w.downloadingMu.Unlock()
	delete(w.downloading, relPath)
}

func (w *Watcher) isDownloading(relPath string) bool {
	w.downloadingMu.RLock()
	defer w.downloadingMu.RUnlock()
	return w.downloading[relPath]
}

func (w *Watcher) loop() {
	defer close(w.stopped)
	defer close(w.events)

	for {
		select {
		case <-w.stop:
			// Drain and cancel all pending debounce timers
			w.debounceMu.Lock()
			for _, t := range w.debounceTimers {
				t.Stop()
			}
			w.debounceTimers = nil
			w.debounceMu.Unlock()
			return

		case event, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			w.handleFSEvent(event)

		case err, ok := <-w.fsw.Errors:
			if !ok {
				return
			}
			log.Printf("[drivesync-watcher] error: %v", err)
		}
	}
}

func (w *Watcher) handleFSEvent(event fsnotify.Event) {
	absPath := event.Name

	// Compute relative path from mount
	relPath, err := filepath.Rel(w.mountPath, absPath)
	if err != nil {
		return
	}

	// Skip hidden files (e.g. .drivesync, .DS_Store)
	base := filepath.Base(absPath)
	if len(base) > 0 && base[0] == '.' {
		return
	}

	// Skip symlinks
	info, err := os.Lstat(absPath)
	if err == nil && info.Mode()&os.ModeSymlink != 0 {
		return
	}

	// If a new directory is created, start watching it
	if event.Has(fsnotify.Create) && err == nil && info != nil && info.IsDir() {
		if watchErr := w.fsw.Add(absPath); watchErr != nil {
			log.Printf("[drivesync-watcher] failed to watch new dir %s: %v", absPath, watchErr)
		}
		return // Don't emit events for directories themselves
	}

	// Skip files we're currently downloading (self-caused events)
	if w.isDownloading(relPath) {
		return
	}

	// Only care about file operations
	if !event.Has(fsnotify.Create) && !event.Has(fsnotify.Write) &&
		!event.Has(fsnotify.Remove) && !event.Has(fsnotify.Rename) {
		return
	}

	// Determine the effective operation for the debounced event.
	// REMOVE and RENAME fire immediately (no debounce needed).
	if event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename) {
		w.cancelDebounce(relPath)
		w.emitEvent(FileEvent{
			RelPath: relPath,
			AbsPath: absPath,
			Op:      event.Op,
			Time:    time.Now(),
		})
		return
	}

	// CREATE and WRITE are debounced: reset timer for this file.
	w.debounceMu.Lock()
	if t, ok := w.debounceTimers[relPath]; ok {
		t.Stop()
	}
	op := event.Op
	w.debounceTimers[relPath] = time.AfterFunc(debounceInterval, func() {
		w.debounceMu.Lock()
		delete(w.debounceTimers, relPath)
		w.debounceMu.Unlock()

		w.emitEvent(FileEvent{
			RelPath: relPath,
			AbsPath: absPath,
			Op:      op,
			Time:    time.Now(),
		})
	})
	w.debounceMu.Unlock()
}

func (w *Watcher) cancelDebounce(relPath string) {
	w.debounceMu.Lock()
	defer w.debounceMu.Unlock()
	if t, ok := w.debounceTimers[relPath]; ok {
		t.Stop()
		delete(w.debounceTimers, relPath)
	}
}

func (w *Watcher) emitEvent(event FileEvent) {
	select {
	case w.events <- event:
	case <-w.stop:
	default:
		log.Printf("[drivesync-watcher] event channel full, dropping event for %s", event.RelPath)
	}
}
