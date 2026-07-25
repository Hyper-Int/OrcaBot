#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# Cross-platform in-place sed (BSD/macOS needs `-i ''`; GNU/Linux uses `-i`).
sed_inplace() {
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}
TAURI_RESOURCES_DIR="$ROOT_DIR/app/src-tauri/resources"
WORKERD_RES_DIR="$TAURI_RESOURCES_DIR/workerd"
WORKERD_CONFIG_DIR="$WORKERD_RES_DIR/config"
WORKERD_DIST_DIR="$WORKERD_RES_DIR/dist"
D1_SHIM_RES_DIR="$TAURI_RESOURCES_DIR/d1-shim"
CONTROLPLANE_DIR=${CONTROLPLANE_DIR:-"$ROOT_DIR/../controlplane"}

VM_ONLY=${VM_ONLY:-0}

mkdir -p "$WORKERD_CONFIG_DIR" "$WORKERD_DIST_DIR" "$D1_SHIM_RES_DIR"

if [ "$VM_ONLY" = "1" ]; then
  printf '%s\n' "VM_ONLY=1 set: skipping workerd, D1 shim, and frontend builds"
else

printf '%s\n' "Building controlplane worker bundle..."
"$ROOT_DIR/workerd/scripts/build-workerd.sh"

if [ ! -f "$ROOT_DIR/workerd/dist/worker.js" ]; then
  printf '%s\n' "worker.js not found; bundle step failed" >&2
  exit 1
fi

cp "$ROOT_DIR/workerd/dist/worker.js" "$WORKERD_DIST_DIR/worker.js"
cp "$ROOT_DIR/workerd/config/workerd.desktop.capnp" "$WORKERD_CONFIG_DIR/workerd.desktop.capnp"

# --- Bake OAuth client credentials into the bundled capnp (build-time) --------
# A downloaded app can't read host env vars, so provider client IDs/secrets must
# ship *inside* the app. When set at build time, rewrite the matching capnp
# `fromEnvironment` bindings to literal `text` values in the STAGED copy only —
# source stays clean, so nothing lands in the (public) repo (which also keeps
# Google from auto-revoking an exposed secret). Client IDs are public; the
# desktop client secret is non-confidential per Google's installed-app model.
# Usage:  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... cargo tauri build
STAGED_CAPNP="$WORKERD_CONFIG_DIR/workerd.desktop.capnp"
# Only NON-CONFIDENTIAL values may be baked into a shipped (inspectable) app:
#   - public client IDs (Google/GitHub/Microsoft/OneDrive)
#   - GOOGLE_CLIENT_SECRET — a Google "Desktop app" client secret, which Google
#     explicitly treats as non-confidential and requires you to embed
#   - GOOGLE_API_KEY — a browser/public API key
# GitHub uses device flow and Microsoft/OneDrive use PKCE, so no secrets there.
# Confidential-secret providers (Slack/Discord/X/Box) are NOT baked and stay
# hidden/disabled on desktop; a *_CLIENT_SECRET set for them is ignored here.
for _oauth_var in \
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_API_KEY \
  GITHUB_CLIENT_ID \
  MICROSOFT_CLIENT_ID \
  ONEDRIVE_CLIENT_ID; do
  _oauth_val=$(printenv "$_oauth_var" 2>/dev/null) || _oauth_val=""
  [ -n "$_oauth_val" ] || continue
  if python3 - "$STAGED_CAPNP" "$_oauth_var" "$_oauth_val" <<'PY'
import json, re, sys
cfg, name, value = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(cfg).read()
pat = re.compile(r'\(name = "%s", fromEnvironment = "%s"\)' % (re.escape(name), re.escape(name)))
new, n = pat.subn('(name = "%s", text = %s)' % (name, json.dumps(value)), s)
if n:
    open(cfg, 'w').write(new)
sys.exit(0 if n else 3)
PY
  then printf '%s\n' "  baked OAuth binding: $_oauth_var"
  else printf '%s\n' "  WARN: $_oauth_var set but no fromEnvironment binding found to bake"; fi
