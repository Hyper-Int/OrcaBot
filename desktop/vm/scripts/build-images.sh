#!/usr/bin/env bash
# Build VM images for all platforms from the sandbox Docker image.
#
# This script uses Docker as a BUILD TOOL to create disk images.
# The resulting images are self-contained and don't require Docker at runtime.
#
# Output:
#   - sandbox-rootfs.tar.gz  (for WSL2)
#   - sandbox.img            (bootable raw disk for macOS/Linux)
#   - sandbox.qcow2          (QCOW2 for Linux, optional)
#   - vmlinuz, initrd.img    (for direct kernel boot)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VM_DIR="$(dirname "$SCRIPT_DIR")"
DESKTOP_DIR="$(dirname "$VM_DIR")"
REPO_ROOT="$(dirname "$DESKTOP_DIR")"
SANDBOX_DIR="$REPO_ROOT/sandbox"
OUTPUT_DIR="$VM_DIR/image"

# Image settings
IMAGE_SIZE_MB="${IMAGE_SIZE_MB:-3072}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[build-images]${NC} $*"; }
warn() { echo -e "${YELLOW}[build-images]${NC} $*"; }
error() { echo -e "${RED}[build-images]${NC} $*" >&2; }

# Create output directory
mkdir -p "$OUTPUT_DIR"

# =============================================================================
# Step 1: Build sandbox Docker image
# =============================================================================
log "Building sandbox Docker image..."
docker build -t orcabot-sandbox:local -f "$SANDBOX_DIR/docker/Dockerfile" "$SANDBOX_DIR"

# =============================================================================
# Step 2: Export rootfs tarball (for WSL2)
# =============================================================================
log "Exporting rootfs tarball for WSL2..."
CONTAINER_ID=$(docker create orcabot-sandbox:local)
docker export "$CONTAINER_ID" | gzip > "$OUTPUT_DIR/sandbox-rootfs.tar.gz"
docker rm "$CONTAINER_ID" > /dev/null
log "Created: $OUTPUT_DIR/sandbox-rootfs.tar.gz"

# =============================================================================
# Step 3: Create bootable disk image using Docker
# =============================================================================
log "Creating bootable disk image (${IMAGE_SIZE_MB}MB)..."

# Create a builder container that can make disk images
# This runs as privileged to access loop devices
docker run --rm --privileged \
    -v "$OUTPUT_DIR:/output" \
    -v "$SANDBOX_DIR:/sandbox:ro" \
    -e IMAGE_SIZE_MB="$IMAGE_SIZE_MB" \
    debian:bookworm-slim \
    /bin/bash -c '
set -euo pipefail

apt-get update -qq
apt-get install -y -qq e2fsprogs tar gzip linux-image-cloud-arm64 kmod > /dev/null

echo "Creating disk image (${IMAGE_SIZE_MB}MB)..."
dd if=/dev/zero of=/output/sandbox.img bs=1M count=${IMAGE_SIZE_MB} status=progress

echo "Creating ext4 filesystem..."
mkfs.ext4 -F -L rootfs /output/sandbox.img

echo "Mounting and populating..."
mkdir -p /mnt/rootfs
mount -o loop /output/sandbox.img /mnt/rootfs

# Extract rootfs from tarball
echo "Extracting rootfs..."
gunzip -c /output/sandbox-rootfs.tar.gz | tar -xf - -C /mnt/rootfs

# Create essential directories
mkdir -p /mnt/rootfs/{proc,sys,dev,run,tmp}
chmod 1777 /mnt/rootfs/tmp

# =============================================================================
# Cleanup: strip unnecessary files BEFORE copying kernel modules.
# Must run first — the rootfs from Docker already contains ~2.5GB and the full
# kernel module tree is another 1.2GB, which would overflow a 3GB disk.
# =============================================================================

# Remove duplicate kernel modules from Docker export (in /usr/lib/modules AND /lib/modules)
echo "Removing kernel modules from Docker rootfs..."
rm -rf /mnt/rootfs/usr/lib/modules
rm -rf /mnt/rootfs/lib/modules

# Remove GCC/build artifacts (not needed at runtime)
echo "Removing build tools and headers..."
rm -rf /mnt/rootfs/usr/include
rm -f /mnt/rootfs/usr/bin/aarch64-linux-gnu-lto-dump*
rm -f /mnt/rootfs/usr/bin/aarch64-linux-gnu-ld.gold
rm -f /mnt/rootfs/usr/bin/aarch64-linux-gnu-dwp
rm -rf /mnt/rootfs/usr/lib/gcc

