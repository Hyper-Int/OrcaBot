// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: vz-helper-v5-copyright-header
import AppKit
import Foundation
import Virtualization
import ArgumentParser
import Network

let vzHelperRevision = "vz-helper-v5-copyright-header"

// MARK: - Global references to prevent deallocation
var globalVM: VZVirtualMachine?
var globalForwarders: [TCPToVsockForwarder] = []
var globalVsockListeners: [VsockListener] = []
var globalConsolePipe: Pipe?
var globalConsoleLogFile: FileHandle?
var globalTimeSync: GuestTimeSync?

@main
struct VZHelper: ParsableCommand {
    static var configuration = CommandConfiguration(
        commandName: "vz-helper",
        abstract: "Virtualization.framework helper for Orcabot sandbox VM"
    )

    @Option(name: .long, help: "Path to Linux kernel (vmlinuz)")
    var kernel: String

    @Option(name: .long, help: "Path to initial ramdisk (initrd)")
    var initrd: String

    @Option(name: .long, help: "Path to disk image")
    var disk: String

    @Option(name: .long, help: "Kernel command line")
    var cmdline: String = "console=hvc0 root=/dev/vda rw"

    @Option(name: .long, help: "Number of CPUs")
    var cpus: Int = 2

    @Option(name: .long, help: "Memory in MB")
    var memory: Int = 2048

    @Option(name: .long, help: "Shared directory (tag:path)")
    var share: [String] = []

    @Option(name: .long, help: "Port forward via vsock (hostPort:guestPort)")
    var portForward: [String] = []

    @Option(name: .long, help: "Reverse forward: guest vsock port to host TCP port (vsockPort:hostPort). Lets the guest reach host loopback services, e.g. the control plane.")
    var reversePortForward: [String] = []

    @Option(name: .long, help: "Guest vsock port of the root time-sync daemon (orcabot-guest-timesync). When set, the host pushes its UTC time to the guest after boot, on host wake and every 60s. 0 = off.")
    var guestTimeSyncPort: UInt32 = 0

    @Flag(name: .long, help: "Disable directory sharing (for debugging)")
    var noShare: Bool = false

    @Flag(name: .long, help: "Disable disk attachment (for debugging)")
    var noDisk: Bool = false

    @Flag(name: .long, help: "Minimal config: just kernel+initrd+serial (for debugging)")
    var minimal: Bool = false

