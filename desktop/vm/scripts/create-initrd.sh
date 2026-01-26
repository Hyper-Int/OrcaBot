#!/usr/bin/env bash
# Create a minimal initrd for direct kernel boot.
#
# This initrd just mounts the root filesystem and switches to it.
# It's designed to work with Virtualization.framework's direct kernel boot.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VM_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$VM_DIR/image"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[create-initrd]${NC} $*"; }
warn() { echo -e "${YELLOW}[create-initrd]${NC} $*"; }

mkdir -p "$OUTPUT_DIR"

log "Creating minimal initrd for sandbox boot..."

# Use Docker to create the initrd (needs to match kernel architecture)
docker run --rm \
    -v "$OUTPUT_DIR:/output" \
    debian:bookworm-slim \
    bash -c '
set -euo pipefail

apt-get update -qq
apt-get install -y -qq busybox-static kmod linux-image-arm64 > /dev/null 2>&1

# Find kernel version for modules
KERNEL_VERSION=$(ls /lib/modules/ | head -1)
echo "Using kernel modules from: $KERNEL_VERSION"

# Create initrd structure
INITRD_DIR=/tmp/initrd
mkdir -p $INITRD_DIR/{bin,sbin,dev,proc,sys,mnt/root,lib/modules}

# Copy busybox (statically linked)
cp /bin/busybox $INITRD_DIR/bin/
chmod +x $INITRD_DIR/bin/busybox

# Create busybox symlinks
cd $INITRD_DIR/bin
for cmd in sh ash mount umount switch_root mkdir sleep mknod cat echo ls dmesg modprobe insmod; do
    ln -sf busybox $cmd
done
cd /

# Copy essential kernel modules
MODULES_DIR=$INITRD_DIR/lib/modules/$KERNEL_VERSION
mkdir -p $MODULES_DIR/kernel/drivers/{block,virtio,net,vhost}

# Function to copy module and its dependencies
copy_module() {
    local mod=$1
    if [ -f "/lib/modules/$KERNEL_VERSION/$mod" ]; then
        mkdir -p "$MODULES_DIR/$(dirname $mod)"
        cp "/lib/modules/$KERNEL_VERSION/$mod" "$MODULES_DIR/$mod"
        echo "Copied: $mod"
    fi
}

# Copy virtio modules (needed for VirtioFS, virtio-blk, virtio-net, vsock)
for mod in \
    kernel/drivers/virtio/virtio.ko* \
    kernel/drivers/virtio/virtio_ring.ko* \
    kernel/drivers/virtio/virtio_pci.ko* \
    kernel/drivers/virtio/virtio_mmio.ko* \
    kernel/drivers/block/virtio_blk.ko* \
    kernel/drivers/net/virtio_net.ko* \
    kernel/net/vmw_vsock/vsock.ko* \
    kernel/net/vmw_vsock/virtio_transport.ko* \
    kernel/net/vmw_vsock/virtio_transport_common.ko* \
    kernel/net/vmw_vsock/vmw_vsock_virtio_transport.ko* \
    kernel/drivers/vhost/vhost.ko* \
    kernel/drivers/vhost/vhost_vsock.ko*; do
    # Use find to locate the module
    found=$(find /lib/modules/$KERNEL_VERSION -name "$(basename $mod)" 2>/dev/null | head -1)
    if [ -n "$found" ]; then
        rel_path=${found#/lib/modules/$KERNEL_VERSION/}
        mkdir -p "$MODULES_DIR/$(dirname $rel_path)"
        cp "$found" "$MODULES_DIR/$rel_path"
        echo "Copied: $rel_path"
    fi
done

# Copy modules.dep for modprobe
if [ -f /lib/modules/$KERNEL_VERSION/modules.dep ]; then
    cp /lib/modules/$KERNEL_VERSION/modules.dep $MODULES_DIR/
    cp /lib/modules/$KERNEL_VERSION/modules.dep.bin $MODULES_DIR/ 2>/dev/null || true
    cp /lib/modules/$KERNEL_VERSION/modules.alias $MODULES_DIR/ 2>/dev/null || true
    cp /lib/modules/$KERNEL_VERSION/modules.alias.bin $MODULES_DIR/ 2>/dev/null || true
fi

# Create init script
cat > $INITRD_DIR/init << "INITSCRIPT"
#!/bin/sh
# Minimal init script for sandbox VM boot

echo "=== Orcabot Sandbox Initrd ==="

# Mount essential filesystems
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev

echo "Waiting for devices..."
sleep 1

# Load virtio modules
echo "Loading virtio modules..."
modprobe virtio_pci 2>/dev/null || true
modprobe virtio_blk 2>/dev/null || true
modprobe virtio_net 2>/dev/null || true

# Load vsock modules
echo "Loading vsock modules..."
modprobe vsock 2>/dev/null || true
modprobe virtio_transport 2>/dev/null || true
modprobe vmw_vsock_virtio_transport 2>/dev/null || true

# Wait for root device
ROOT_DEV="/dev/vda"
echo "Waiting for root device: $ROOT_DEV"
for i in 1 2 3 4 5; do
    if [ -b "$ROOT_DEV" ]; then
        echo "Found $ROOT_DEV"
        break
    fi
    echo "  Waiting ($i)..."
    sleep 1
done

if [ ! -b "$ROOT_DEV" ]; then
    echo "ERROR: Root device $ROOT_DEV not found!"
    echo "Available block devices:"
    ls -la /dev/vd* /dev/sd* 2>/dev/null || true
    echo "Dropping to shell..."
    exec /bin/sh
fi

# Mount root filesystem
echo "Mounting root filesystem..."
mount -t ext4 -o rw "$ROOT_DEV" /mnt/root

if [ ! -f /mnt/root/sbin/init ] && [ ! -f /mnt/root/usr/sbin/init ]; then
    echo "ERROR: No init found on root filesystem!"
    echo "Contents of /mnt/root:"
    ls -la /mnt/root/
    echo "Dropping to shell..."
    exec /bin/sh
fi

# Cleanup
umount /proc
umount /sys

# Switch to real root
echo "Switching to root filesystem..."
exec switch_root /mnt/root /sbin/init

# If switch_root fails
echo "ERROR: switch_root failed!"
exec /bin/sh
INITSCRIPT

chmod +x $INITRD_DIR/init

# Create initrd image
echo "Creating initrd.img..."
cd $INITRD_DIR
find . | cpio -H newc -o 2>/dev/null | gzip > /output/initrd.img

echo "Done! Created /output/initrd.img"
ls -lh /output/initrd.img
'

log "Created: $OUTPUT_DIR/initrd.img"
log ""
log "The new initrd will:"
log "  1. Load virtio and vsock kernel modules"
log "  2. Wait for /dev/vda to appear"
log "  3. Mount it and switch_root to it"
log ""
log "Copy to Application Support with:"
log "  cp $OUTPUT_DIR/initrd.img ~/Library/Application\\ Support/com.orcabot.desktop/vm/"
