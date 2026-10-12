// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-kernel-v6-browser-isolation

//go:build linux

package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/browser"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/egress"
)

const egressKernelRevision = "egress-kernel-v6-browser-isolation"

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

// setupPoolBrowserPortBlock blocks pool UIDs from the dashboard browser's
// loopback ports (x11vnc, websockify, Chromium DevTools). Unauthenticated CDP or
// VNC would hand an agent the browser — and its egress — outside every check;
// the server is the only legitimate client (it runs as root, outside the range).
func setupPoolBrowserPortBlock() error {
	ruleArgs := []string{
		"-p", "tcp",
		"-d", "127.0.0.0/8",
		"--dport", fmt.Sprintf("%d:%d", browser.PortRangeStart, browser.PortRangeEnd),
		"-m", "owner", "--uid-owner", "2000-2099",
		"-j", "REJECT", "--reject-with", "tcp-reset",
	}
	if exec.Command("iptables", append([]string{"-C", "OUTPUT"}, ruleArgs...)...).Run() == nil {
		return nil
	}
	out, err := exec.Command("iptables", append([]string{"-A", "OUTPUT"}, ruleArgs...)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("iptables pool browser-port block: %w: %s", err, strings.TrimSpace(string(out)))
	}
	log.Printf("[pool-iptables] Blocked pool UIDs 2000-2099 from browser ports %d-%d", browser.PortRangeStart, browser.PortRangeEnd)
	return nil
}

// poolEgressChain holds the default-deny rules for pool UIDs.
const poolEgressChain = "ORCABOT_POOL_EGRESS"

// setupPoolEgressDenyIptables makes egress from pool UIDs (2000-2099) default-deny.
//
// The NAT REDIRECT above only captures ports 80/443, so without this a pool
// process could exfiltrate over any other port (curl :8443, nc, ssh, raw TCP/UDP)
// without ever reaching the approval proxy. After REDIRECT, intercepted HTTP(S)
// has a loopback destination, so it passes the loopback rule here.
//
// Allowed: loopback (localhost always bypasses egress), replies on established
// connections, DNS to the configured resolvers, and any TCP ports listed in
// EGRESS_EXTRA_TCP_PORTS (e.g. "22" for git-over-SSH — opt-in, since each extra
// port is an uninspected channel to any host). Everything else is rejected.
//
// Must be called AFTER setupPoolMCPIptables: the jump is appended to OUTPUT, so
// the MCPLocal REJECT still runs before this chain's loopback RETURN.
// IPv6 failure is fatal (fail closed), same as the NAT rules.
func setupPoolEgressDenyIptables() error {
	ns4, ns6 := resolvConfNameservers("/etc/resolv.conf")
	extraPorts := parseExtraTCPPorts(os.Getenv("EGRESS_EXTRA_TCP_PORTS"))

	build := func(loopback string, nameservers []string) [][]string {
		rules := [][]string{
			{"-d", loopback, "-j", "RETURN"},
			{"-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "RETURN"},
		}
		for _, ns := range nameservers {
			rules = append(rules,
				[]string{"-d", ns, "-p", "udp", "--dport", "53", "-j", "RETURN"},
				[]string{"-d", ns, "-p", "tcp", "--dport", "53", "-j", "RETURN"},
			)
		}
		for _, port := range extraPorts {
			rules = append(rules, []string{"-p", "tcp", "--dport", port, "-j", "RETURN"})
		}
		return append(rules,
			[]string{"-p", "tcp", "-j", "REJECT", "--reject-with", "tcp-reset"},
			[]string{"-j", "REJECT"},
		)
	}

	if err := installPoolEgressChain("iptables", build("127.0.0.0/8", ns4)); err != nil {
		return err
	}
	if err := installPoolEgressChain("ip6tables", build("::1/128", ns6)); err != nil {
		return err
	}
	log.Printf("[egress-kernel] Pool egress default-deny installed (dns4=%v dns6=%v extraTCP=%v)", ns4, ns6, extraPorts)
	return nil
}

// installPoolEgressChain (re)builds the chain from scratch and ensures OUTPUT
// jumps to it for pool UIDs. Flushing first keeps it idempotent across restarts.
func installPoolEgressChain(cmd string, rules [][]string) error {
	run := func(args ...string) error {
		out, err := exec.Command(cmd, args...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s %s: %w: %s", cmd, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
		return nil
	}

	// -N fails if the chain exists; that's fine, -F below resets it.
	_ = exec.Command(cmd, "-N", poolEgressChain).Run()
	if err := run("-F", poolEgressChain); err != nil {
		return err
	}
	for _, rule := range rules {
		if err := run(append([]string{"-A", poolEgressChain}, rule...)...); err != nil {
			return err
		}
	}

	// Pool UIDs, and the dashboard browser's user: Chromium is pointed at the
	// egress proxy, and this keeps anything it loads (or an extension changing
	// its proxy) from leaving any other way.
	for _, owner := range []string{"2000-2099", browser.BrowserUser} {
		jump := []string{"-m", "owner", "--uid-owner", owner, "-j", poolEgressChain}
		if exec.Command(cmd, append([]string{"-C", "OUTPUT"}, jump...)...).Run() == nil {
			continue
		}
		if err := run(append([]string{"-A", "OUTPUT"}, jump...)...); err != nil {
			return err
		}
	}
	return nil
}

// resolvConfNameservers returns the IPv4 and IPv6 nameservers from resolv.conf.
func resolvConfNameservers(path string) (v4, v6 []string) {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Printf("[egress-kernel] WARNING: cannot read %s — pool UIDs will have no DNS: %v", path, err)
		return nil, nil
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "nameserver" {
			continue
		}
		ip := net.ParseIP(strings.SplitN(fields[1], "%", 2)[0])
		if ip == nil {
			continue
		}
		if ip.To4() != nil {
			v4 = append(v4, ip.String())
		} else {
			v6 = append(v6, ip.String())
		}
	}
	return v4, v6
}

// parseExtraTCPPorts parses a comma-separated port list, dropping invalid entries.
func parseExtraTCPPorts(raw string) []string {
	var ports []string
	for _, p := range strings.Split(raw, ",") {
		p = strings.TrimSpace(p)
		if n, err := strconv.Atoi(p); err == nil && n > 0 && n < 65536 {
			ports = append(ports, strconv.Itoa(n))
		}
	}
	return ports
}
