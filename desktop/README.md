# Orcabot Desktop

This folder contains the desktop-only app, runtime, and packaging assets.

## Layout
- app/     Tauri shell (UI + orchestrator).
- d1-shim/ Local D1 (SQLite) HTTP shim for workerd.
- workerd/ Local controlplane runtime config and scripts.
- vm/      VM image build and sandbox startup.
- profile/ Desktop profile schema + secret generation.

## Status
- Initial skeleton only. See orcabot/DESKTOP.md for the full plan.

## Next steps
- Initialize the Tauri app in desktop/app.
- Add a workerd config template and launcher.
- Add a minimal VM image build script and init config.
- Add desktop profile schema + secret generation.
- Add desktop dev script to start shim + workerd + frontend.

## Dev
```
desktop/scripts/dev.sh
```

Defaults:
- controlplane: http://localhost:8787
- frontend: http://localhost:8788
- sandbox url: http://127.0.0.1:8080
- DEV_AUTH_ENABLED=true

## Local Desktop Dev (manual)
Build resources (VM + workerd + frontend assets):
```
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787 \
NEXT_PUBLIC_SITE_URL=http://127.0.0.1:8788 \
NEXT_PUBLIC_DEV_MODE_ENABLED=true \
BUILD_VM=force \
sh desktop/scripts/build-desktop-resources.sh
```

Skip VM rebuild when only the desktop binary changes:
```
BUILD_VM=0 sh desktop/scripts/build-desktop-resources.sh
```

Build and run the desktop binary:
```
cd desktop/app/src-tauri && cargo build --release
VZ_CONSOLE_DIRECT=1 ./target/release/orcabot-desktop
```

Optional flags:
- `VM_ONLY=1` skips workerd, D1 shim, and frontend builds.
- `BUILD_VM=force|0` forces or skips VM image rebuild.