# Remove unnecessary /usr/share content (not needed in headless VM)
echo "Removing unnecessary share content..."
rm -rf /mnt/rootfs/usr/share/icons
rm -rf /mnt/rootfs/usr/share/vim
rm -rf /mnt/rootfs/usr/share/perl
rm -rf /mnt/rootfs/usr/share/perl5
rm -rf /mnt/rootfs/usr/share/doc
rm -rf /mnt/rootfs/usr/share/man
rm -rf /mnt/rootfs/usr/share/locale

# Clean package caches
echo "Cleaning package caches..."
rm -rf /mnt/rootfs/var/cache/apt
rm -rf /mnt/rootfs/var/lib/apt/lists

echo "Cleanup complete."
df -h /mnt/rootfs || true

# =============================================================================
# Copy ONLY the kernel modules the VM needs (virtio, vsock, ext4, fuse).
# The full module tree is ~1.2GB; we only need ~5-10MB.
# =============================================================================
KERNEL_VERSION=$(ls /lib/modules 2>/dev/null | sort | tail -1)
if [ -n "$KERNEL_VERSION" ]; then
  echo "Copying selected kernel modules: $KERNEL_VERSION"
  mkdir -p /mnt/rootfs/lib/modules/$KERNEL_VERSION/kernel
  # Copy only the modules we need from the host
  cd /lib/modules/$KERNEL_VERSION/kernel
  find . -type f \( -name "virtio*" -o -name "vsock*" -o -name "vmw_vsock*" \
         -o -name "ext4*" -o -name "fuse*" -o -name "virtiofs*" \
         -o -name "jbd2*" -o -name "mbcache*" -o -name "crc16*" \
         -o -name "crc32*" \) | while read f; do
    mkdir -p "/mnt/rootfs/lib/modules/$KERNEL_VERSION/kernel/$(dirname "$f")"
    cp "$f" "/mnt/rootfs/lib/modules/$KERNEL_VERSION/kernel/$f"
  done
  cd /
  # Copy module metadata files
  for meta in modules.builtin modules.builtin.modinfo modules.order; do
    if [ -f "/lib/modules/$KERNEL_VERSION/$meta" ]; then
      cp "/lib/modules/$KERNEL_VERSION/$meta" "/mnt/rootfs/lib/modules/$KERNEL_VERSION/"
    fi
  done
  # Regenerate modules.dep for the stripped set
  if command -v depmod >/dev/null 2>&1; then
    depmod -b /mnt/rootfs "$KERNEL_VERSION" 2>/dev/null || true
  fi
  echo "Kernel modules installed (stripped)."
  du -sh /mnt/rootfs/lib/modules/ || true
else
  echo "Warning: no /lib/modules found; vsock modules may be unavailable"
fi

# Install a minimal init so the VM can boot a Docker-rootfs image.
# Debian container rootfs has no init system; without this, the kernel
# drops to /bin/sh (or panics) and nothing starts.
mkdir -p /mnt/rootfs/sbin
cat > /mnt/rootfs/sbin/init << "MININIT"
#!/bin/sh
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev 2>/dev/null || mount -t devtmpfs dev /dev
mkdir -p /run /tmp /workspace
chmod 1777 /tmp

# Mount workspace if available
mount -t virtiofs workspace /workspace 2>/dev/null || \
mount -t 9p workspace /workspace -o trans=virtio,version=9p2000.L 2>/dev/null || true

# Log to the VM console for early debugging
exec >/dev/console 2>&1
echo "[init] starting orcabot sandbox"

# Load vsock modules if available
echo "Loading vsock modules..." > /dev/console
for mod in vsock virtio_vsock vmw_vsock_virtio_transport; do
  if modprobe -v "$mod" >/dev/console 2>&1; then
    echo "Loaded $mod" > /dev/console
  else
    echo "Failed to load $mod (exit=$?)" > /dev/console
  fi
done
if command -v lsmod >/dev/null 2>&1; then
  lsmod | grep -E "vsock|virtio_vsock" > /dev/console 2>/dev/null || true
else
  echo "lsmod not available; /proc/modules:" > /dev/console
  grep -E "vsock|virtio" /proc/modules > /dev/console 2>/dev/null || true
fi
if [ -e /dev/vsock ]; then
  echo "/dev/vsock present" > /dev/console
else
  echo "/dev/vsock missing" > /dev/console
