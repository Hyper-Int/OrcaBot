// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-kernel-v11-browser-user-port-block

//go:build linux

package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"time"

	"github.com/Hyper-Int/OrcaBot/sandbox/internal/browser"
	"github.com/Hyper-Int/OrcaBot/sandbox/internal/egress"
)

const egressKernelRevision = "egress-kernel-v11-browser-user-port-block"

func init() {
	log.Printf("[egress-kernel] REVISION: %s loaded at %s", egressKernelRevision, time.Now().Format(time.RFC3339))
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
//
// Two rules per family:
//   - --dport: pool UIDs can't connect to those ports.
//   - --sport: a pool UID's own listener on those ports can't answer anyone.
//     Agents can still bind() a port in the range (iptables can't stop that),
//     e.g. x11vnc's once it has died. websockify (browser user) connects to
//     x11vnc by port and can't check who accepted, so without this rule every
//     viewer's VNC session would land on the agent's listener. The rule drops
//     the listener's SYN-ACK (owner match applies to it), so the connect fails.
//
// REVISION: egress-kernel-v10-browser-sport-block
func setupPoolBrowserPortBlock() error {
	portRange := fmt.Sprintf("%d:%d", browser.PortRangeStart, browser.PortRangeEnd)
	for _, family := range []struct{ command, loopback string }{
		{"iptables", "127.0.0.0/8"},
		{"ip6tables", "::1/128"},
	} {
		for _, ruleArgs := range [][]string{
			{
				"-p", "tcp", "-d", family.loopback,
				"--dport", portRange,
				"-m", "owner", "--uid-owner", "2000-2099",
				"-j", "REJECT", "--reject-with", "tcp-reset",
			},
			{
				"-p", "tcp", "-s", family.loopback,
				"--sport", portRange,
				"-m", "owner", "--uid-owner", "2000-2099",
				"-j", "DROP",
			},
		} {
			if exec.Command(family.command, append([]string{"-C", "OUTPUT"}, ruleArgs...)...).Run() == nil {
				continue
			}
			// Insert ahead of any existing loopback allowances.
			out, err := exec.Command(family.command, append([]string{"-I", "OUTPUT", "1"}, ruleArgs...)...).CombinedOutput()
			if err != nil {
				return fmt.Errorf("%s pool browser-port block: %w: %s", family.command, err, strings.TrimSpace(string(out)))
			}
		}
	}
	log.Printf("[pool-iptables] Blocked pool UIDs 2000-2099 from browser ports %d-%d (connect and serve)", browser.PortRangeStart, browser.PortRangeEnd)
	return setupBrowserUserPortBlock(lookupUser)
}

// setupBrowserUserPortBlock rejects every connection from Chromium's user
// (browser.BrowserUser) to the browser port range. Page JavaScript, links and
// an agent's browser_evaluate all run as that user, and every dashboard's
// stack listens on loopback in the range (desktop runs them all in one VM):
// without this, dashboard A's page could open dashboard B's websockify/noVNC
// (no VNC password — it views and drives B's screen) or x11vnc. Chromium
// only *listens* there (DevTools; its replies have a source port in the range,
// which a --dport rule never matches), and websockify -> x11vnc runs as
// browser.VNCUser, so nothing legitimate is blocked. The server (root) stays
// the only other client.
//
// Installed whenever CAP_NET_ADMIN is available, egress or not: the threat is
// a hostile page, not only an agent. Skipped with a warning on an image
// without the browser user (it runs no browser: Start refuses).
// REVISION: egress-kernel-v11-browser-user-port-block
func setupBrowserUserPortBlock(lookup func(name string) error) error {
	if err := lookup(browser.BrowserUser); err != nil {
		log.Printf("[pool-iptables] WARNING: browser user %q not found, skipping its browser-port block: %v", browser.BrowserUser, err)
		return nil
	}
	portRange := fmt.Sprintf("%d:%d", browser.PortRangeStart, browser.PortRangeEnd)
	for _, family := range []struct{ command, loopback string }{
		{"iptables", "127.0.0.0/8"},
		{"ip6tables", "::1/128"},
	} {
		ruleArgs := browserUserPortBlockRule(family.loopback, portRange)
		if exec.Command(family.command, append([]string{"-C", "OUTPUT"}, ruleArgs...)...).Run() == nil {
			continue
		}
		// Ahead of the browser user's jump to the pool egress chain, whose
		// loopback RETURN would otherwise accept it.
		out, err := exec.Command(family.command, append([]string{"-I", "OUTPUT", "1"}, ruleArgs...)...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s browser-user port block: %w: %s", family.command, err, strings.TrimSpace(string(out)))
		}
	}
	log.Printf("[pool-iptables] Blocked %s (Chromium, page JS) from browser ports %d-%d", browser.BrowserUser, browser.PortRangeStart, browser.PortRangeEnd)
	return nil
}

// installBrowserUserPortBlock is setupBrowserUserPortBlock with the real user
// lookup, for startup outside setupKernelEgress (egress disabled).
func installBrowserUserPortBlock() error { return setupBrowserUserPortBlock(lookupUser) }

func browserUserPortBlockRule(loopback, portRange string) []string {
	return []string{
		"-p", "tcp", "-d", loopback,
		"--dport", portRange,
		"-m", "owner", "--uid-owner", browser.BrowserUser,
		"-j", "REJECT", "--reject-with", "tcp-reset",
	}
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

	for _, owner := range poolEgressOwners(lookupUser) {
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

// poolEgressOwners lists the --uid-owner matches that jump to the pool egress
// chain: the pool UIDs, and the dashboard browser's user — Chromium is pointed
// at the egress proxy, and this keeps anything it loads (or an extension
// changing its proxy) from leaving any other way. iptables resolves the name
// itself and rejects an unknown one, so on an image without that user (built
// before it existed) the browser jump is skipped with a warning instead of
// failing the chain and leaving the pool without egress control. Such an
// image also runs no browser: browser.Start refuses without the user.
//
// The VNC user (Xvfb, x11vnc, websockify) needs nothing but loopback, so it
// is held to the same chain. REVISION: egress-kernel-v11-browser-user-port-block
func poolEgressOwners(lookup func(name string) error) []string {
	owners := []string{"2000-2099"}
	for _, name := range []string{browser.BrowserUser, browser.VNCUser} {
		if err := lookup(name); err != nil {
			log.Printf("[egress-kernel] WARNING: browser user %q not found, skipping its egress jump: %v", name, err)
			continue
		}
		owners = append(owners, name)
	}
	return owners
}

func lookupUser(name string) error {
	_, err := user.Lookup(name)
	return err
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
