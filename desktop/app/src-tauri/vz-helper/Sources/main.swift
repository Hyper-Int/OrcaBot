import Foundation
import Virtualization
import ArgumentParser
import Network

// MARK: - Global references to prevent deallocation
var globalVM: VZVirtualMachine?
var globalForwarders: [TCPToVsockForwarder] = []
var globalConsolePipe: Pipe?
var globalConsoleLogFile: FileHandle?

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

    @Flag(name: .long, help: "Disable directory sharing (for debugging)")
    var noShare: Bool = false

    @Flag(name: .long, help: "Disable disk attachment (for debugging)")
    var noDisk: Bool = false

    @Flag(name: .long, help: "Minimal config: just kernel+initrd+serial (for debugging)")
    var minimal: Bool = false

    mutating func run() throws {
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

        listener = try NWListener(using: params, on: port)

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
    private var vsockWriteSource: DispatchSourceWrite?
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
                // Write to vsock using file descriptor
                data.withUnsafeBytes { buffer in
                    if let ptr = buffer.baseAddress {
                        let written = Darwin.write(self.vsockConnection.fileDescriptor, ptr, buffer.count)
                        if written < 0 {
                            print("[BRIDGE] \(connId): Vsock write error: \(errno)")
                        }
                    }
                }
            }

            if isComplete {
                print("[BRIDGE] \(connId): TCP complete, closing")
                self.close()
            } else if self.tcpOpen {
                self.startReadingFromTCP()
            }
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
            } else if errno != EAGAIN && errno != EWOULDBLOCK {
                // Real error
                print("[BRIDGE] \(connId): Vsock read error: errno=\(errno)")
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