fi
if command -v lsmod >/dev/null 2>&1; then
  lsmod | grep -E "vsock|virtio_vsock" > /dev/console 2>/dev/null || true
else
  echo "lsmod not available; /proc/modules:" > /dev/console
  grep -E "vsock|virtio" /proc/modules > /dev/console 2>/dev/null || true
fi

# Start vsock-to-TCP bridge (host connects to vsock, guest listens).
# The bridge must stay alive as long as the server runs, so we start both
# as children of PID 1 and wait. Using exec would orphan the background
# process, killing the bridge.
if command -v socat >/dev/null 2>&1; then
  echo "[init] starting vsock bridge on port ${PORT:-8080}" > /dev/console
  socat VSOCK-LISTEN:${PORT:-8080},reuseaddr,fork TCP:127.0.0.1:${PORT:-8080} &
  SOCAT_PID=$!
fi

echo "[init] starting orcabot-server" > /dev/console
/usr/local/bin/orcabot-server &
SERVER_PID=$!

# PID 1 must not exit — wait for the server (primary process).
# If it dies, clean up the bridge and halt.
wait $SERVER_PID 2>/dev/null
echo "[init] orcabot-server exited ($?)" > /dev/console
[ -n "${SOCAT_PID:-}" ] && kill $SOCAT_PID 2>/dev/null
# Keep kernel alive briefly for log flush, then halt
sleep 1
echo "[init] halting" > /dev/console
MININIT
chmod +x /mnt/rootfs/sbin/init

# Ensure init exists (fail fast if missing)
if [ ! -x /mnt/rootfs/sbin/init ]; then
    echo "ERROR: /sbin/init missing or not executable"
    exit 1
fi

# Note: socat is installed in the sandbox Docker image for vsock bridge support

# Create fstab for the VM
cat > /mnt/rootfs/etc/fstab << "FSTAB"
# <device>  <mount>  <type>  <options>  <dump>  <pass>
/dev/vda    /        ext4    defaults   0       1
proc        /proc    proc    defaults   0       0
sysfs       /sys     sysfs   defaults   0       0
devtmpfs    /dev     devtmpfs defaults  0       0
workspace   /workspace virtiofs rw,nofail,x-systemd.device-timeout=1 0 0
FSTAB

# Create init script to start sandbox on boot
cat > /mnt/rootfs/etc/init.d/orcabot << "INITSCRIPT"
#!/bin/sh
### BEGIN INIT INFO
# Provides:          orcabot
# Required-Start:    $network $local_fs
# Required-Stop:     $network $local_fs
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: Orcabot Sandbox Server
### END INIT INFO

case "$1" in
  start)
    echo "Starting Orcabot sandbox..."
    # Mount workspace if available
    mkdir -p /workspace
    mount -t virtiofs workspace /workspace 2>/dev/null || \
    mount -t 9p workspace /workspace -o trans=virtio,version=9p2000.L 2>/dev/null || true

    # Load vsock modules if available
    modprobe vsock 2>/dev/null || true
    modprobe virtio_vsock 2>/dev/null || true
    modprobe vmw_vsock_virtio_transport 2>/dev/null || true

    # Start vsock-to-TCP bridge (forwards vsock port 8080 to localhost:8080)
    # This allows the host to reach the sandbox server via virtio-vsock
    echo "Starting vsock bridge..."
    socat VSOCK-LISTEN:8080,reuseaddr,fork TCP:127.0.0.1:8080 > /var/log/vsock-bridge.log 2>&1 &
    echo $! > /var/run/vsock-bridge.pid

    # Start the sandbox server
    export PORT=${PORT:-8080}
    export WORKSPACE_BASE=/workspace
    export ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-*}
    /usr/local/bin/orcabot-server > /var/log/orcabot.log 2>&1 &
    echo $! > /var/run/orcabot.pid
    ;;
  stop)
    echo "Stopping Orcabot sandbox..."
    if [ -f /var/run/vsock-bridge.pid ]; then
      kill $(cat /var/run/vsock-bridge.pid) 2>/dev/null || true
      rm -f /var/run/vsock-bridge.pid
    fi
    if [ -f /var/run/orcabot.pid ]; then
      kill $(cat /var/run/orcabot.pid) 2>/dev/null || true
      rm -f /var/run/orcabot.pid
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop}"
    exit 1
    ;;
esac
exit 0
INITSCRIPT
chmod +x /mnt/rootfs/etc/init.d/orcabot

