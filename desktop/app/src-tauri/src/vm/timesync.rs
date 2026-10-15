// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: guest-timesync-v1-host-push
//! Host side of the guest clock sync.
//!
//! The sandbox VM has no NTP client and its kernel reads the RTC only at boot,
//! so after the host sleeps the guest wall clock lags by the sleep duration.
//! Control-plane -> sandbox requests are Ed25519-signed with iat/exp and the
//! guest rejects an iat more than 60s in its future, so a lagging guest fails
//! every signed request until its clock is fixed.
//!
//! The host pushes its UTC time to a root-only daemon in the guest
//! (`orcabot-guest-timesync`, sandbox/cmd/guest-timesync, started by rc.local)
//! over vsock port [`super::GUEST_TIMESYNC_VSOCK_PORT`]. The guest steps its
//! clock when drift > 2s and replies with the before/after delta. The guest only
//! accepts the host's CID on a reserved port, so agent processes in the VM can't
//! set the time.
//!
//! - macOS (Virtualization.framework): the push loop lives in vz-helper
//!   (`GuestTimeSync` in vz-helper/Sources/main.swift), which owns the vsock
//!   device and observes NSWorkspace wake notifications. Nothing here runs.
//! - Linux (QEMU/KVM): [`spawn_sync_thread`] below, over a vhost-vsock device.
//!
//! Wire protocol (one line each way):
//!   host -> guest: `ORCABOT-TIMESYNC 1 <unix_nanos>\n`
//!   guest -> host: `OK stepped=<0|1> before_ms=<n> after_ms=<n> rev=<rev>\n`
//!                  or `ERR <message>\n`

#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const TIMESYNC_REVISION: &str = "guest-timesync-v1-host-push";

const REQUEST_PREFIX: &str = "ORCABOT-TIMESYNC 1 ";
/// Scheduler tick; also the wake-detection granularity.
pub const TICK: Duration = Duration::from_secs(5);
/// Backstop: push at least this often once in sync.
pub const PERIOD: Duration = Duration::from_secs(60);
/// Wall time advancing this much more than monotonic time between two ticks
/// means the host slept (monotonic clocks stop during suspend) or was reset.
const WAKE_JUMP: Duration = Duration::from_secs(3);
/// Fast (every tick) attempts before the first success: covers guest boot.
const BOOT_FAST_ATTEMPTS: u32 = 24;
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(10);
const FAILURE_LOG_INTERVAL: Duration = Duration::from_secs(300);

fn now_epoch_secs() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("{}s", d.as_secs()))
        .unwrap_or_default()
}

pub fn request_line(now: SystemTime) -> String {
    let ns = now
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}{}\n", REQUEST_PREFIX, ns)
}

#[derive(Debug, PartialEq, Eq)]
pub struct Reply {
    pub stepped: bool,
    pub before_ms: i64,
    pub after_ms: i64,
    pub rev: String,
}

pub fn parse_reply(line: &str) -> Result<Reply, String> {
    let line = line.trim();
    if let Some(err) = line.strip_prefix("ERR ") {
        return Err(format!("guest error: {}", err));
    }
    let rest = line
        .strip_prefix("OK ")
        .ok_or_else(|| format!("unexpected reply: {:?}", line))?;
    let mut reply = Reply { stepped: false, before_ms: 0, after_ms: 0, rev: String::new() };
    for kv in rest.split_whitespace() {
        match kv.split_once('=') {
            Some(("stepped", v)) => reply.stepped = v == "1",
            Some(("before_ms", v)) => reply.before_ms = v.parse().map_err(|_| format!("bad before_ms {:?}", v))?,
            Some(("after_ms", v)) => reply.after_ms = v.parse().map_err(|_| format!("bad after_ms {:?}", v))?,
            Some(("rev", v)) => reply.rev = v.to_string(),
            _ => {}
        }
    }
    Ok(reply)
}

/// One request/reply on an already-connected stream. The host time is taken
/// right before the write so connect latency doesn't count as drift.
pub fn exchange<S: Read + Write>(stream: &mut S) -> Result<Reply, String> {
    stream
        .write_all(request_line(SystemTime::now()).as_bytes())
        .map_err(|e| format!("write: {}", e))?;
    let mut out = Vec::with_capacity(128);
    let mut buf = [0u8; 256];
    while out.len() < 512 {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.contains(&b'\n') {
                    break;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("read: {}", e)),
        }
    }
    let line = String::from_utf8_lossy(&out);
    if line.trim().is_empty() {
        return Err("no reply (guest daemon missing on an older VM image?)".into());
    }
    parse_reply(&line)
}