    mutating func run() throws {
        print("[vz-helper] REVISION: \(vzHelperRevision) loaded at \(ISO8601DateFormatter().string(from: Date()))")
        print("Starting Orcabot sandbox VM...")
        print("  Kernel: \(kernel)")
        print("  Initrd: \(initrd)")
        print("  Disk: \(disk)")
        print("  CPUs: \(cpus)")
        print("  Memory: \(memory) MB")

        // Parse port forwards
        var portForwards: [(hostPort: UInt16, guestPort: UInt32)] = []
        for pf in portForward {
            let parts = pf.split(separator: ":")
            if parts.count == 2,
               let hostPort = UInt16(parts[0]),
               let guestPort = UInt32(parts[1]) {
                portForwards.append((hostPort, guestPort))
                print("  Port forward: localhost:\(hostPort) -> vsock:\(guestPort)")
            } else {
                print("Warning: Invalid port forward specification: \(pf)")
            }
        }

        // Parse reverse port forwards (guest vsock port -> host TCP port)
        var reversePortForwards: [(vsockPort: UInt32, hostPort: UInt16)] = []
        for rpf in reversePortForward {
            let parts = rpf.split(separator: ":")
            if parts.count == 2,
               let vsockPort = UInt32(parts[0]),
               let hostPort = UInt16(parts[1]) {
                reversePortForwards.append((vsockPort, hostPort))
                print("  Reverse forward: guest vsock:\(vsockPort) -> host localhost:\(hostPort)")
            } else {
                print("Warning: Invalid reverse port forward specification: \(rpf)")
            }
        }

        // Validate files exist
        guard FileManager.default.fileExists(atPath: kernel) else {
            throw VMError.fileNotFound("Kernel not found: \(kernel)")
        }
        guard FileManager.default.fileExists(atPath: initrd) else {
            throw VMError.fileNotFound("Initrd not found: \(initrd)")
        }
        guard FileManager.default.fileExists(atPath: disk) else {
            throw VMError.fileNotFound("Disk image not found: \(disk)")
        }

        // Create VM configuration
        let config = VZVirtualMachineConfiguration()

        // Boot loader
        let bootLoader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
        bootLoader.initialRamdiskURL = URL(fileURLWithPath: initrd)
        bootLoader.commandLine = cmdline
        config.bootLoader = bootLoader

        // CPU and memory
        config.cpuCount = cpus
        config.memorySize = UInt64(memory) * 1024 * 1024

        // Platform (generic for Linux)
        config.platform = VZGenericPlatformConfiguration()

        // Serial console (virtio) - write to file for debugging
        let serialPort = VZVirtioConsoleDeviceSerialPortConfiguration()

        let logPath = "/tmp/vz-console.log"
        FileManager.default.createFile(atPath: logPath, contents: nil, attributes: nil)
        guard let logFileHandle = FileHandle(forWritingAtPath: logPath) else {
            print("[VZ] ERROR: Could not create console log file")
            throw VMError.configError("Could not create console log file")
        }

        if ProcessInfo.processInfo.environment["VZ_CONSOLE_DIRECT"] == "1" {
            // Directly attach console output to the log file (no pipe/tee).
            serialPort.attachment = VZFileHandleSerialPortAttachment(
                fileHandleForReading: FileHandle.standardInput,
                fileHandleForWriting: logFileHandle
            )
            print("[VZ] Serial console configured, direct output to: \(logPath)")
        } else {
            // Tee VM console output to both the log file and stdout.
            let consolePipe = Pipe()
            globalConsolePipe = consolePipe
            globalConsoleLogFile = logFileHandle
            consolePipe.fileHandleForReading.readabilityHandler = { handle in
                let data = handle.availableData
                if data.isEmpty {
                    return
                }
                logFileHandle.write(data)
                FileHandle.standardOutput.write(data)
            }

            serialPort.attachment = VZFileHandleSerialPortAttachment(
                fileHandleForReading: FileHandle.standardInput,
                fileHandleForWriting: consolePipe.fileHandleForWriting
            )
            print("[VZ] Serial console configured, output to: \(logPath)")
        }
        config.serialPorts = [serialPort]

        // Disk image
        if noDisk {
            print("[VZ] Disk attachment DISABLED (--no-disk flag)")
            config.storageDevices = []
        } else {
            do {
                let diskURL = URL(fileURLWithPath: disk)
                let diskAttachment = try VZDiskImageStorageDeviceAttachment(
                    url: diskURL,
                    readOnly: false
                )
                let diskDevice = VZVirtioBlockDeviceConfiguration(attachment: diskAttachment)
                config.storageDevices = [diskDevice]
            } catch {
                throw VMError.configError("Failed to attach disk: \(error)")
            }
        }

        // Network with NAT
        if minimal {
            print("[VZ] Network DISABLED (--minimal flag)")
            config.networkDevices = []
        } else {
            let networkDevice = VZVirtioNetworkDeviceConfiguration()
            networkDevice.attachment = VZNATNetworkDeviceAttachment()
            config.networkDevices = [networkDevice]
        }

        // Virtio Socket device for vsock communication
        if minimal {
            print("[VZ] Vsock DISABLED (--minimal flag)")
            config.socketDevices = []
        } else {
            let vsockDevice = VZVirtioSocketDeviceConfiguration()
            config.socketDevices = [vsockDevice]
            print("  Vsock: enabled")
        }

        // Shared directories (VirtioFS)
        var fsDevices: [VZVirtioFileSystemDeviceConfiguration] = []
        if noShare {
            print("[VZ] Directory sharing DISABLED (--no-share flag)")
        } else {
            for shareSpec in share {
                let parts = shareSpec.split(separator: ":", maxSplits: 1)
                guard parts.count == 2 else {
                    print("Warning: Invalid share specification: \(shareSpec)")
                    continue
                }
                let tag = String(parts[0])
                let path = String(parts[1])

                guard FileManager.default.fileExists(atPath: path) else {
                    print("Warning: Share path does not exist: \(path)")
                    continue
                }

                let shareDir = VZSharedDirectory(url: URL(fileURLWithPath: path), readOnly: false)
                let singleShare = VZSingleDirectoryShare(directory: shareDir)
                let fsDevice = VZVirtioFileSystemDeviceConfiguration(tag: tag)
                fsDevice.share = singleShare
                fsDevices.append(fsDevice)
                print("  Share: \(tag) -> \(path)")
            }
        }
        config.directorySharingDevices = fsDevices

        // Entropy device (for /dev/random)
        if minimal {
            print("[VZ] Entropy device DISABLED (--minimal flag)")
            config.entropyDevices = []
        } else {
            config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        }

        // Validate configuration
        do {
            try config.validate()
            print("[VZ] Configuration validated successfully")
        } catch {
            print("[VZ] Configuration validation FAILED: \(error)")
            throw VMError.configError("Invalid VM configuration: \(error)")
        }

        // Print detailed config info for debugging
        print("[VZ] Config details:")
        print("[VZ]   CPU count: \(config.cpuCount)")
        print("[VZ]   Memory: \(config.memorySize / 1024 / 1024) MB")
        print("[VZ]   Boot loader: \(type(of: config.bootLoader!))")
        if let linuxBoot = config.bootLoader as? VZLinuxBootLoader {
            print("[VZ]   Kernel URL: \(linuxBoot.kernelURL)")
            print("[VZ]   Initrd URL: \(String(describing: linuxBoot.initialRamdiskURL))")
            print("[VZ]   Command line: \(linuxBoot.commandLine)")
        }
        print("[VZ]   Storage devices: \(config.storageDevices.count)")
        print("[VZ]   Network devices: \(config.networkDevices.count)")
        print("[VZ]   Socket devices: \(config.socketDevices.count)")
        print("[VZ]   Directory shares: \(config.directorySharingDevices.count)")
        fflush(stdout)

        // Check if running on main thread (required for VZ)
        print("[VZ] Running on main thread: \(Thread.isMainThread)")
        fflush(stdout)

        // Create and start VM
        let vm = VZVirtualMachine(configuration: config)
        print("[VZ] VM object created, canStart: \(vm.canStart)")
        globalVM = vm
        let delegate = VMDelegate()
        vm.delegate = delegate

        print("[VZ] About to call vm.start()...")
        fflush(stdout)

        var startError: Error?
        var vmStarted = false

        // vm.start() callback is dispatched to the main queue, so we can't block the main thread
        // Instead, we use RunLoop to process events while waiting
        vm.start { result in
            print("[VZ] vm.start callback received")
            fflush(stdout)
            switch result {
            case .success:
                print("[VZ] VM started successfully")
                fflush(stdout)
                vmStarted = true
            case .failure(let error):
                print("[VZ] VM start failed: \(error)")
                fflush(stdout)
                startError = error
            }
        }

        print("[VZ] Waiting for VM to start (polling with RunLoop)...")
        fflush(stdout)

        // Poll with RunLoop to allow callbacks to be delivered
        let deadline = Date().addingTimeInterval(60)
        while !vmStarted && startError == nil && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }

        if let error = startError {
            throw VMError.startFailed("Failed to start VM: \(error)")
        }

        if !vmStarted {
            print("[VZ] ERROR: vm.start() timed out after 60s")
            fflush(stdout)
            throw VMError.startFailed("VM start timed out")
        }

        if let error = startError {
            throw VMError.startFailed("Failed to start VM: \(error)")
        }

        print("[VZ] VM state: \(vm.state.rawValue) (0=stopped, 1=running, 2=paused, 3=error, 4=starting, 5=pausing, 6=resuming, 7=stopping, 8=saving, 9=restoring)")

        // Start TCP-to-vsock port forwarders (store in global array to prevent deallocation)
        print("[VZ] Setting up port forwarders...")
        globalForwarders = []
        for pf in portForwards {
            print("[VZ] Creating forwarder for localhost:\(pf.hostPort) -> vsock:\(pf.guestPort)")
            let forwarder = TCPToVsockForwarder(
                hostPort: pf.hostPort,
                guestVsockPort: pf.guestPort,
                vm: vm
            )
            do {
                try forwarder.start()
                globalForwarders.append(forwarder)
                print("[VZ] Port forwarder STARTED: localhost:\(pf.hostPort) -> vsock:\(pf.guestPort)")
            } catch {
                print("[VZ] ERROR: Failed to start port forwarder for \(pf.hostPort): \(error)")
            }
        }
        print("[VZ] Total forwarders active: \(globalForwarders.count)")

        // Log vsock device availability
        if let vsockDevice = vm.socketDevices.first as? VZVirtioSocketDevice {
            print("[VZ] Vsock device available")
        } else {
            print("[VZ] WARNING: No vsock device found!")
        }

        // Set up reverse forwarders: accept guest-initiated vsock connections and
        // bridge them to host loopback TCP (e.g. the control plane on :8787). This
        // is what gives the sandbox a guest->host route to call the control plane.
        if !reversePortForwards.isEmpty {
            globalVsockListeners = []
            if let vsockDevice = vm.socketDevices.first as? VZVirtioSocketDevice {
                for rpf in reversePortForwards {
                    let l = VsockListener(vsockPort: rpf.vsockPort, hostPort: rpf.hostPort)
                    let vzl = VZVirtioSocketListener()
                    vzl.delegate = l
                    l.vzListener = vzl
                    vsockDevice.setSocketListener(vzl, forPort: rpf.vsockPort)
                    globalVsockListeners.append(l)
                    print("[VZ] Reverse forwarder ACTIVE: guest vsock:\(rpf.vsockPort) -> host 127.0.0.1:\(rpf.hostPort)")
                }
            } else {
                print("[VZ] WARNING: reverse port forwards requested but no vsock device found")
            }
            fflush(stdout)
        }

        // Keep the guest wall clock in step with the host. The guest has no NTP and
        // its clock stops while the host sleeps, so without this every signed
        // control-plane request fails after a sleep ("issued in the future").
        if guestTimeSyncPort > 0 {
            let ts = GuestTimeSync(vm: vm, port: guestTimeSyncPort)
            globalTimeSync = ts
            ts.start()
        }

        // Handle signals for graceful shutdown
        signal(SIGINT) { _ in
            print("\nReceived SIGINT, shutting down...")
            Foundation.exit(0)
        }
        signal(SIGTERM) { _ in
            print("\nReceived SIGTERM, shutting down...")
            Foundation.exit(0)
        }

        // Run until VM stops
        print("VM is running. Press Ctrl+C to stop.")
        RunLoop.main.run()
    }
}

// MARK: - TCP to Vsock Port Forwarder

/// Listens on a host TCP port and forwards connections to guest via vsock
class TCPToVsockForwarder {
    let hostPort: UInt16
    let guestVsockPort: UInt32
    weak var vm: VZVirtualMachine?
    private var listener: NWListener?
    private var connections: [UUID: ConnectionBridge] = [:]
    private let queue = DispatchQueue(label: "vsock-forwarder")
    private static let failureLogQueue = DispatchQueue(label: "vsock-forwarder-failures")
    private static var lastFailureLog: Date = .distantPast
    private static var suppressedFailures: Int = 0