# Create a simpler rclocal approach as well
mkdir -p /mnt/rootfs/etc/rc.d
cat > /mnt/rootfs/etc/rc.local << "RCLOCAL"
#!/bin/sh
echo "Starting Orcabot sandbox (rc.local v3)..." > /dev/console

# Ensure log/run dirs exist
mkdir -p /var/log /run

# Load vsock modules if available
echo "Loading vsock modules..." > /dev/console
for mod in vsock virtio_vsock vmw_vsock_virtio_transport; do
  if modprobe -v "$mod" >/dev/console 2>&1; then
    echo "Loaded $mod" > /dev/console
  else
    echo "Failed to load $mod (exit=$?)" > /dev/console
  fi
done
if command -v lsmod >/dev/null 2>&1; then
  lsmod | grep -E "vsock|virtio_vsock" > /dev/console 2>/dev/null || true
else
  echo "lsmod not available; /proc/modules:" > /dev/console
  grep -E "vsock|virtio" /proc/modules > /dev/console 2>/dev/null || true
fi
if [ -e /dev/vsock ]; then
  echo "/dev/vsock present" > /dev/console
else
  echo "/dev/vsock missing" > /dev/console
fi

# Start the sandbox server
export PORT=${PORT:-8080}
export WORKSPACE_BASE=/workspace
export ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-*}
export SANDBOX_INTERNAL_TOKEN=${SANDBOX_INTERNAL_TOKEN:-dev-sandbox-token}
touch /var/log/orcabot.log /var/log/vsock-bridge.log
/usr/local/bin/orcabot-server >> /var/log/orcabot.log 2>&1 &
echo $! > /run/orcabot.pid

# Start vsock-to-TCP bridge
if command -v socat >/dev/null 2>&1; then
  echo "Starting vsock bridge..." > /dev/console
  socat -d -d VSOCK-LISTEN:${PORT},reuseaddr,fork TCP:127.0.0.1:${PORT} > /dev/console 2>&1 &
  echo $! > /run/vsock-bridge.pid
else
  echo "socat not found; vsock bridge not started" > /dev/console
fi

# Quick sanity check for the server port (best-effort)
sleep 1
if command -v bash >/dev/null 2>&1; then
  if bash -c "echo >/dev/tcp/127.0.0.1/${PORT}"; then
    echo "Orcabot server listening on ${PORT}" > /dev/console
  else
    echo "Orcabot server NOT listening on ${PORT}" > /dev/console
    if [ -f /run/orcabot.pid ] && ! kill -0 "$(cat /run/orcabot.pid)" 2>/dev/null; then
      echo "orcabot-server exited early; last log lines:" > /dev/console
      tail -n 200 /var/log/orcabot.log > /dev/console
    fi
  fi
fi

# Snapshot listeners for debugging
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep ":${PORT} " > /dev/console 2>/dev/null || true
elif command -v netstat >/dev/null 2>&1; then
  netstat -ltnp 2>/dev/null | grep ":${PORT} " > /dev/console || true
fi
exit 0
RCLOCAL
chmod +x /mnt/rootfs/etc/rc.local

# Ensure networking is configured for DHCP
mkdir -p /mnt/rootfs/etc/network
cat > /mnt/rootfs/etc/network/interfaces << "NETCONF"
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
NETCONF

# Create hostname
echo "orcabot-sandbox" > /mnt/rootfs/etc/hostname

# Sync and unmount
sync
umount /mnt/rootfs

echo "Disk image created successfully!"
ls -lh /output/sandbox.img
'

log "Created: $OUTPUT_DIR/sandbox.img"

# =============================================================================
# Step 4: Extract kernel and initrd for direct boot
# =============================================================================
log "Extracting kernel and initrd..."

# macOS Virtualization.framework on ARM64 requires a raw "Image" format kernel,
# NOT a PE/COFF vmlinuz (EFI stub).
#
# We extract the kernel from Debian since our rootfs is Debian-based.
# The kernel must be in ARM64 Image format for VZ to boot it.
docker run --rm \
    -v "$OUTPUT_DIR:/output" \
    debian:bookworm-slim \
    bash -c '
apt-get update -qq
# Prefer kernels that build virtio console support in (needed for VZ console output).
apt-get install -y -qq linux-image-virt > /dev/null 2>&1 || \
apt-get install -y -qq linux-image-cloud-arm64 > /dev/null 2>&1 || \
apt-get install -y -qq linux-image-arm64 > /dev/null 2>&1

# Tools for inspecting kernel and rebuilding initramfs.
apt-get install -y -qq initramfs-tools kmod file > /dev/null 2>&1