done

WORKERD_BIN="$CONTROLPLANE_DIR/node_modules/workerd/bin/workerd"
if [ ! -x "$WORKERD_BIN" ]; then
  printf '%s\n' "workerd binary not found: $WORKERD_BIN" >&2
  exit 1
fi
cp "$WORKERD_BIN" "$WORKERD_RES_DIR/workerd"

WORKERD_CAPNP="$CONTROLPLANE_DIR/node_modules/workerd/workerd.capnp"
if [ ! -f "$WORKERD_CAPNP" ]; then
  printf '%s\n' "workerd.capnp not found: $WORKERD_CAPNP" >&2
  exit 1
fi
cp "$WORKERD_CAPNP" "$WORKERD_RES_DIR/workerd.capnp"

printf '%s\n' "Building D1 shim binary..."
(
  cd "$ROOT_DIR/d1-shim"
  go build -o "$D1_SHIM_RES_DIR/d1-shim" .
)
fi

# Build and stage VM images (optional - skip if BUILD_VM=0 or images already exist)
VM_RES_DIR="$TAURI_RESOURCES_DIR/vm"
VM_IMAGE_DIR="$ROOT_DIR/vm/image"
mkdir -p "$VM_RES_DIR"

# Check if VM images already exist
vm_images_exist() {
  [ -f "$VM_IMAGE_DIR/sandbox.img" ] && \
  [ -f "$VM_IMAGE_DIR/vmlinuz" ] && \
  [ -f "$VM_IMAGE_DIR/initrd.img" ]
}

if [ "${BUILD_VM:-1}" = "0" ]; then
  printf '%s\n' "Skipping VM image build (BUILD_VM=0)"
elif [ "${BUILD_VM:-1}" != "force" ] && vm_images_exist; then
  printf '%s\n' "VM images already exist, skipping build (use BUILD_VM=force to rebuild)"
else
  printf '%s\n' "Building VM images..."
  if [ -x "$ROOT_DIR/vm/scripts/build-images.sh" ]; then
    if ! "$ROOT_DIR/vm/scripts/build-images.sh"; then
      if [ "${BUILD_VM:-1}" = "force" ]; then
        printf '%s\n' "Error: VM image build failed with BUILD_VM=force" >&2
        exit 1
      fi
      printf '%s\n' "Warning: VM image build failed (sandbox VM will be unavailable)"
      VM_BUILD_FAILED=1
    fi
  else
    printf '%s\n' "Warning: VM build script not found or not executable"
  fi
fi

# Stage VM images based on platform
if [ -d "$VM_IMAGE_DIR" ]; then
  if [ "${VM_BUILD_FAILED:-0}" = "1" ]; then
    printf '%s\n' "Skipping VM image staging due to build failure"
  else
  # Copy VM images to Tauri resources
  for img in sandbox.img sandbox-rootfs.tar.gz sandbox.qcow2 vmlinuz initrd.img; do
    if [ -f "$VM_IMAGE_DIR/$img" ]; then
      cp "$VM_IMAGE_DIR/$img" "$VM_RES_DIR/$img"
      printf '%s\n' "  Staged: $img"
    fi
  done
  fi
fi

# Build VZ helper for macOS
if [ "$(uname)" = "Darwin" ]; then
  VZ_HELPER_DIR="$ROOT_DIR/app/src-tauri/vz-helper"
  if [ -f "$VZ_HELPER_DIR/Package.swift" ]; then
    printf '%s\n' "Building VZ helper..."
    (cd "$VZ_HELPER_DIR" && swift build -c release) && {
      cp "$VZ_HELPER_DIR/.build/release/vz-helper" "$VM_RES_DIR/vz-helper"
      printf '%s\n' "  Staged: vz-helper"
    } || {
      printf '%s\n' "Warning: VZ helper build failed (will fall back to QEMU)"
    }
  fi
fi