    init(hostPort: UInt16, guestVsockPort: UInt32, vm: VZVirtualMachine) {
        self.hostPort = hostPort
        self.guestVsockPort = guestVsockPort
        self.vm = vm
    }

    func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true

        guard let port = NWEndpoint.Port(rawValue: hostPort) else {
            throw NSError(domain: "TCPForwarder", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid port: \(hostPort)"])
        }

        // Bind LOOPBACK only. The forwarder is reached solely by host-local
        // services (control plane, health checks), never the network, so exposing
        // it on all interfaces (`*:port`) was needless attack surface. It also
        // makes the bind match the Rust free-port probe (127.0.0.1): a busy port
        // is now actually detected, so a dynamic one is chosen instead of the VM
        // colliding on the wildcard.
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: port)

        listener = try NWListener(using: params)

        // Capture hostPort directly to avoid weak self issues in logging
        let capturedHostPort = hostPort
        let capturedGuestPort = guestVsockPort

        listener?.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let actualPort = self?.listener?.port?.rawValue {
                    print("[TCP] Listener READY on port \(actualPort) (requested \(capturedHostPort))")
                } else {
                    print("[TCP] Listener READY on port \(capturedHostPort)")
                }
            case .failed(let error):
                print("[TCP] Listener FAILED on port \(capturedHostPort): \(error)")
            case .waiting(let error):
                print("[TCP] Listener WAITING on port \(capturedHostPort): \(error)")
            case .cancelled:
                print("[TCP] Listener cancelled on port \(capturedHostPort)")
            case .setup:
                print("[TCP] Listener setup for port \(capturedHostPort)...")
            @unknown default:
                print("[TCP] Listener unknown state for port \(capturedHostPort)")
            }
            fflush(stdout)
        }

        listener?.newConnectionHandler = { [weak self] connection in
            guard let strongSelf = self else {
                print("[TCP] ERROR: Forwarder was deallocated, cannot handle connection!")
                fflush(stdout)
                connection.cancel()
                return
            }
            strongSelf.handleNewConnection(connection)
        }

        listener?.start(queue: queue)
        print("[TCP] Listener start() called for port \(hostPort)")
        fflush(stdout)
    }

    func stop() {
        listener?.cancel()
        listener = nil
        for (_, bridge) in connections {
            bridge.close()
        }
        connections.removeAll()
    }

    private func handleNewConnection(_ tcpConnection: NWConnection) {
        guard let vm = vm else {
            print("[CONN] ERROR: VM not available, rejecting connection")
            fflush(stdout)
            tcpConnection.cancel()
            return
        }

        guard let vsockDevice = vm.socketDevices.first as? VZVirtioSocketDevice else {
            print("[CONN] ERROR: No vsock device available, rejecting connection")
            print("[CONN] Socket devices count: \(vm.socketDevices.count)")
            fflush(stdout)
            tcpConnection.cancel()
            return
        }

        let connectionId = UUID()

        // Connect to guest via vsock (must be on main thread for VZ operations)
        DispatchQueue.main.async {
            vsockDevice.connect(toPort: self.guestVsockPort) { [weak self] result in
            switch result {
            case .success(let vsockConnection):
                print("[CONN] Vsock connection established (fd=\(vsockConnection.fileDescriptor))")
                fflush(stdout)
                let bridge = ConnectionBridge(
                    id: connectionId,
                    tcpConnection: tcpConnection,
                    vsockConnection: vsockConnection
                ) { [weak self] id in
                    self?.queue.async {
                        print("[CONN] \(id.uuidString.prefix(8)): Connection closed, removing from pool")
                        fflush(stdout)
                        self?.connections.removeValue(forKey: id)
                    }
                }
                self?.queue.async {
                    self?.connections[connectionId] = bridge
                    bridge.start()
                    print("[CONN] \(connectionId.uuidString.prefix(8)): Bridge started")
                    fflush(stdout)
                }
            case .failure(let error):
                TCPToVsockForwarder.logConnectFailure(error)
                tcpConnection.cancel()
            }
        }
        } // end DispatchQueue.main.async
    }

    private static func logConnectFailure(_ error: Error) {
        let now = Date()
        failureLogQueue.async {
            let elapsed = now.timeIntervalSince(lastFailureLog)
            if elapsed < 5.0 {
                suppressedFailures += 1
                return
            }

            if suppressedFailures > 0 {
                print("[CONN] Vsock connect failed: \(error) (suppressed \(suppressedFailures) similar errors)")
                suppressedFailures = 0
            } else {
                print("[CONN] Vsock connect failed: \(error)")
            }
            lastFailureLog = now
            fflush(stdout)
        }
    }
}

// MARK: - Reverse Vsock Listener (guest -> host)

