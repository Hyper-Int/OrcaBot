// REVISION: guest-timesync-v1-vsock-step
//go:build !linux

package main

import "fmt"

// serve is Linux-only (AF_VSOCK + settimeofday); the guest is always Linux.
func serve(port uint32) error {
	return fmt.Errorf("guest-timesync only runs inside the Linux sandbox VM (port %d)", port)
}
