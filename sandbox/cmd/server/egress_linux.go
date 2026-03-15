// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-kernel-v4-pool-mcp-port-block

//go:build linux

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/egress"
)

const egressKernelRevision = "egress-kernel-v4-pool-mcp-port-block"

func init() {
	log.Printf("[egress-kernel] REVISION: %s loaded at %s", egressKernelRevision, "init")
}

// checkNetAdmin reads CapEff from /proc/self/status and returns true if
// CAP_NET_ADMIN (bit 12) is set. Kernel egress enforcement requires this capability.
func checkNetAdmin() bool {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "CapEff:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return false
		}
		val, err := strconv.ParseUint(fields[1], 16, 64)
		if err != nil {
			return false
		}
		const capNetAdmin = 1 << 12
		return val&capNetAdmin != 0
	}
	return false
}

// setupEgressIptables installs iptables and ip6tables NAT REDIRECT rules that
// transparently intercept outbound HTTP (port 80) and HTTPS (port 443) from
// PTY UIDs 2000–2099. Only HTTP/HTTPS are captured because the transparent
// proxy identifies domains via Host header or TLS SNI — other protocols
// (SSH, database, etc.) cannot be parsed and would be incorrectly blocked.
// The rules are idempotent: existing rules are detected with -C before -A.
// IPv6 failure is logged but non-fatal (not all kernels enable IPv6 NAT).
func setupEgressIptables() error {
	port := strconv.Itoa(egress.TransparentPort)

	// IPv4: redirect outbound HTTP/HTTPS (not to loopback) from PTY UID range
	ruleArgs4 := []string{
		"-p", "tcp",
		"-m", "multiport", "--dports", "80,443",
		"!", "-d", "127.0.0.0/8",
		"-m", "owner", "--uid-owner", "2000-2099",
		"-j", "REDIRECT", "--to-ports", port,
	}

	// IPv6: same, excluding loopback ::1/128
	ruleArgs6 := []string{
		"-p", "tcp",
		"-m", "multiport", "--dports", "80,443",
		"!", "-d", "::1/128",
		"-m", "owner", "--uid-owner", "2000-2099",
		"-j", "REDIRECT", "--to-ports", port,
	}

	applyRule := func(cmd string, ruleArgs []string) error {
		// Check if rule already exists (-C exits 0 if present)
		checkArgs := append([]string{"-t", "nat", "-C", "OUTPUT"}, ruleArgs...)
		if err := exec.Command(cmd, checkArgs...).Run(); err == nil {
			log.Printf("[egress-kernel] %s rule already installed (idempotent)", cmd)
			return nil
		}
		addArgs := append([]string{"-t", "nat", "-A", "OUTPUT"}, ruleArgs...)
		out, err := exec.Command(cmd, addArgs...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s: %w: %s", cmd, err, strings.TrimSpace(string(out)))
		}
		log.Printf("[egress-kernel] %s NAT REDIRECT rule installed (uid-owner 2000-2099 → port %s)", cmd, port)
		return nil
	}

	if err := applyRule("iptables", ruleArgs4); err != nil {
		return fmt.Errorf("iptables setup: %w", err)
	}

	// ip6tables is required: without it PTY processes can bypass the proxy via IPv6
	// (curl -6, AAAA records). If this kernel lacks CONFIG_IP6_NF_NAT the pool must
	// not activate — fail closed rather than silently allow IPv6 bypass.
	if err := applyRule("ip6tables", ruleArgs6); err != nil {
		return fmt.Errorf("ip6tables setup: %w", err)
	}

	return nil
}

// setupPoolMCPIptables blocks pool UIDs (2000-2099) from reaching the MCPLocal
// TCP server directly. Pool PTY processes must use the privileged Unix socket
// (SO_PEERCRED authenticated) instead — this ensures the server-side trust model
// is purely kernel-derived with no bearer secret at the TCP boundary.
//
// MCPLocal binds to 127.0.0.1 (IPv4 only), so only an IPv4 rule is needed.
// REVISION: egress-kernel-v4-pool-mcp-port-block
func setupPoolMCPIptables(mcpPort string) error {
	ruleArgs := []string{
		"-p", "tcp",
		"-d", "127.0.0.0/8",
		"--dport", mcpPort,
		"-m", "owner", "--uid-owner", "2000-2099",
		"-j", "REJECT", "--reject-with", "tcp-reset",
	}

	checkArgs := append([]string{"-C", "OUTPUT"}, ruleArgs...)
	if err := exec.Command("iptables", checkArgs...).Run(); err == nil {
		log.Printf("[pool-iptables] MCPLocal port block already installed (idempotent)")
		return nil
	}

	addArgs := append([]string{"-A", "OUTPUT"}, ruleArgs...)
	out, err := exec.Command("iptables", addArgs...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("iptables pool MCP block: %w: %s", err, strings.TrimSpace(string(out)))
	}
	log.Printf("[pool-iptables] Blocked pool UIDs 2000-2099 from TCP port %s (MCPLocal)", mcpPort)
	return nil
}