/// Accepts guest-initiated vsock connections on `vsockPort` and bridges each to a
/// host loopback TCP service at 127.0.0.1:`hostPort`. The inverse of
/// TCPToVsockForwarder: it gives the guest a route to host-only services (the
/// control plane on :8787) without exposing anything on a network interface.
/// The guest side runs `socat TCP-LISTEN:hostPort ... VSOCK-CONNECT:2:vsockPort`.
class VsockListener: NSObject, VZVirtioSocketListenerDelegate {
    let vsockPort: UInt32
    let hostPort: UInt16
    var vzListener: VZVirtioSocketListener?
    private var connections: [UUID: ConnectionBridge] = [:]
    private let queue = DispatchQueue(label: "vsock-listener")

    init(vsockPort: UInt32, hostPort: UInt16) {
        self.vsockPort = vsockPort
        self.hostPort = hostPort
    }

    func listener(_ listener: VZVirtioSocketListener,
                  shouldAcceptNewConnection connection: VZVirtioSocketConnection,
                  from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard let port = NWEndpoint.Port(rawValue: hostPort) else { return false }
        let id = UUID()
        // Outbound TCP to the host loopback service; ConnectionBridge starts it.
        let tcp = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
        print("[RCONN] \(id.uuidString.prefix(8)): guest vsock:\(vsockPort) -> host 127.0.0.1:\(hostPort)")
        fflush(stdout)
        let bridge = ConnectionBridge(id: id, tcpConnection: tcp, vsockConnection: connection) { [weak self] cid in
            self?.queue.async {
                print("[RCONN] \(cid.uuidString.prefix(8)): closed, removing from pool")
                fflush(stdout)
                self?.connections.removeValue(forKey: cid)
            }
        }
        queue.async {
            self.connections[id] = bridge
            bridge.start()
        }
        return true
    }
}

// MARK: - Guest clock sync (host -> guest)

/// Pushes the host's UTC time to the guest's root-only time-sync daemon
/// (`orcabot-guest-timesync`, sandbox/cmd/guest-timesync) over vsock. The guest
/// steps its clock when the drift exceeds 2s and replies with the delta.
///
/// When: right after boot (retried every 5s until the guest daemon answers), on
/// host wake (NSWorkspace.didWakeNotification, plus a wall-clock-vs-uptime jump
/// check as a backstop since uptime stops while the Mac sleeps), and every 60s.
///
/// Only the host can reach this: the guest listens on a reserved vsock port and
/// drops any peer that isn't CID 2 (the host), so agent processes can't set the
/// time. Nothing is exposed on a host TCP port either.
final class GuestTimeSync {
    let port: UInt32
    weak var vm: VZVirtualMachine?

    static let tick: TimeInterval = 5
    static let period: TimeInterval = 60
    static let wakeJumpThreshold: TimeInterval = 3
    /// Before the first success, retry every tick for this many attempts (~2 min,
    /// covers guest boot), then fall back to the period (e.g. an old VM image
    /// without the daemon) so we don't spin forever.
    static let bootFastAttempts = 24

    private var timer: DispatchSourceTimer?
    private var wakeObserver: NSObjectProtocol?
    private var lastWall = Date()
    private var lastUptime = ProcessInfo.processInfo.systemUptime
    private var nextDue = Date()
    private var everSynced = false
    private var inFlight = false
    private var inFlightSince = Date.distantPast
    /// Bumped per attempt so a late completion of an abandoned attempt is ignored.
    private var attempt: UInt64 = 0
    static let attemptTimeout: TimeInterval = 20
    private var consecutiveFailures = 0
    private var lastFailureLog: Date = .distantPast
    private let ioQueue = DispatchQueue(label: "guest-timesync-io")

    init(vm: VZVirtualMachine, port: UInt32) {
        self.vm = vm
        self.port = port
    }

    private func log(_ msg: String) {
        print("[timesync] \(msg)")
        fflush(stdout)
    }