/// Decides when to push. Pure, so it is unit-testable without a VM.
pub struct Scheduler {
    next_due: Instant,
    ever_synced: bool,
    consecutive_failures: u32,
    last_wall: SystemTime,
    last_mono: Instant,
    last_failure_log: Option<Instant>,
}

impl Scheduler {
    pub fn new(now_wall: SystemTime, now_mono: Instant) -> Self {
        Self {
            next_due: now_mono,
            ever_synced: false,
            consecutive_failures: 0,
            last_wall: now_wall,
            last_mono: now_mono,
            last_failure_log: None,
        }
    }

    /// Returns why a push is due now, if it is.
    pub fn due(&mut self, now_wall: SystemTime, now_mono: Instant) -> Option<&'static str> {
        let wall = match now_wall.duration_since(self.last_wall) {
            Ok(d) => d.as_secs_f64(),
            Err(e) => -e.duration().as_secs_f64(),
        };
        let mono = now_mono.saturating_duration_since(self.last_mono).as_secs_f64();
        self.last_wall = now_wall;
        self.last_mono = now_mono;
        if (wall - mono).abs() > WAKE_JUMP.as_secs_f64() {
            return Some("wake");
        }
        if now_mono >= self.next_due {
            return Some(if self.ever_synced { "periodic" } else { "boot" });
        }
        None
    }

    pub fn record_success(&mut self, now_mono: Instant) {
        self.ever_synced = true;
        self.consecutive_failures = 0;
        self.next_due = now_mono + PERIOD;
    }

    /// Records a failure; returns true when it should be logged (quiet while the
    /// guest is still booting, then at most every FAILURE_LOG_INTERVAL).
    pub fn record_failure(&mut self, now_mono: Instant) -> bool {
        self.consecutive_failures += 1;
        let booting = !self.ever_synced && self.consecutive_failures < BOOT_FAST_ATTEMPTS;
        self.next_due = now_mono
            + if self.ever_synced {
                RETRY_AFTER_FAILURE
            } else if booting {
                // Due again on the very next tick, not the one after.
                TICK - Duration::from_secs(1)
            } else {
                PERIOD
            };
        if booting {
            return false;
        }
        let log = self
            .last_failure_log
            .map_or(true, |t| now_mono.saturating_duration_since(t) >= FAILURE_LOG_INTERVAL);
        if log {
            self.last_failure_log = Some(now_mono);
        }
        log
    }

    pub fn ever_synced(&self) -> bool {
        self.ever_synced
    }

    pub fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }
}

/// Runs the push loop on a background thread until `stop` is set. `connect`
/// opens a fresh stream to the guest daemon for each push.
pub fn spawn_sync_thread<S, F>(mut connect: F, stop: Arc<AtomicBool>) -> std::thread::JoinHandle<()>
where
    S: Read + Write,
    F: FnMut() -> io::Result<S> + Send + 'static,
{
    std::thread::Builder::new()
        .name("guest-timesync".into())
        .spawn(move || {
            eprintln!(
                "[timesync] REVISION: {} guest clock sync loop started at {} (tick {}s, period {}s)",
                TIMESYNC_REVISION,
                now_epoch_secs(),
                TICK.as_secs(),
                PERIOD.as_secs()
            );
            let mut sched = Scheduler::new(SystemTime::now(), Instant::now());
            while !stop.load(Ordering::Relaxed) {
                if let Some(reason) = sched.due(SystemTime::now(), Instant::now()) {
                    if reason == "wake" {
                        eprintln!("[timesync] host wake / wall-clock jump detected -> syncing guest clock");
                    }
                    let result = connect()
                        .map_err(|e| format!("vsock connect: {}", e))
                        .and_then(|mut s| exchange(&mut s));
                    match result {
                        Ok(r) => {
                            if r.stepped {
                                eprintln!(
                                    "[timesync] guest clock STEPPED ({}): delta before={}ms after={}ms (positive = guest was behind)",
                                    reason, r.before_ms, r.after_ms
                                );
                            } else if !sched.ever_synced() {
                                eprintln!(
                                    "[timesync] guest clock in sync ({}): delta={}ms, guest {}",
                                    reason, r.before_ms, r.rev
                                );
                            }
                            sched.record_success(Instant::now());
                        }
                        Err(e) => {
                            if sched.record_failure(Instant::now()) {
                                eprintln!(
                                    "[timesync] guest clock sync failed ({}, {} in a row): {}",
                                    reason,
                                    sched.consecutive_failures(),
                                    e
                                );
                            }
                        }
                    }
                }
                std::thread::sleep(TICK);
            }
        })
        .expect("spawn guest-timesync thread")
}

