// REVISION: guest-timesync-v1-vsock-step
//go:build linux

package main

import (
	"bytes"
	"fmt"
	"log"
	"time"

	"golang.org/x/sys/unix"
)

const ioTimeout = 5 * time.Second

func serve(port uint32) error {
	if port >= 1024 {
		// Only a reserved port guarantees an unprivileged process can't bind it first.
		return fmt.Errorf("port %d is not in the reserved range (<1024)", port)
	}
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("vsock socket: %w", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		unix.Close(fd)
		return fmt.Errorf("vsock bind :%d: %w", port, err)
	}
	if err := unix.Listen(fd, 4); err != nil {
		unix.Close(fd)
		return fmt.Errorf("vsock listen: %w", err)
	}
	log.Printf("[guest-timesync] listening on vsock :%d (host CID %d only, step threshold %v)",
		port, unix.VMADDR_CID_HOST, stepThreshold)

	for {
		nfd, sa, err := unix.Accept4(fd, unix.SOCK_CLOEXEC)
		if err != nil {
			if err == unix.EINTR || err == unix.ECONNABORTED {
				continue
			}
			log.Printf("[guest-timesync] accept: %v", err)
			time.Sleep(time.Second)
			continue
		}
		handleConn(nfd, sa)
		unix.Close(nfd)
	}
}

// handleConn serves one request. Connections are handled one at a time: the host
// is the only legitimate peer and sends at most one request every few seconds.
func handleConn(fd int, sa unix.Sockaddr) {
	vm, ok := sa.(*unix.SockaddrVM)
	if !ok || vm.CID != unix.VMADDR_CID_HOST {
		// Only the host may set the clock. Anything else (a guest-local vsock
		// loopback peer, a sibling VM) is dropped without a reply.
		log.Printf("[guest-timesync] rejected connection from non-host peer %+v", sa)
		return
	}
	tv := unix.NsecToTimeval(ioTimeout.Nanoseconds())
	_ = unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &tv)
	_ = unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_SNDTIMEO, &tv)

	line, err := readLine(fd, 128)
	if err != nil {
		log.Printf("[guest-timesync] read: %v", err)
		return
	}
	// Monotonic reference for "when the host's timestamp arrived", so time spent
	// before the step is added back onto the host time.
	received := time.Now()
	hostTime, err := parseRequest(line)
	if err != nil {
		log.Printf("[guest-timesync] bad request: %v", err)
		writeAll(fd, "ERR "+err.Error()+"\n")
		return
	}

	// Positive delta = guest is behind the host. Round(0) strips the monotonic
	// reading so the subtraction is wall-clock vs wall-clock.
	before := hostTime.Sub(received.Round(0))
	stepped := false
	after := before
	if needsStep(before) {
		target := hostTime.Add(time.Since(received))
		ttv := unix.NsecToTimeval(target.UnixNano())
		if err := unix.Settimeofday(&ttv); err != nil {
			log.Printf("[guest-timesync] settimeofday failed (delta=%v): %v", before, err)
			writeAll(fd, "ERR settimeofday: "+err.Error()+"\n")
			return
		}
		stepped = true
		after = hostTime.Add(time.Since(received)).Sub(time.Now().Round(0))
		log.Printf("[guest-timesync] stepped clock: delta before=%dms (guest %s host) after=%dms, now %s",
			before.Milliseconds(), behindOrAhead(before), after.Milliseconds(),
			time.Now().UTC().Format(time.RFC3339Nano))
	}
	writeAll(fd, formatReply(stepped, before, after))
}

func behindOrAhead(d time.Duration) string {
	if d >= 0 {
		return "behind"
	}
	return "ahead of"
}

func readLine(fd int, max int) (string, error) {
	buf := make([]byte, 0, max)
	tmp := make([]byte, max)
	for len(buf) < max {
		n, err := unix.Read(fd, tmp[:max-len(buf)])
		if err != nil {
			if err == unix.EINTR {
				continue
			}
			return "", err
		}
		if n <= 0 {
			break
		}
		buf = append(buf, tmp[:n]...)
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			return string(buf[:i+1]), nil
		}
	}
	return "", fmt.Errorf("no complete line (%d bytes)", len(buf))
}

func writeAll(fd int, s string) {
	b := []byte(s)
	for len(b) > 0 {
		n, err := unix.Write(fd, b)
		if err != nil {
			if err == unix.EINTR {
				continue
			}
			return
		}
		b = b[n:]
	}
}