    /// Everything runs on the main queue (VZ socket APIs require it); only the
    /// blocking socket I/O hops to ioQueue.
    func start() {
        log("REVISION: \(vzHelperRevision) guest clock sync -> vsock:\(port) (tick \(Int(Self.tick))s, period \(Int(Self.period))s) started at \(ISO8601DateFormatter().string(from: Date()))")
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            self.log("host wake notification -> syncing guest clock")
            self.syncNоw(reason: "wake")
            // The VM may need a moment to resume; push once more shortly after.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.syncNоw(reason: "wake+3s")
            }
        }
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 1, repeating: Self.tick, leeway: .milliseconds(500))
        t.setEventHandler { [weak self] in self?.оnTick() }
        t.resume()
        timer = t
    }

    private func оnTick() {
        let now = Date()
        let up = ProcessInfo.processInfo.systemUptime
        // systemUptime does not advance while the Mac sleeps, wall time does: a
        // gap between the two means we just woke (or the host clock was changed).
        let jump = now.timeIntervalSince(lastWall) - (up - lastUptime)
        lastWall = now
        lastUptime = up
        if abs(jump) > Self.wakeJumpThreshold {
            log(String(format: "host wall clock jumped %.1fs relative to uptime (sleep/wake or clock change) -> syncing", jump))
            syncNоw(reason: "wall-jump")
            return
        }
        if now >= nextDue {
            syncNоw(reason: everSynced ? "periodic" : "boot")
        }
    }

    func syncNоw(reason: String) {
        if inFlight {
            // Never let one hung attempt (e.g. a vsock connect that never
            // completes) wedge the sync forever: abandon it after a timeout.
            guard Date().timeIntervalSince(inFlightSince) > Self.attemptTimeout else { return }
            finish(reason: reason, reply: nil, error: "previous attempt hung > \(Int(Self.attemptTimeout))s", id: attempt)
        }
        guard let vm = vm, vm.state == .running,
              let device = vm.socketDevices.first as? VZVirtioSocketDevice else {
            return
        }
        attempt &+= 1
        let id = attempt
        inFlight = true
        inFlightSince = Date()
        let port = self.port
        device.connect(toPort: port) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let error):
                self.finish(reason: reason, reply: nil, error: "vsock connect: \(error.localizedDescription)", id: id)
            case .success(let conn):
                self.ioQueue.async {
                    let (reply, err) = GuestTimeSync.еxchange(fd: conn.fileDescriptor)
                    conn.close()
                    DispatchQueue.main.async {
                        self.finish(reason: reason, reply: reply, error: err, id: id)
                    }
                }
            }
        }
    }

    /// One request/reply on a connected vsock fd. Host time is read immediately
    /// before the write so connection setup latency doesn't count as drift.
    static func еxchange(fd: Int32) -> (String?, String?) {
        let flags = fcntl(fd, F_GETFL)
        if flags >= 0 { _ = fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) }
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        var ts = timespec()
        clock_gettime(CLOCK_REALTIME, &ts)
        let ns = Int64(ts.tv_sec) * 1_000_000_000 + Int64(ts.tv_nsec)
        let req = Data("ORCABOT-TIMESYNC 1 \(ns)\n".utf8)
        if !ConnectionBridge.writеAll(fd, req) {
            return (nil, "write failed: errno=\(errno)")
        }
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 256)
        while out.count < 512 {
            let n = Darwin.read(fd, &buf, buf.count)
            if n > 0 {
                out.append(contentsOf: buf[0..<n])
                if out.contains(UInt8(ascii: "\n")) { break }
            } else if n < 0 && errno == EINTR {
                continue
            } else if n == 0 {
                break
            } else {
                return (nil, "read failed: errno=\(errno)")
            }
        }
        let line = String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if line.isEmpty {
            // Guest daemon closed without replying: it rejected the peer or
            // nothing is listening (old VM image without orcabot-guest-timesync).
            return (nil, "no reply (guest daemon missing on an older VM image?)")
        }
        return (line, nil)
    }

    private func finish(reason: String, reply: String?, error: String?, id: UInt64) {
        guard id == attempt, inFlight else { return }  // stale/abandoned attempt
        inFlight = false
        let now = Date()
        if let reply = reply, reply.hasPrefix("OK ") {
            let fields = Dictionary(
                reply.split(separator: " ").dropFirst().compactMap { kv -> (String, String)? in
                    let p = kv.split(separator: "=", maxSplits: 1)
                    return p.count == 2 ? (String(p[0]), String(p[1])) : nil
                },
                uniquingKeysWith: { a, _ in a })
            let before = fields["before_ms"] ?? "?"
            let after = fields["after_ms"] ?? "?"
            if fields["stepped"] == "1" {
                log("guest clock STEPPED (\(reason)): delta before=\(before)ms after=\(after)ms (positive = guest was behind)")
            } else if !everSynced {
                log("guest clock in sync (\(reason)): delta=\(before)ms, guest \(fields["rev"] ?? "?")")
            }
            if consecutiveFailures > 0 && everSynced {
                log("guest clock sync recovered after \(consecutiveFailures) failure(s)")
            }
            everSynced = true
            consecutiveFailures = 0
            nextDue = now.addingTimeInterval(Self.period)
            return
        }

        consecutiveFailures += 1
        let detail = error ?? "unexpected reply: \(reply ?? "")"
        if everSynced {
            nextDue = now.addingTimeInterval(10)
        } else if consecutiveFailures < Self.bootFastAttempts {
            // tick - 1: due again on the very next timer tick, not the one after.
            nextDue = now.addingTimeInterval(Self.tick - 1)
        } else {
            nextDue = now.addingTimeInterval(Self.period)
        }
        // Quiet while the guest is still booting; afterwards at most every 5 min.
        let booting = !everSynced && consecutiveFailures < Self.bootFastAttempts
        if !booting && now.timeIntervalSince(lastFailureLog) >= 300 {
            lastFailureLog = now
            log("guest clock sync failed (\(reason), \(consecutiveFailures) in a row): \(detail)")
        }
    }
}

// MARK: - Bidirectional Connection Bridge

/// Bridges data between a TCP NWConnection and a VZVirtioSocketConnection
class ConnectionBridge {
    let id: UUID
    let tcpConnection: NWConnection
    let vsockConnection: VZVirtioSocketConnection
    let onClose: (UUID) -> Void