/// Connects to a guest vsock port (Linux host with a vhost-vsock device).
#[cfg(target_os = "linux")]
pub fn connect_vsock(cid: u32, port: u32, timeout: Duration) -> io::Result<std::fs::File> {
    use std::os::fd::{FromRawFd, OwnedFd};
    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let owned = OwnedFd::from_raw_fd(fd);
        let mut addr: libc::sockaddr_vm = std::mem::zeroed();
        addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
        addr.svm_port = port;
        addr.svm_cid = cid;
        if libc::connect(
            fd,
            &addr as *const libc::sockaddr_vm as *const libc::sockaddr,
            std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        ) < 0
        {
            return Err(io::Error::last_os_error());
        }
        let tv = libc::timeval {
            tv_sec: timeout.as_secs() as libc::time_t,
            tv_usec: 0,
        };
        for opt in [libc::SO_RCVTIMEO, libc::SO_SNDTIMEO] {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                opt,
                &tv as *const libc::timeval as *const libc::c_void,
                std::mem::size_of::<libc::timeval>() as libc::socklen_t,
            );
        }
        Ok(std::fs::File::from(owned))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};

    #[test]
    fn request_and_reply_roundtrip() {
        let t = UNIX_EPOCH + Duration::from_nanos(1_760_000_000_123_456_789);
        assert_eq!(request_line(t), "ORCABOT-TIMESYNC 1 1760000000123456789\n");
        let r = parse_reply("OK stepped=1 before_ms=401000 after_ms=2 rev=guest-timesync-v1\n").unwrap();
        assert_eq!(
            r,
            Reply { stepped: true, before_ms: 401000, after_ms: 2, rev: "guest-timesync-v1".into() }
        );
        assert!(parse_reply("ERR settimeofday: EPERM").is_err());
        assert!(parse_reply("HTTP/1.1 400").is_err());
    }

    #[test]
    fn exchange_against_fake_guest() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let guest = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 128];
            let n = s.read(&mut buf).unwrap();
            let line = String::from_utf8_lossy(&buf[..n]).to_string();
            s.write_all(b"OK stepped=0 before_ms=12 after_ms=12 rev=x\n").unwrap();
            line
        });
        let mut s = TcpStream::connect(addr).unwrap();
        let r = exchange(&mut s).unwrap();
        assert!(!r.stepped);
        assert_eq!(r.before_ms, 12);
        assert!(guest.join().unwrap().starts_with("ORCABOT-TIMESYNC 1 "));
    }

    #[test]
    fn scheduler_boot_period_and_wake() {
        let w0 = SystemTime::now();
        let m0 = Instant::now();
        let mut s = Scheduler::new(w0, m0);
        // Due immediately at boot.
        assert_eq!(s.due(w0, m0), Some("boot"));
        // Boot failures are retried each tick and not logged.
        assert!(!s.record_failure(m0));
        assert_eq!(s.due(w0 + TICK, m0 + TICK), Some("boot"));
        s.record_success(m0 + TICK);
        // Not due again until the period elapses.
        assert_eq!(s.due(w0 + TICK * 2, m0 + TICK * 2), None);
        let m = m0 + TICK + PERIOD;
        let w = w0 + TICK + PERIOD;
        assert_eq!(s.due(w, m), Some("periodic"));
        s.record_success(m);
        // Host slept 400s: wall advanced, monotonic didn't -> immediate push.
        assert_eq!(s.due(w + Duration::from_secs(400) + TICK, m + TICK), Some("wake"));
    }

    #[test]
    fn scheduler_failure_logging_is_rate_limited() {
        let w0 = SystemTime::now();
        let m0 = Instant::now();
        let mut s = Scheduler::new(w0, m0);
        let mut logged = 0;
        for i in 0..BOOT_FAST_ATTEMPTS + 5 {
            if s.record_failure(m0 + TICK * i) {
                logged += 1;
            }
        }
        // One log once the boot window is exhausted, then quiet for 5 min.
        assert_eq!(logged, 1);
    }
}
