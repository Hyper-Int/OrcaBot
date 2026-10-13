// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

package browser

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strings"
	"testing"
)

// procWord formats 4 address bytes the way the kernel prints them: the
// network-order word loaded natively, as %08X.
func procWord(b []byte) string {
	return fmt.Sprintf("%08X", binary.NativeEndian.Uint32(b))
}

func procAddr(ip net.IP, port int) string {
	var hexIP string
	if v4 := ip.To4(); v4 != nil && len(ip) == net.IPv4len {
		hexIP = procWord(v4)
	} else {
		ip16 := ip.To16()
		for i := 0; i < 16; i += 4 {
			hexIP += procWord(ip16[i : i+4])
		}
	}
	return fmt.Sprintf("%s:%04X", hexIP, port)
}

func procRow(local, remote string, st string, uid int) string {
	return procRowInode(local, remote, st, uid, 12345)
}

func procRowInode(local, remote string, st string, uid, inode int) string {
	return fmt.Sprintf("   0: %s %s %s 00000000:00000000 00:00000000 00000000 %5d        0 %d 1 0000000000000000 20 4 30 10 -1", local, remote, st, uid, inode)
}

func scanTable(t *testing.T, table string, local, remote *net.TCPAddr) (int, bool, error) {
	t.Helper()
	rows, err := parseProcNetTCP(strings.NewReader(table))
	if err != nil {
		t.Fatal(err)
	}
	return acceptingUID(rows, local, remote)
}

const procHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode"

func TestParseProcAddr(t *testing.T) {
	for _, tc := range []struct {
		ip   net.IP
		port int
	}{
		{net.IPv4(127, 0, 0, 1).To4(), 6123},
		{net.IPv4(10, 1, 2, 3).To4(), 80},
		{net.ParseIP("::1"), 6200},
		{net.ParseIP("::ffff:127.0.0.1"), 6100},
		{net.ParseIP("fdaa:0:1::3"), 443},
	} {
		got, err := parseProcAddr(procAddr(tc.ip, tc.port))
		if err != nil {
			t.Fatalf("%v: %v", tc.ip, err)
		}
		if !got.IP.Equal(tc.ip) || got.Port != tc.port {
			t.Errorf("parse(%s) = %v, want %v:%d", procAddr(tc.ip, tc.port), got, tc.ip, tc.port)
		}
	}
	if _, err := parseProcAddr("zz:1"); err == nil {
		t.Error("bad hex accepted")
	}
}

func TestScanProcNetTCPMatchesExactConnection(t *testing.T) {
	lo := net.IPv4(127, 0, 0, 1).To4()
	server := &net.TCPAddr{IP: lo, Port: 6150}
	client := &net.TCPAddr{IP: lo, Port: 41000}
	other := &net.TCPAddr{IP: lo, Port: 41001}
	table := strings.Join([]string{
		procHeader,
		procRow(procAddr(lo, 6150), procAddr(net.IPv4zero.To4(), 0), "0A", 1990), // listener
		procRow(procAddr(lo, 6150), procAddr(lo, 41001), "01", 2000),             // someone else's conn
		procRow(procAddr(lo, 41000), procAddr(lo, 6150), "01", 0),                // our end
		procRow(procAddr(lo, 6150), procAddr(lo, 41000), "01", 1990),             // accepted end
	}, "\n")

	uid, found, err := scanTable(t, table, server, client)
	if err != nil || !found || uid != 1990 {
		t.Fatalf("accepted socket: uid=%d found=%v err=%v", uid, found, err)
	}
	uid, found, _ = scanTable(t, table, server, other)
	if !found || uid != 2000 {
		t.Fatalf("other conn: uid=%d found=%v", uid, found)
	}
	if _, found, _ := scanTable(t, table, server, &net.TCPAddr{IP: lo, Port: 1}); found {
		t.Fatal("matched a connection that isn't there")
	}
}

func TestAcceptQueueRowFallsBackToListenerOwner(t *testing.T) {
	lo := net.IPv4(127, 0, 0, 1).To4()
	server := &net.TCPAddr{IP: lo, Port: 6150}
	client := &net.TCPAddr{IP: lo, Port: 41000}
	// Not yet accepted: no inode, and pre-6.x kernels print uid 0 for it.
	queued := procRowInode(procAddr(lo, 6150), procAddr(lo, 41000), "01", 0, 0)
	listener := func(ip net.IP, uid int) string {
		return procRow(procAddr(ip, 6150), procAddr(net.IPv4zero.To4(), 0), "0A", uid)
	}

	uid, found, err := scanTable(t, procHeader+"\n"+queued+"\n"+listener(lo, 1990), server, client)
	if err != nil || !found || uid != 1990 {
		t.Fatalf("queued conn: uid=%d found=%v err=%v", uid, found, err)
	}
	uid, found, _ = scanTable(t, procHeader+"\n"+queued+"\n"+listener(net.IPv4zero.To4(), 2000), server, client)
	if !found || uid != 2000 {
		t.Fatalf("wildcard squatter: uid=%d found=%v", uid, found)
	}
	// Listeners on other ports or addresses don't count.
	other := procRow(procAddr(lo, 6151), procAddr(net.IPv4zero.To4(), 0), "0A", 1990) + "\n" +
		procRow(procAddr(net.IPv4(10, 0, 0, 1).To4(), 6150), procAddr(net.IPv4zero.To4(), 0), "0A", 1990)
	if _, found, _ := scanTable(t, procHeader+"\n"+queued+"\n"+other, server, client); found {
		t.Fatal("attributed a queued connection to an unrelated listener")
	}
	// Disagreeing listeners: refuse rather than guess.
	_, _, err = scanTable(t, procHeader+"\n"+queued+"\n"+listener(lo, 1990)+"\n"+listener(net.IPv4zero.To4(), 2000), server, client)
	if !errors.Is(err, errNotBrowserSocket) {
		t.Fatalf("conflicting listeners: err = %v", err)
	}
}

func TestScanProcNetTCP6V4Mapped(t *testing.T) {
	// A dual-stack listener reports IPv4 peers as ::ffff:a.b.c.d in tcp6.
	mapped := net.ParseIP("::ffff:127.0.0.1")
	lo := net.IPv4(127, 0, 0, 1).To4()
	table := procHeader + "\n" + procRow(procAddr(mapped, 6150), procAddr(mapped, 41000), "01", 1990)
	uid, found, err := scanTable(t, table, &net.TCPAddr{IP: lo, Port: 6150}, &net.TCPAddr{IP: lo, Port: 41000})
	if err != nil || !found || uid != 1990 {
		t.Fatalf("uid=%d found=%v err=%v", uid, found, err)
	}
}

func TestDialBrowserRejectsNonLoopbackTargets(t *testing.T) {
	for _, addr := range []string{"localhost:6100", "10.0.0.1:6100", "[::1]:6100", "0.0.0.0:6100"} {
		if _, err := dialOwnedBy(context.Background(), "tcp", addr, 0); err == nil || !strings.Contains(err.Error(), "not 127.0.0.1") {
			t.Errorf("%s: err = %v", addr, err)
		}
	}
	if _, err := dialOwnedBy(context.Background(), "unix", "127.0.0.1:6100", 0); err == nil {
		t.Error("unix network accepted")
	}
}