    private var tcpOpen = true
    private var vsockOpen = true
    private let queue = DispatchQueue(label: "connection-bridge")
    private var vsockReadSource: DispatchSourceRead?
    // Armed only while the guest's vsock buffer is full; cancelled once drained.
    private var vsockWriteSource: DispatchSourceWrite?
    // TCP->vsock bytes not yet accepted by the guest. Writes never block the
    // queue (that also stopped vsock->TCP draining, deadlocking against the
    // guest's one-direction-at-a-time socat); instead TCP reads pause while this
    // is above the high-water mark and resume once it's flushed (backpressure).
    private var pendingOut = Data()
    private var pendingOffset = 0
    private var tcpReadPaused = false
    private var tcpEOF = false
    private static let pendingHighWater = 1 << 20
    private static let verboseLogs = ProcessInfo.processInfo.environment["VZ_BRIDGE_VERBOSE"] == "1"

    init(id: UUID, tcpConnection: NWConnection, vsockConnection: VZVirtioSocketConnection, onClose: @escaping (UUID) -> Void) {
        self.id = id
        self.tcpConnection = tcpConnection
        self.vsockConnection = vsockConnection
        self.onClose = onClose
    }

    func start() {
        let connId = id.uuidString.prefix(8)
        tcpConnection.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            let connId = self.id.uuidString.prefix(8)
            switch state {
            case .ready:
                print("[BRIDGE] \(connId): TCP ready, starting read loop")
                self.startReadingFromTCP()
            case .failed(let error):
                print("[BRIDGE] \(connId): TCP failed: \(error)")
                self.close()
            case .cancelled:
                print("[BRIDGE] \(connId): TCP cancelled")
                self.close()
            case .waiting(let error):
                if ConnectionBridge.verboseLogs {
                    print("[BRIDGE] \(connId): TCP waiting: \(error)")
                }
            case .setup:
                if ConnectionBridge.verboseLogs {
                    print("[BRIDGE] \(connId): TCP setup")
                }
            case .preparing:
                if ConnectionBridge.verboseLogs {
                    print("[BRIDGE] \(connId): TCP preparing")
                }
            @unknown default:
                if ConnectionBridge.verboseLogs {
                    print("[BRIDGE] \(connId): TCP unknown state")
                }
            }
        }
        tcpConnection.start(queue: queue)
        if ConnectionBridge.verboseLogs {
            print("[BRIDGE] \(connId): TCP connection start() called")
        }

