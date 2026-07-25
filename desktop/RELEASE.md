# Releasing the Orcabot Desktop app

The desktop app auto-updates from **GitHub Releases**. The app polls
`https://github.com/Hyper-Int/OrcaBot/releases/latest/download/latest.json`
(configured in `app/src-tauri/tauri.conf.json` → `plugins.updater`), so a release
must be **published (not draft)** and must be the repo's **"latest"** release to
reach existing installs.

There are two independent artifacts, released on their own cadence:

| Artifact | When to release | Script |
| --- | --- | --- |
| **App** (DMG + updater tarball) | every version | `scripts/publish-release.sh` |
| **VM image** (sandbox rootfs) | only when the VM image content changes (rare) | `scripts/publish-vm-image.sh` |

The VM image is **not** bundled in the app (it would bloat every ~40 MB auto-update
to ~1 GB). The app downloads it on demand, once per image version, and verifies it
against a SHA-256 baked into the notarized binary via `app/src-tauri/vm-image.json`.
**Most releases don't touch it** — only republish when you rebuilt the sandbox
image (`BUILD_VM=force`), and always bump `VM_IMAGE_VERSION`.

---

## One-shot

```sh
# Signing + OAuth secrets live OUTSIDE the repo (never committed). Point the
# release script at your env file (defaults to ~/.orcabot-release.env):
ORCABOT_RELEASE_ENV=~/.orcabot-release.env sh desktop/scripts/release.sh 0.5.0
```

`release.sh` bumps the version, builds resources (bakes OAuth creds), runs the
signed+notarized `cargo tauri build`, then runs the preflight gate and publishes.
It stops before anything irreversible if a step fails. See "What the wrapper does"
below for the exact sequence, and run the steps by hand if you prefer.

---

## Prerequisites (one-time)

- **`gh` CLI** authenticated: `gh auth login`.
- **Apple Developer ID** signing + notarization credentials, and the **Tauri
  updater minisign key**. Keep these in a gitignored env file OUTSIDE the repo
  (e.g. `~/.orcabot-release.env`) and `source` it before building:

  ```sh
  # Apple code-signing + notarization
  export APPLE_SIGNING_IDENTITY="Developer ID Application: Robert Macrae (3927MKQNPA)"
  export APPLE_API_ISSUER="…"          # App Store Connect API issuer UUID
  export APPLE_API_KEY="…"             # key id, e.g. K7A56UPB7U
  export APPLE_API_KEY_PATH="…/AuthKey_K7A56UPB7U.p8"

  # Tauri updater signing (minisign). Pubkey is committed in tauri.conf.json;
  # the PRIVATE key is NOT.
  export TAURI_SIGNING_PRIVATE_KEY="…"           # key contents or path
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="…"

  # OAuth client creds baked into the app at build time (public IDs + Google's
  # non-confidential desktop secret only). Unset = those integrations ship off.
  export GOOGLE_CLIENT_ID="…"
  export GOOGLE_CLIENT_SECRET="…"      # Google "Desktop app" secret (non-confidential)
  export GOOGLE_API_KEY="…"
  export GITHUB_CLIENT_ID="…"
  export MICROSOFT_CLIENT_ID="…"
  export ONEDRIVE_CLIENT_ID="…"
  ```

> Do **not** commit any of the above. The bake step rewrites only the *staged*
> copy of `workerd.desktop.capnp`; the source stays clean.

---

## Release steps (manual)

### 0. Land your changes on `main`
The publish script builds from the working tree, so merge everything first and
release from an up-to-date `main`.

### 1. Bump the version (PR — never push to `main` directly)
Bump all three to the new version, then open a PR and merge it:
- `app/src-tauri/tauri.conf.json` → `"version"`
- `app/src-tauri/Cargo.toml` → `version`
- `app/src-tauri/Cargo.lock` → the `orcabot-desktop` entry
  (`cargo update -p orcabot-desktop --precise <version>` does this cleanly)

The publish script reads the version from `tauri.conf.json` and tags `v<version>`.

### 2. Source your signing/OAuth env
```sh
source ~/.orcabot-release.env
```

### 3. Build bundled resources (frontend + control-plane workerd, bakes OAuth)
```sh
sh desktop/scripts/build-desktop-resources.sh
```
- Add `BUILD_VM=force` **only** if the VM image changed (rare — see §6).
- Watch for `baked OAuth binding:` lines confirming each secret you set was
  embedded. A "set but no binding found" warning means the bake silently failed —
  fix it before shipping.

### 4. Signed + notarized app build
```sh
cd desktop/app/src-tauri && cargo tauri build && cd -
```
Produces, under `app/src-tauri/target/release/bundle/`:
- `dmg/Orcabot_<version>_aarch64.dmg` — fresh-install download
- `macos/Orcabot.app.tar.gz` (+ `.sig`) — updater artifacts

### 5. Publish the app
```sh
sh desktop/scripts/publish-release.sh
```
- Runs a **preflight gate** (boots the built stack, checks dashboards load +
  dev-auth surface-token + CORS). Publishing aborts if it fails. Override only
  with `SKIP_PREFLIGHT=1` if you know what you're doing.
- Creates/updates the `v<version>` GitHub release, uploads the DMG, tarball,
  `.sig`, and `latest.json`, and makes it the repo's "latest".

Verify:
```sh
curl -sL https://github.com/Hyper-Int/OrcaBot/releases/latest/download/latest.json
# → should show the new version
```

### 6. (Rare) Publish a new VM image
Only if you rebuilt the sandbox rootfs (its content changed). Bump the version tag:
```sh
VM_IMAGE_VERSION=v3 sh desktop/scripts/publish-vm-image.sh path/to/sandbox.img
```
This updates `app/src-tauri/vm-image.json` (version + checksum) — **commit that via
a PR**, then rebuild + re-publish the app (§3–5) so the new checksum is baked into
the notarized binary. The VM-image release is created with `--latest=false` so it
never shadows the app release the updater polls.

---

## Gotchas

- **`latest.json` "Not Found" after release** — something other than the app
  release is the repo's "latest". `gh release create` marks new releases "latest"
  by default; the VM-image publish now passes `--latest=false` to avoid this.
  Re-running the app publish reclaims "latest".
- **OAuth didn't take in the shipped app** — the baked value contained a
  non-ASCII char (e.g. a `…` from a truncated copy-paste), so the bake failed.
  Re-copy the full value, re-`source`, rebuild, and confirm the `baked OAuth
  binding:` lines. (`grep -n '[^ -~]'` on the value catches stray chars.)
- **Wrong repo** — set `ORCABOT_RELEASE_REPO` if publishing anywhere other than
  the default `Hyper-Int/OrcaBot`.

---

## Full CI automation (not yet done)

The heavy blocker is that signing + notarization need the Apple `.p8` / Developer
ID cert and the minisign key as **GitHub Actions secrets**, plus a macOS runner.
Once those are in place a tag-triggered workflow (`on: push: tags: 'v*'`) could run
§3–5. Until then, releases are driven locally via `release.sh`.
