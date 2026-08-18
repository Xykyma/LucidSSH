# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **`rm -rf /` now actually has to be typed out to be confirmed.** The guard asks for the affected object's name, but the root directory has no last path segment, so the expected text was empty — the confirm button was active before you typed anything, on the single most destructive command it recognizes. It now asks you to type `/`.
- **The dangerous command guard now asks you to confirm the right object.** In a compound command whose destructive part wasn't last — `rm -rf ./node_modules && npm install` — the confirmation dialog named the tail of the whole line (`install`) instead of what was actually being deleted. The guard still blocked such commands, but the name you had to type said nothing about the danger. It now takes the object from the destructive fragment itself.
- The same fix now also covers a background launch with a single `&` — `rm -rf /var/www & echo done` asked you to confirm `done` instead of `/var/www`. A redirect like `2>&1`, `&>file`, or `>&2` is correctly left alone; it's not treated as a separator.

## [1.0.1] — 2026-08-05

### Added

- **Editable hotkeys**: the Settings → Hotkeys section is no longer read-only — 9 of the 11 app shortcuts can now be rebound (`Esc` and `F1` stay fixed). Assigning a combination that's already in use is blocked, with a hint showing which action currently owns it.
- The in-app changelog is now shown inline in Settings → About while an update is available or downloaded, instead of only on the GitHub Releases page.

### Fixed

- **Jump host (ProxyJump) connections now actually work.** In 1.0.0 the setting was stored, imported, and validated, but the second SSH hop was never established on a real connection attempt — every jump-host connection silently went direct instead. The jump host is now picked from your saved hosts (not a free-text alias), "Test connection" runs the full two-hop chain, deleting a host that's used as someone's jump host warns first, and `~/.ssh/config` import resolves `ProxyJump` aliases to the matching imported host.
- Clicking an update-available notification in the header bell now opens Settings → About; it previously dismissed the notification without navigating anywhere.

### Changed

- `Ctrl+L` is no longer intercepted by the app — it now reaches the shell directly and clears the screen, per the common terminal convention. The command catalog, which previously opened on `Ctrl+L`, moved to `Ctrl+Shift+L` by default.

## [1.0.0] — 2026-07-25

First release of LucidSSH — a simple SSH client for Windows. Fully local: no account, no cloud, no telemetry.

### Added

- **SSH connections**: password and private key authentication (RSA/Ed25519/ECDSA, with passphrase), server fingerprint verification on every connection with storage in `known_hosts`, ProxyJump/jump host support.
- **Host manager**: saved servers with groups, quick SSH key setup wizard, warning about keys not being portable between PCs.
- **Terminal**: multiple tabs, buffer search, context menu, live connection stepper instead of a blank terminal while the session is being established, reconnection after dropped connections.
- **Dangerous command guard**: intercepts destructive and irreversible commands (`rm -rf`, `dd`, `mkfs`, fork bombs, etc.) before they reach the server; confirmation requires typing the object's name; separate warning for commands that risk losing SSH access; can be disabled globally or per host.
- **Error detector**: offline explanation of stderr/SSH errors in Russian and English, no LLM involved; fuzzy command suggestion on "command not found"; "Copy for question" button that masks secrets automatically.
- **Breadcrumb "where am I"**: clickable path above the terminal via shell integration, status and hotkeys for the active interactive program (vim/nano/htop/man/top/less), red color for root sessions.
- **Command catalog**: sidebar with explanations in Russian/English, cards for nano/vim/htop/man/top/less.
- **Command history and snippets**: full-text search, secret masking, global and per-host snippets, manual ordering, quick-insert hotkey.
- **Server dashboard**: CPU/RAM/disk over a separate exec channel that doesn't load the main session, color-coded thresholds, one-time health banner for problems.
- **Host export/import**: JSON format without secrets, preview before import, protection against duplicates and invalid files.
- **Multi-language support**: Russian and English UI with automatic detection from the OS locale on first launch (falls back to Russian if the system language isn't supported), manual switch in settings, localized error and command databases.
- **Auto-update**: checks for new versions via GitHub Releases, manual and automatic checks, user data preserved across updates.
- **Help**: built-in guide (F1) covering getting started, snippets, the guard, the error detector, and hotkeys.

### Security

- Passwords and passphrases go through Windows Credential Manager (keytar) only — never stored in files or logs.
- `contextIsolation` is enabled; renderer has no direct access to Node.
- Secrets in command history are masked before being saved.
- The installer ships without a code-signing certificate (no Code Signing Certificate available) — integrity is verified via the SHA-256 checksum published with each release.