        // Start reading from vsock
        startReadingFromVsock()
        if ConnectionBridge.verboseLogs {
            print("[BRIDGE] \(connId): Vsock read loop started")
        }
    }

    func close() {
        queue.async { [weak self] in
            guard let self = self else { return }
            if self.tcpOpen {
                self.tcpOpen = false
                self.tcpConnection.cancel()
            }
            if self.vsockOpen {
                self.vsockOpen = false
                self.vsockReadSource?.cancel()
                self.vsockReadSource = nil
                self.vsockWriteSource?.cancel()
                self.vsockWriteSource = nil
                self.pendingOut = Data()
                self.pendingOffset = 0
                Darwin.close(self.vsockConnection.fileDescriptor)
            }
            self.onClose(self.id)
        }
    }

    private func startReadingFromTCP() {
        let connId = id.uuidString.prefix(8)
        tcpConnection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            let connId = self.id.uuidString.prefix(8)

            if let error = error {
                print("[BRIDGE] \(connId): TCP read error: \(error)")
                self.close()
                return
            }

            if let data = data, !data.isEmpty {
                if ConnectionBridge.verboseLogs {
                    print("[BRIDGE] \(connId): TCP->Vsock \(data.count) bytes")
                }
                // The vsock fd is non-blocking (see startReadingFromVsock), so one
                // write() can take only part of the data, or none (EAGAIN) once the
                // guest's buffer is full (~8KB). Every byte is queued and flushed
                // in order (dropping the rest truncated larger transfers, e.g. file
                // uploads and big control-plane responses).
                guard self.vsockOpen else { return }
                self.pendingOut.append(data)
                if !self.flushPendingTоVsоck() { return }
            }

            if isComplete {
                // Close only after everything the client sent reached the guest.
                self.tcpEOF = true
                if self.pendingOut.count - self.pendingOffset == 0 {
                    print("[BRIDGE] \(connId): TCP complete, closing")
                    self.close()
                } else {
                    print("[BRIDGE] \(connId): TCP complete, closing after \(self.pendingOut.count - self.pendingOffset) pending bytes flush")
                }
            } else if self.tcpOpen {
                if self.pendingOut.count - self.pendingOffset > ConnectionBridge.pendingHighWater {
                    self.tcpReadPaused = true
                } else {
                    self.startReadingFromTCP()
                }
            }
        }
    }

    /// Write as much of `pendingOut` to the vsock as it accepts without
    /// blocking. On EAGAIN, arms a write source that calls back here once the
    /// guest drains its buffer. When fully flushed: resumes paused TCP reads, or
    /// closes if TCP already hit EOF. Returns false if the bridge was closed on
    /// error. Runs only on `queue`.
    @discardableResult
    private func flushPendingTоVsоck() -> Bool {
        guard vsockOpen else { return false }
        let fd = vsockConnection.fileDescriptor
        let connId = id.uuidString.prefix(8)
        var writeErrno: Int32 = 0
        let written: Int = pendingOut.withUnsafeBytes { raw -> Int in
            guard let base = raw.baseAddress else { return 0 }
            var off = pendingOffset
            while off < raw.count {
                let n = Darwin.write(fd, base.advanced(by: off), raw.count - off)
                if n > 0 {
                    off += n
                    continue
                }
                let e = errno
                if n < 0 && e == EINTR { continue }
                if n < 0 && (e == EAGAIN || e == EWOULDBLOCK) { break }
                writeErrno = n < 0 ? e : EPIPE
                break
            }
            return off - pendingOffset
        }
        pendingOffset += written
        if writeErrno != 0 {
            print("[BRIDGE] \(connId): Vsock write error: errno=\(writeErrno) (\(String(cString: strerror(writeErrno))))")
            close()
            return false
        }

        if pendingOffset >= pendingOut.count {
            // Fully flushed.
            pendingOut.removeAll(keepingCapacity: pendingOut.count <= ConnectionBridge.pendingHighWater)
            pendingOffset = 0
            vsockWriteSource?.cancel()
            vsockWriteSource = nil
            if tcpEOF {
                print("[BRIDGE] \(connId): TCP complete and pending flushed, closing")
                close()
                return false
            }
            if tcpReadPaused && tcpOpen {
                tcpReadPaused = false
                startReadingFromTCP()
            }
            return true
        }

        // Compact once the consumed prefix dominates, so the buffer stays bounded.
        if pendingOffset > 65536 && pendingOffset * 2 > pendingOut.count {
            pendingOut.removeSubrange(0..<pendingOffset)
            pendingOffset = 0
        }
        if vsockWriteSource == nil {
            let ws = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
            ws.setEventHandler { [weak self] in
                self?.flushPendingTоVsоck()
            }
            vsockWriteSource = ws
            ws.resume()
        }
        return true
    }

    /// Write all of `data` to a non-blocking fd, waiting (up to 30s at a time)
    /// for buffer space on EAGAIN. Blocks the calling thread, so only for small
    /// one-shot writes (guest time sync); the bridge uses flushPendingTоVsоck.
    /// On failure errno describes the cause (ETIMEDOUT on a poll timeout).
    static func writеAll(_ fd: Int32, _ data: Data) -> Bool {
        return data.withUnsafeBytes { raw -> Bool in
            guard var ptr = raw.baseAddress else { return true }
            var remaining = raw.count
            while remaining > 0 {
                let n = Darwin.write(fd, ptr, remaining)
                if n > 0 {
                    ptr = ptr.advanced(by: n)
                    remaining -= n
                } else if n < 0 && errno == EINTR {
                    continue
                } else if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                    let r = poll(&pfd, 1, 30_000)
                    if r == 0 { errno = ETIMEDOUT; return false }
                    if r < 0 {
                        if errno == EINTR { continue }
                        return false
                    }
                } else {
                    return false
                }
            }
            return true
        }
    }

    private func startReadingFromVsock() {
        let fd = vsockConnection.fileDescriptor
        let connId = id.uuidString.prefix(8)

        // Make file descriptor non-blocking
        let flags = fcntl(fd, F_GETFL)
        _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        // Create dispatch source for reading
        let readSource = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        vsockReadSource = readSource

        readSource.setEventHandler { [weak self] in
            guard let self = self, self.vsockOpen else { return }
            let connId = self.id.uuidString.prefix(8)

            var buffer = [UInt8](repeating: 0, count: 65536)
            let bytesRead = Darwin.read(fd, &buffer, buffer.count)
            let readErrno = errno

            if bytesRead > 0 {
                if ConnectionBridge.verboseLogs {
                    print("[BRIDGE] \(connId): Vsock->TCP \(bytesRead) bytes")
                }
                let data = Data(bytes: buffer, count: bytesRead)
                self.tcpConnection.send(content: data, completion: .contentProcessed { error in
                    if let error = error {
                        print("[BRIDGE] \(connId): TCP write error: \(error)")
                        self.close()
                    }
                })
            } else if bytesRead == 0 {
                // EOF
                print("[BRIDGE] \(connId): Vsock EOF, closing")
                self.close()
            } else if readErrno != EAGAIN && readErrno != EWOULDBLOCK && readErrno != EINTR {
                // Real error
                print("[BRIDGE] \(connId): Vsock read error: errno=\(readErrno)")
                self.close()
            }
        }

        readSource.setCancelHandler { [weak self] in
            guard let self = self else { return }
            if ConnectionBridge.verboseLogs {
                print("[BRIDGE] \(self.id.uuidString.prefix(8)): Vsock read source cancelled")
            }
            self.vsockOpen = false
        }

        readSource.resume()
    }
}

// MARK: - VM Delegate

class VMDelegate: NSObject, VZVirtualMachineDelegate {
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        print("VM stopped with error: \(error)")
        Foundation.exit(1)
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        print("Guest stopped")
        Foundation.exit(0)
    }
}

// MARK: - Errors

enum VMError: Error, CustomStringConvertible {
    case fileNotFound(String)
    case configError(String)
    case startFailed(String)

    var description: String {
        switch self {
        case .fileNotFound(let msg): return msg
        case .configError(let msg): return msg
        case .startFailed(let msg): return msg
        }
    }
}
