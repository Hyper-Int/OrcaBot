#!/sbin/openrc-run
# OpenRC init script for Orcabot sandbox server
#
# This script starts the sandbox server inside the VM,
# using environment variables passed from the host.

name="orcabot"
description="Orcabot Sandbox Server"
command="/usr/local/bin/orcabot-server"
command_user="root"
command_background="yes"
pidfile="/run/${RC_SVCNAME}.pid"
output_log="/var/log/orcabot.log"
error_log="/var/log/orcabot.err"

# Default configuration
: ${WORKSPACE_BASE:=/workspace}
: ${PORT:=8080}
: ${SANDBOX_INTERNAL_TOKEN:=}
: ${ALLOWED_ORIGINS:=*}

depend() {
    need net
    after firewall
}

start_pre() {
    # Ensure workspace directory exists
    mkdir -p "$WORKSPACE_BASE"
    chown sandbox:sandbox "$WORKSPACE_BASE"

    # Mount VirtioFS workspace if available
    if grep -q "workspace" /proc/filesystems 2>/dev/null || \
       grep -q "virtiofs" /proc/filesystems 2>/dev/null; then
        if ! mountpoint -q "$WORKSPACE_BASE"; then
            einfo "Mounting VirtioFS workspace..."
            mount -t virtiofs workspace "$WORKSPACE_BASE" 2>/dev/null || \
            mount -t 9p workspace "$WORKSPACE_BASE" -o trans=virtio,version=9p2000.L 2>/dev/null || \
            ewarn "Could not mount shared workspace"
        fi
    fi

    # Load vsock kernel modules for host communication
    modprobe vsock 2>/dev/null || true
    modprobe virtio_vsock 2>/dev/null || true
    modprobe vmw_vsock_virtio_transport 2>/dev/null || true

    # Start vsock-to-TCP bridge for host access
    # This allows the host to connect via vsock and reach localhost:8080
    if command -v socat >/dev/null 2>&1; then
        einfo "Starting vsock bridge..."
        start-stop-daemon --start \
            --background \
            --make-pidfile \
            --pidfile /run/vsock-bridge.pid \
            --stdout /var/log/vsock-bridge.log \
            --stderr /var/log/vsock-bridge.log \
            --exec /usr/bin/socat -- \
            VSOCK-LISTEN:${PORT},reuseaddr,fork TCP:127.0.0.1:${PORT}
    fi

    # Load environment from /etc/orcabot.env if it exists
    if [ -f /etc/orcabot.env ]; then
        . /etc/orcabot.env
    fi

    # Ensure log directory exists
    mkdir -p "$(dirname "$output_log")"

    checkpath --file --owner root:root --mode 0644 "$output_log"
    checkpath --file --owner root:root --mode 0644 "$error_log"

    return 0
}

start() {
    ebegin "Starting ${name}"

    export WORKSPACE_BASE PORT SANDBOX_INTERNAL_TOKEN ALLOWED_ORIGINS

    start-stop-daemon --start \
        --background \
        --make-pidfile \
        --pidfile "$pidfile" \
        --stdout "$output_log" \
        --stderr "$error_log" \
        --exec "$command"

    eend $?
}

stop() {
    ebegin "Stopping ${name}"
    # Stop vsock bridge first
    if [ -f /run/vsock-bridge.pid ]; then
        start-stop-daemon --stop --pidfile /run/vsock-bridge.pid 2>/dev/null || true
        rm -f /run/vsock-bridge.pid
    fi
    start-stop-daemon --stop --pidfile "$pidfile"
    eend $?
}

status() {
    if [ -f "$pidfile" ]; then
        if kill -0 "$(cat "$pidfile")" 2>/dev/null; then
            einfo "${name} is running (pid: $(cat "$pidfile"))"
            return 0
        fi
    fi
    einfo "${name} is not running"
    return 3
}

# Health check function
healthcheck() {
    local url="http://127.0.0.1:${PORT}/health"
    if command -v curl >/dev/null 2>&1; then
        curl -sf "$url" >/dev/null 2>&1
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "$url" >/dev/null 2>&1
    else
        # Fallback: check if port is listening
        nc -z 127.0.0.1 "$PORT" 2>/dev/null
    fi
}
