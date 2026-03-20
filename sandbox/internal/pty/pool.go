// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: pty-pool-v2-two-phase-register

package pty

import (
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const poolRevision = "pty-pool-v2-two-phase-register"

func init() {
	log.Printf("[pty-pool] REVISION: %s loaded at %s", poolRevision, time.Now().Format(time.RFC3339))
}

const (
	// PoolSize is the number of pre-created PTY OS users (pty-000…pty-099).
	PoolSize = 100

	// PoolBaseUID is the UID assigned to pty-000. UIDs are PoolBaseUID…PoolBaseUID+PoolSize-1.
	PoolBaseUID = 2000
)

// slotState tracks the lifecycle of a pool slot.
type slotState uint32

const (
	slotFree        slotState = 0
	slotAllocated   slotState = 1
	slotContaminated slotState = 2
)

// SlotEntry records the identity of an active PTY slot.
// Stored in the pool registry; looked up on every Unix socket connection via SO_PEERCRED.
type SlotEntry struct {
	UID        int
	Name       string // e.g. "pty-042"
	PTYID      string
	SessionID  string
	LeaderPID  int
	LeaderPGID int
}

// Pool manages the fixed set of pre-created PTY OS users.
// Each PTY is assigned a unique UID on creation; the slot is returned after
// verified teardown. Zero runtime user creation cost — all users exist in the image.
type Pool struct {
	states      [PoolSize]atomic.Uint32 // indexed by slot number; values are slotState
	sandboxGID  uint32                  // GID of the shared "sandbox" group

	mu          sync.RWMutex
	registry    map[int]*SlotEntry // uid → active entry

	contaminated atomic.Int32 // count of contaminated slots; growing = cleanup bug
}

var (
	globalPool *Pool
	poolOnce  sync.Once
)

// InitPool initializes the global pool. Must be called once at server startup.
// sandboxGID is the GID of the "sandbox" group that all pty-NNN users belong to.
func InitPool(sandboxGID uint32) {
	poolOnce.Do(func() {
		globalPool = &Pool{
			registry:   make(map[int]*SlotEntry),
			sandboxGID: sandboxGID,
		}
		log.Printf("[pty-pool] initialized: %d slots, UIDs %d-%d, sandbox GID %d",
			PoolSize, PoolBaseUID, PoolBaseUID+PoolSize-1, sandboxGID)
	})
}

// GetPool returns the process-wide pool singleton, or nil if InitPool has not been called.
func GetPool() *Pool {
	return globalPool
}

// SandboxGID returns the GID of the sandbox group used by this pool.
func (p *Pool) SandboxGID() uint32 {
	return p.sandboxGID
}

// Allocate claims the next free slot and returns it.
//
// IMPORTANT: Returns an error if the pool is exhausted. The caller must fail PTY creation
// hard in this case — there is no fallback UID. Falling back to a shared UID would break
// the iptables UID-range enforcement and the Unix socket auth model.
func (p *Pool) Allocate() (*SlotEntry, error) {
	for i := 0; i < PoolSize; i++ {
		if p.states[i].CompareAndSwap(uint32(slotFree), uint32(slotAllocated)) {
			entry := &SlotEntry{
				UID:  PoolBaseUID + i,
				Name: fmt.Sprintf("pty-%03d", i),
			}
			log.Printf("[pty-pool] Allocated slot %d (uid %d)", i, entry.UID)
			return entry, nil
		}
	}
	n := p.contaminated.Load()
	return nil, fmt.Errorf(
		"pty pool exhausted: all %d slots in use or contaminated (%d contaminated); PTY creation cannot proceed",
		PoolSize, n,
	)
}

// Claim registers a slot in the auth registry BEFORE the PTY process is launched.
// This closes the race between process start and registry write: any privileged
// Unix socket call from the child process (however fast it starts) will find its
// entry already present. LeaderPID and LeaderPGID are zero until SetLeader is called.
// On launch failure, call Unclaim to remove the entry.
// REVISION: pty-pool-v2-two-phase-register
func (p *Pool) Claim(entry *SlotEntry, ptyID, sessionID string) {
	entry.PTYID = ptyID
	entry.SessionID = sessionID
	entry.LeaderPID = 0
	entry.LeaderPGID = 0
	p.mu.Lock()
	p.registry[entry.UID] = entry
	p.mu.Unlock()
	log.Printf("[pty-pool] Claimed slot uid=%d pty=%s session=%s (pre-launch)", entry.UID, ptyID, sessionID)
}

// Unclaim removes a claimed slot from the registry when pty.StartWithSize fails.
// Must be called if launch fails after Claim to avoid a leaked registry entry
// that would accept connections for a process that never started.
// REVISION: pty-pool-v2-two-phase-register
func (p *Pool) Unclaim(uid int) {
	p.mu.Lock()
	delete(p.registry, uid)
	p.mu.Unlock()
	log.Printf("[pty-pool] Unclaimed slot uid=%d (launch failed)", uid)
}

// SetLeader records the PID and PGID after the PTY shell has been spawned.
// Must be called immediately after pty.StartWithSize succeeds, following Claim.
// LeaderPGID is required by Release() to kill the process group on teardown.
// REVISION: pty-pool-v2-two-phase-register
func (p *Pool) SetLeader(uid, leaderPID, leaderPGID int) {
	p.mu.Lock()
	if entry, ok := p.registry[uid]; ok {
		entry.LeaderPID = leaderPID
		entry.LeaderPGID = leaderPGID
	}
	p.mu.Unlock()
	log.Printf("[pty-pool] SetLeader slot uid=%d pid=%d pgid=%d", uid, leaderPID, leaderPGID)
}

// Lookup returns the SlotEntry for an active PTY UID, or nil/false if not found.
// Called on every Unix socket connection: SO_PEERCRED uid → PTY session identity.
func (p *Pool) Lookup(uid int) (*SlotEntry, bool) {
	if uid < PoolBaseUID || uid >= PoolBaseUID+PoolSize {
		return nil, false
	}
	p.mu.RLock()
	entry, ok := p.registry[uid]
	p.mu.RUnlock()
	return entry, ok
}

// Release begins teardown of a slot after the PTY exits.
// Removes the slot from the auth registry immediately (so new connections with
// this UID are rejected), then asynchronously kills remaining processes and
// returns the slot to the pool — or marks it contaminated on failure.
func (p *Pool) Release(uid int) {
	slotIdx := uid - PoolBaseUID
	if slotIdx < 0 || slotIdx >= PoolSize {
		log.Printf("[pty-pool] Release: uid %d out of pool range", uid)
		return
	}

	// Capture PGID before removing the entry, then evict from auth registry.
	p.mu.Lock()
	var pgid int
	if entry, ok := p.registry[uid]; ok {
		pgid = entry.LeaderPGID
	}
	delete(p.registry, uid)
	p.mu.Unlock()

	log.Printf("[pty-pool] Releasing slot %d (uid %d, pgid %d)", slotIdx, uid, pgid)
	go p.teardownAndReturn(slotIdx, uid, pgid)
}

// ContaminatedCount returns the number of slots that could not be cleaned up.
// A growing count indicates a cleanup bug and should trigger an alert.
func (p *Pool) ContaminatedCount() int {
	return int(p.contaminated.Load())
}

func (p *Pool) teardownAndReturn(slotIdx, uid, pgid int) {
	// Step 1: Kill the PTY's process group, then any UID stragglers that changed group.
	if pgid > 0 {
		syscall.Kill(-pgid, syscall.SIGTERM) //nolint:errcheck
	}
	killByUID(uid, syscall.SIGTERM)

	time.Sleep(2 * time.Second)

	if pgid > 0 {
		syscall.Kill(-pgid, syscall.SIGKILL) //nolint:errcheck
	}
	killByUID(uid, syscall.SIGKILL)

	// Step 2: Poll /proc until no processes remain for this UID.
	const maxWait = 5 * time.Second
	deadline := time.Now().Add(maxWait)
	for time.Now().Before(deadline) {
		if !hasProcessesForUID(uid) {
			p.states[slotIdx].Store(uint32(slotFree))
			log.Printf("[pty-pool] Slot %d (uid %d) clean — returned to pool", slotIdx, uid)
			return
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Contaminate: slot has processes we cannot clear after the full timeout.
	p.states[slotIdx].Store(uint32(slotContaminated))
	n := p.contaminated.Add(1)
	log.Printf("[pty-pool] ALERT: slot %d (uid %d) contaminated — processes remain after timeout. Total contaminated: %d",
		slotIdx, uid, n)
}