# Build and stage frontend worker
if [ "$VM_ONLY" != "1" ]; then
FRONTEND_DIR=${FRONTEND_DIR:-"$ROOT_DIR/../frontend"}
FRONTEND_RES_DIR="$TAURI_RESOURCES_DIR/frontend"
FRONTEND_TMP_DIR="$ROOT_DIR/workerd/.tmp-frontend-build"

if [ -d "$FRONTEND_DIR" ]; then
  : "${NEXT_PUBLIC_API_URL:=http://127.0.0.1:8787}"
  : "${NEXT_PUBLIC_SITE_URL:=http://127.0.0.1:8788}"
  : "${NEXT_PUBLIC_DEV_MODE_ENABLED:=true}"
  : "${NEXT_PUBLIC_DESKTOP_MODE:=true}"
  export NEXT_PUBLIC_API_URL NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_DEV_MODE_ENABLED NEXT_PUBLIC_DESKTOP_MODE

  printf '%s\n' "Building frontend worker..."

  # Step 0: clear stale build artifacts. Next.js's incremental cache (.next/cache)
  # has silently served MONTHS-old compiled output before — a changed page didn't
  # rebuild, shipping stale UI into the desktop app. This is a build step, not a
  # hot dev loop, so correctness beats the incremental speedup: clean by default.
  # Opt out with FRONTEND_CLEAN=0 when iterating and you trust the cache.
  if [ "${FRONTEND_CLEAN:-1}" != "0" ]; then
    printf '%s\n' "Clearing frontend build cache (.next, .open-next)..."
    rm -rf "$FRONTEND_DIR/.next" "$FRONTEND_DIR/.open-next"
  fi

  # Step 1: Build with OpenNext (creates .open-next/)
  (
    cd "$FRONTEND_DIR"
    npm run workers:build
  )

  if [ ! -d "$FRONTEND_DIR/.open-next" ]; then
    printf '%s\n' "Warning: .open-next directory not found after build"
  else
    # Step 2: Bundle with wrangler into a single file
    printf '%s\n' "Bundling frontend worker..."
    rm -rf "$FRONTEND_TMP_DIR"
    mkdir -p "$FRONTEND_TMP_DIR"
    (
      cd "$FRONTEND_DIR"
      npx wrangler deploy --dry-run --outdir "$FRONTEND_TMP_DIR"
    )

    # Find the bundled worker file
    frontend_bundle=""
    if [ -f "$FRONTEND_TMP_DIR/worker.js" ]; then
      frontend_bundle="$FRONTEND_TMP_DIR/worker.js"
    elif [ -f "$FRONTEND_TMP_DIR/worker.mjs" ]; then
      frontend_bundle="$FRONTEND_TMP_DIR/worker.mjs"
    else
      frontend_bundle=$(find "$FRONTEND_TMP_DIR" -maxdepth 1 -type f \( -name "*.js" -o -name "*.mjs" \) | head -n 1)
    fi

    # Stage frontend resources
    mkdir -p "$FRONTEND_RES_DIR"

    if [ -n "$frontend_bundle" ] && [ -f "$frontend_bundle" ]; then
      cp "$frontend_bundle" "$FRONTEND_RES_DIR/worker.js"
      printf '%s\n' "  Staged: frontend worker.js (bundled)"

      # Patch the worker.js to work with raw workerd
      # The OpenNext worker tries to modify read-only Node.js timer modules
      # which fails on workerd. We wrap those assignments in try-catch.
      sed_inplace 's/globalThis.setImmediate = nodeTimers.setImmediate = patchedSetImmediate, globalThis.clearImmediate = nodeTimers.clearImmediate = patchedClearImmediate/try { globalThis.setImmediate = patchedSetImmediate; globalThis.clearImmediate = patchedClearImmediate; } catch(e) {}/g' "$FRONTEND_RES_DIR/worker.js"
      sed_inplace 's/nodeTimersPromises.setImmediate = patchedSetImmediatePromise, process.nextTick = patchedNextTick/try { process.nextTick = patchedNextTick; } catch(e) {}/g' "$FRONTEND_RES_DIR/worker.js"
      # Ensure static assets are served via the ASSETS service in workerd.
      sed_inplace 's|__ASSETS_RUN_WORKER_FIRST__: false|__ASSETS_RUN_WORKER_FIRST__: ["\\/_next\\/static\\/*","\\/favicon.ico","\\/favicon*.png","\\/favicon.svg","\\/apple-touch-icon.png","\\/site.webmanifest","\\/orca.png","\\/icons\\/*","\\/web-app-manifest-*.png","\\/*.png","\\/*.svg","\\/*.ico"]|g' "$FRONTEND_RES_DIR/worker.js"
      printf '%s\n' "  Patched: worker.js for workerd compatibility"
    else
      printf '%s\n' "Warning: Could not find bundled frontend worker"
    fi

    # Copy WASM modules and collect their names for config generation
    WASM_MODULES=""
    for wasm_file in "$FRONTEND_TMP_DIR"/*-*.wasm*; do
      if [ -f "$wasm_file" ]; then
        # Extract the base name and remove ?module suffix
        wasm_basename=$(basename "$wasm_file" | sed 's/?module$//')
        # The module name in the config needs the ?module suffix
        wasm_module_name="${wasm_basename}?module"
        cp "$wasm_file" "$FRONTEND_RES_DIR/$wasm_basename"
        printf '%s\n' "  Staged: $wasm_basename"
        # Build the modules list for capnp config
        WASM_MODULES="${WASM_MODULES}        (name = \"${wasm_module_name}\", wasm = embed \"../../frontend/${wasm_basename}\"),
"
      fi
    done

    # Generate frontend workerd config with dynamic WASM modules
    cat > "$WORKERD_CONFIG_DIR/workerd.frontend.capnp" << CAPNP_EOF
# workerd config (Cap'n Proto text format)
# Auto-generated - do not edit manually
# This runs the frontend Worker bundle on localhost for desktop use.

using Workerd = import "/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "internet", network = (
      allow = ["public", "private", "local"]
    )),
    # Disk mount for frontend assets (path provided via --directory-path)
    (name = "assets-dir", disk = (writable = false)),
    # Asset service reads static files from disk
    (name = "assets", worker = (
      modules = [
        (name = "worker.js", esModule = embed "../assets-service/worker.js")
      ],
      compatibilityDate = "2024-09-23",
      compatibilityFlags = ["nodejs_compat"],
      bindings = [
        (name = "ASSETS_DISK", service = "assets-dir")
      ]
    )),
    # Frontend worker - the bundled OpenNext worker
    (name = "frontend", worker = (
      modules = [
        (name = "worker.js", esModule = embed "../../frontend/worker.js"),
${WASM_MODULES}      ],
      compatibilityDate = "2024-09-23",
      compatibilityFlags = ["nodejs_compat"],
      globalOutbound = "internet",
      bindings = [
        (name = "ASSETS", service = "assets"),
        (name = "NEXT_PUBLIC_API_URL", fromEnvironment = "NEXT_PUBLIC_API_URL"),
        (name = "NEXT_PUBLIC_SITE_URL", fromEnvironment = "NEXT_PUBLIC_SITE_URL"),
        (name = "NEXT_PUBLIC_DEV_MODE_ENABLED", fromEnvironment = "NEXT_PUBLIC_DEV_MODE_ENABLED"),
        (name = "NEXT_PUBLIC_DESKTOP_MODE", fromEnvironment = "NEXT_PUBLIC_DESKTOP_MODE")
      ]
    ))
  ],

  sockets = [
    (name = "http", service = "frontend")
  ]
);
CAPNP_EOF
    printf '%s\n' "  Generated: workerd.frontend.capnp"

    # Copy assets directory. Wipe the staged copy first so orphaned chunks from
    # previous builds don't pile up (content-hashed filenames mean stale chunks are
    # never overwritten, just accumulate — confusing to debug and bloats the app).
    if [ -d "$FRONTEND_DIR/.open-next/assets" ]; then
      rm -rf "$FRONTEND_RES_DIR/assets"
      cp -r "$FRONTEND_DIR/.open-next/assets" "$FRONTEND_RES_DIR/"
      printf '%s\n' "  Staged: frontend assets"
    fi
  fi
else
  printf '%s\n' "Warning: Frontend directory not found: $FRONTEND_DIR"
fi
else
  printf '%s\n' "VM_ONLY=1 set: skipping frontend worker build"
fi

# Stage assets service worker
ASSETS_SERVICE_DIR="$WORKERD_RES_DIR/assets-service"
mkdir -p "$ASSETS_SERVICE_DIR"
if [ -f "$ROOT_DIR/workerd/assets-service/worker.js" ]; then
  cp "$ROOT_DIR/workerd/assets-service/worker.js" "$ASSETS_SERVICE_DIR/worker.js"
  printf '%s\n' "  Staged: assets-service worker"
fi

# Staged loading screen for Tauri's frontendDist: polls the local services,
# shows the current boot stage (with KSP-style flavor), then redirects to the
# workerd-served UI at :8788 once it's actually ready.
DIST_DIR="$ROOT_DIR/app/dist"
mkdir -p "$DIST_DIR"
cp "$ROOT_DIR/app/loading.html" "$DIST_DIR/index.html"
# Brand logo for the loading screen (best-effort; the page hides it if missing).
cp "$ROOT_DIR/../frontend/public/orca.png" "$DIST_DIR/orca.png" 2>/dev/null || true
printf '%s\n' "  Created: loading page in dist/"

printf '%s\n' "Desktop resources staged in $TAURI_RESOURCES_DIR"

# --- Code-sign nested Mach-O binaries for Developer ID notarization ----------
# Tauri signs the app shell but NOT these bundled resource executables, so we
# sign them here — before Tauri copies them in and seals/notarizes the bundle.
# Gated on APPLE_SIGNING_IDENTITY so plain dev builds are unaffected. workerd
# (V8) needs JIT entitlements; vz-helper needs the virtualization entitlement.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  ENT_DIR="$ROOT_DIR/app/src-tauri"
  printf '%s\n' "Code-signing nested binaries with: $APPLE_SIGNING_IDENTITY"
  sign_bin() {
    [ -f "$1" ] || { printf '%s\n' "  skip (missing): $1"; return 0; }
    if [ -n "${2:-}" ]; then
      codesign --force --options runtime --timestamp --entitlements "$2" --sign "$APPLE_SIGNING_IDENTITY" "$1"
    else
      codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$1"
    fi
    printf '%s\n' "  signed: $1"
  }
  sign_bin "$TAURI_RESOURCES_DIR/workerd/workerd" "$ENT_DIR/entitlements-workerd.plist"
  sign_bin "$TAURI_RESOURCES_DIR/d1-shim/d1-shim"
  sign_bin "$TAURI_RESOURCES_DIR/vm/vz-helper" "$ENT_DIR/entitlements-vz-helper.plist"
else
  printf '%s\n' "APPLE_SIGNING_IDENTITY not set — skipping nested-binary signing (dev build)"
fi

# Dev convenience: the `cargo build` output binary loads resources from
# target/release/resources (Tauri copies them there at build time), NOT from the
# source app/src-tauri/resources this script writes. Keep them in sync so a
# standalone resources rebuild takes effect on the next `orcabot up` without a
# full `cargo build`. Only touches the target dir if it already exists (a prior
# cargo build); the packaged `cargo tauri build` path copies resources itself.
TARGET_RES_DIR="$ROOT_DIR/app/src-tauri/target/release/resources"
if [ -d "$TARGET_RES_DIR" ]; then
  if command -v rsync >/dev/null 2>&1; then
    # --delete mirrors exactly, so stale frontend chunks don't linger here either.
    rsync -a --delete "$TAURI_RESOURCES_DIR/" "$TARGET_RES_DIR/"
  else
    rm -rf "$TARGET_RES_DIR/frontend/assets"
    cp -R "$TAURI_RESOURCES_DIR/." "$TARGET_RES_DIR/"
  fi
  printf '%s\n' "  synced resources -> target/release/resources (dev binary picks these up)"
fi
