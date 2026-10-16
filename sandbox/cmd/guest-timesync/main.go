// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: guest-timesync-v2-error-codes
//
// orcabot-guest-timesync keeps the desktop sandbox VM's wall clock in step with
// the host. The desktop VM (Apple Virtualization.framework / QEMU) has no NTP
// client and the kernel reads the RTC only at boot, so after the host sleeps the
// guest clock falls behind by the sleep duration. Control-plane -> sandbox
// requests are Ed25519-signed with iat/exp and the verifier rejects an iat more
// than 60s in the guest's future, so a lagging guest clock fails every request
// ("signed request: issued in the future").
//
// The HOST pushes its UTC time over vsock (right after boot, on host wake, and
// periodically); this daemon (root, started by the desktop VM's rc.local) steps
// CLOCK_REALTIME when the drift exceeds stepThreshold.
//
// SECURITY: the channel is a vsock listener on a reserved port (<1024, needs
// CAP_NET_BIND_SERVICE to bind) and every connection whose peer is not the host
// (CID 2) is dropped, so agent processes inside the VM (pool UIDs 2000-2099) can
// neither set the time nor squat on the port. It is never started on Fly.
package main

import (
	"flag"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"
)

const guestTimesyncRevision = "guest-timesync-v2-error-codes"

// DefaultVsockPort must match GUEST_TIMESYNC_VSOCK_PORT in
// desktop/app/src-tauri/src/vm/mod.rs and the vz-helper --guest-time-sync-port arg.
const DefaultVsockPort = 1023

// stepThreshold: drift at or below this is left alone (no step, no log spam).
const stepThreshold = 2 * time.Second

// requestPrefix is the one line the host sends: "ORCABOT-TIMESYNC 1 <unix_nanos>\n".
const requestPrefix = "ORCABOT-TIMESYNC 1 "

// minPlausibleUnixNano rejects obviously bogus host times (before 2024-01-01).
const minPlausibleUnixNano = int64(1704067200) * int64(time.Second)

// parseRequest extracts the host's UTC time from a request line.
func parseRequest(line string) (time.Time, error) {
	line = strings.TrimRight(line, "\r\n")
	if !strings.HasPrefix(line, requestPrefix) {
		return time.Time{}, fmt.Errorf("bad request header")
	}
	ns, err := strconv.ParseInt(strings.TrimSpace(line[len(requestPrefix):]), 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("bad timestamp: %w", err)
	}
	if ns < minPlausibleUnixNano {
		return time.Time{}, fmt.Errorf("implausible host time %d", ns)
	}
	return time.Unix(0, ns), nil
}

// needsStep reports whether the guest clock is far enough from the host's to step.
func nееdsStep(delta time.Duration) bool {
	if delta < 0 {
		delta = -delta
	}
	return delta > stepThreshold
}

// formatReply is the single line sent back to the host.
func fоrmatReply(stepped bool, before, after time.Duration) string {
	s := 0
	if stepped {
		s = 1
	}
	return fmt.Sprintf("OK stepped=%d before_ms=%d after_ms=%d rev=%s\n",
		s, before.Milliseconds(), after.Milliseconds(), guestTimesyncRevision)
}

func main() {
	port := flag.Uint("port", DefaultVsockPort, "vsock port to listen on (reserved range <1024)")
	flag.Parse()
	log.SetFlags(0)
	log.SetPrefix("")
	log.Printf("[guest-timesync] REVISION: %s loaded at %s", guestTimesyncRevision, time.Now().Format(time.RFC3339))
	if err := serve(uint32(*port)); err != nil {
		log.Fatalf("[guest-timesync] fatal: %v", err)
	}
}