# Find the installed kernel (Image format for ARM64)
KERNEL_VERSION=$(ls /boot/vmlinuz-* 2>/dev/null | sort | tail -1 | sed "s/.*vmlinuz-//")
if [ -z "$KERNEL_VERSION" ]; then
    echo "ERROR: No kernel found"
    exit 1
fi

echo "Found kernel version: $KERNEL_VERSION"

# Copy kernel - on ARM64 Debian, vmlinuz is a symlink to Image format
cp /boot/vmlinuz-$KERNEL_VERSION /output/vmlinuz

chmod 644 /output/vmlinuz /output/initrd.img
echo "Kernel and initrd extracted"
file /output/vmlinuz

# Copy kernel config for debugging and sanity checks
if [ -f /boot/config-$KERNEL_VERSION ]; then
    cp /boot/config-$KERNEL_VERSION /output/kernel.config
    echo "Copied kernel config to /output/kernel.config"
    echo "Key config flags:"
    grep -E "CONFIG_(VIRTIO_CONSOLE|HVC|HVC_VIRTIO|VIRTIO_VSOCK|VIRTIO_BLK|VIRTIO_NET|VIRTIO_FS)=" /output/kernel.config || true

    NEED_CUSTOM_KERNEL=0
    if ! grep -q "^CONFIG_HVC_VIRTIO=y" /output/kernel.config || ! grep -q "^CONFIG_VIRTIO_CONSOLE=y" /output/kernel.config; then
        NEED_CUSTOM_KERNEL=1
        echo "Notice: virtio console is not built-in; will build custom kernel with virtio built-in."
    fi
else
    echo "Warning: kernel config not found at /boot/config-$KERNEL_VERSION"
fi

if [ "${NEED_CUSTOM_KERNEL:-0}" -eq 1 ]; then
    apt-get install -y -qq linux-source-6.1 build-essential bc bison flex libssl-dev libelf-dev python3 dwarves rsync > /dev/null 2>&1
    tar -xf /usr/src/linux-source-6.1.tar.xz -C /usr/src
    cd /usr/src/linux-source-6.1

    cp /boot/config-$KERNEL_VERSION .config
    ./scripts/config --file .config \
        -e HVC_VIRTIO \
        -e VIRTIO_CONSOLE \
        -e VIRTIO \
        -e VSOCKETS \
        -e VIRTIO_VSOCKETS \
        -e VIRTIO_VSOCKETS_COMMON \
        -e VSOCKETS_DIAG \
        -e VIRTIO_PCI \
        -e VIRTIO_BLK \
        -e EXT4_FS \
        -e VIRTIO_NET \
        -e VIRTIO_FS
    make olddefconfig > /dev/null
    make -j"$(nproc)" Image modules > /dev/null
    CUSTOM_VERSION=$(make kernelrelease)

    make modules_install INSTALL_MOD_PATH=/tmp/kernel-install > /dev/null
    mkdir -p /lib/modules
    rsync -a /tmp/kernel-install/lib/modules/$CUSTOM_VERSION/ /lib/modules/$CUSTOM_VERSION/

    if [ ! -f arch/arm64/boot/Image ]; then
        echo "ERROR: Custom kernel Image not built"
        exit 1
    fi
    mkdir -p /boot
    cp arch/arm64/boot/Image /boot/vmlinuz-$CUSTOM_VERSION
    cp .config /boot/config-$CUSTOM_VERSION
    update-initramfs -c -k $CUSTOM_VERSION > /dev/null 2>&1 || true
    if [ ! -f /boot/initrd.img-$CUSTOM_VERSION ]; then
        echo "ERROR: Custom initrd not found for $CUSTOM_VERSION"
        exit 1
    fi
    cp arch/arm64/boot/Image /output/vmlinuz
    cp /boot/initrd.img-$CUSTOM_VERSION /output/initrd.img
    cp .config /output/kernel.config
    echo "$CUSTOM_VERSION" > /output/custom-kernel-version
    tar -C /lib/modules -czf /output/custom-modules.tar.gz "$CUSTOM_VERSION"

    echo "Custom kernel built: $CUSTOM_VERSION"
    file /output/vmlinuz
else
    # Rebuild initramfs with virtio console/vsock modules included.
    for mod in virtio_console virtio_vsock vsock virtio_fs virtio_blk virtio_net; do
        if ! grep -q "^$mod$" /etc/initramfs-tools/modules 2>/dev/null; then
            echo "$mod" >> /etc/initramfs-tools/modules
        fi
    done
    update-initramfs -u -k $KERNEL_VERSION > /dev/null 2>&1 || true

    # Copy initrd after rebuild.
    cp /boot/initrd.img-$KERNEL_VERSION /output/initrd.img
fi

'

# If we built a custom kernel, inject its modules into the disk image.
if [ -f "$OUTPUT_DIR/custom-modules.tar.gz" ] && [ -f "$OUTPUT_DIR/sandbox.img" ]; then
    log "Injecting custom kernel modules into disk image..."
    docker run --rm --privileged \
        -v "$OUTPUT_DIR:/output" \
        debian:bookworm-slim \
        /bin/bash -c '
set -euo pipefail
apt-get update -qq
apt-get install -y -qq e2fsprogs tar kmod > /dev/null

# Extract full module tree to /tmp first, strip there, then copy only needed modules to disk.
# The full tarball is ~1.2GB which would overflow the disk if extracted directly.
echo "Extracting custom modules to temp dir and stripping..."
mkdir -p /tmp/all-modules
tar -xzf /output/custom-modules.tar.gz -C /tmp/all-modules

KVER_DIR=$(find /tmp/all-modules -maxdepth 1 -mindepth 1 -type d | head -1)
KVER=$(basename "$KVER_DIR")

# Extract only the modules we need
mkdir -p /tmp/keep-modules/$KVER/kernel
if [ -d "$KVER_DIR/kernel" ]; then
  cd "$KVER_DIR/kernel"
  find . -type f \( -name "virtio*" -o -name "vsock*" -o -name "vmw_vsock*" \
         -o -name "ext4*" -o -name "fuse*" -o -name "virtiofs*" \
         -o -name "jbd2*" -o -name "mbcache*" -o -name "crc16*" \
         -o -name "crc32*" \) | while read f; do
    mkdir -p "/tmp/keep-modules/$KVER/kernel/$(dirname "$f")"
    cp "$f" "/tmp/keep-modules/$KVER/kernel/$f"
  done
  cd /
fi
# Copy module metadata
for meta in modules.builtin modules.builtin.modinfo modules.order; do
  [ -f "$KVER_DIR/$meta" ] && cp "$KVER_DIR/$meta" "/tmp/keep-modules/$KVER/" || true
done
rm -rf /tmp/all-modules

echo "Stripped modules size:"
du -sh /tmp/keep-modules/

# Now mount disk and inject only the stripped modules
mkdir -p /mnt/rootfs
mount -o loop /output/sandbox.img /mnt/rootfs
rm -rf /mnt/rootfs/lib/modules
mkdir -p /mnt/rootfs/lib/modules
cp -a /tmp/keep-modules/. /mnt/rootfs/lib/modules/
rm -rf /tmp/keep-modules

# Regenerate modules.dep for the stripped custom kernel modules.
# Without this, modprobe cannot find any modules by name.
INJECTED_KVER=$(ls /mnt/rootfs/lib/modules/ | head -1)
if [ -n "$INJECTED_KVER" ]; then
  echo "Running depmod for custom kernel $INJECTED_KVER..."
  depmod -b /mnt/rootfs "$INJECTED_KVER" 2>/dev/null || echo "Warning: depmod failed"
fi

sync
umount /mnt/rootfs
'
    log "Injected custom kernel modules into disk image"
fi

log "Created: $OUTPUT_DIR/vmlinuz"
log "Created: $OUTPUT_DIR/initrd.img"
log "Created: $OUTPUT_DIR/kernel.config"

# =============================================================================
# Step 5: Optionally convert to QCOW2 (if qemu-img available)
# =============================================================================
if command -v qemu-img &> /dev/null; then
    log "Converting to QCOW2..."
    qemu-img convert -O qcow2 "$OUTPUT_DIR/sandbox.img" "$OUTPUT_DIR/sandbox.qcow2"
    log "Created: $OUTPUT_DIR/sandbox.qcow2"
else
    warn "qemu-img not found, skipping QCOW2 conversion"
fi

# =============================================================================
# Summary
# =============================================================================
log ""
log "Build complete! Output files:"
ls -lh "$OUTPUT_DIR"

log ""
log "To use these images:"
log "  1. Copy to desktop/app/src-tauri/resources/vm/"
log "  2. Run 'cargo tauri dev' to test"
log ""
log "Note: The sandbox.img is a self-contained bootable image."
log "      Docker is only used for BUILDING, not at runtime."
