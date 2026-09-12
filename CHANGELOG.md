# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **A per-host switch for command history.** The connection form now has a "Record command history" toggle, independent of the global one in Settings → Security. Commands already recorded for that host are not affected.

### Changed

- **Esc now closes exactly one thing, in a consistent order, everywhere.** All 23 places that used to listen for Esc on their own — dialogs, drawers, the context menu, the snippet palette, search, the error panel, and in-place edits like a tab rename or a history note — now go through a single shared stack. The most recently opened thing closes first, regardless of where keyboard focus happens to be.
- **The dangerous command guard now names every object a compound command destroys.** `rm -rf /var/www && rm -rf /etc` used to name only the first one, so you confirmed one deletion while two were about to happen. The dialog now lists all of them and asks you to type the name of one of them — picked at random among the most severe, so the expected answer can't be learned by habit and typed without reading. Commands with a single dangerous fragment are unchanged.

### Fixed

- **Muting a dashboard health finding during a Quick Connect session no longer silences that finding for every other Quick Connect session.** All such sessions shared one mute entry with nowhere host-specific to live. Quick Connect sessions have no saved host to attach a persistent mute to, so the "Don't show again" button is no longer shown for them; the banner's close button still works as before.
- **"Reset settings to defaults" no longer loses SSH keys pending deployment to the server, or changes the interface language.** Both used to be wiped as a side effect of the reset, alongside the actual settings — a key generated in step 4 of the SSH key wizard but not yet copied to the server would silently disappear, so the next connection attempt used a key the server didn't recognize.
- **Esc no longer leaks into the remote session while also closing a panel.** Previously the key reached xterm's own handling before the panel's listener ran (no `preventDefault`), so it did both: the control byte was sent to the server *and* the panel closed. Now Esc belongs to the open panel until it's closed.
- **Esc while editing a history note no longer closes the whole History drawer.** The note input and the drawer each listened for Esc independently; cancelling the note also closed the drawer underneath it.
- The SSH key wizard's Esc handling no longer depends on a hand-rolled `capture`/`stopPropagation` trick to avoid closing the connection form behind it — the shared stack orders it correctly by construction.
- Four surfaces that already closed on a backdrop click — the JSON host import dialog, the "Возможности LucidSSH" guide, the multi-line paste preview, and the server dashboard — now also close on Esc.
- The host import dialogs (JSON import and PuTTY/ssh_config/WinSCP import) can no longer be closed — by backdrop click, Esc, or the close button — while an import is actually being applied. Previously any of those closed the dialog immediately while the import kept running in the background, discarding the result (imported/skipped counts, errors) with no way to see it.
- **`rm -rf /` now actually has to be typed out to be confirmed.** The guard asks for the affected object's name, but the root directory has no last path segment, so the expected text was empty — the confirm button was active before you typed anything, on the single most destructive command it recognizes. It now asks you to type `/`.
- **The dangerous command guard now asks you to confirm the right object.** In a compound command whose destructive part wasn't last — `rm -rf ./node_modules && npm install` — the confirmation dialog named the tail of the whole line (`install`) instead of what was actually being deleted. The guard still blocked such commands, but the name you had to type said nothing about the danger. It now takes the object from the destructive fragment itself.
- The same fix now also covers a background launch with a single `&` — `rm -rf /var/www & echo done` asked you to confirm `done` instead of `/var/www`. A redirect like `2>&1`, `&>file`, or `>&2` is correctly left alone; it's not treated as a separator.
- **Running `top` no longer wipes the session history above it.** `top` doesn't switch to the alternate screen buffer the way `vim` or `less` do — it clears the primary screen with `ESC[H ESC[2J` and never restores it, so quitting with `q` left its last frame on screen and everything printed before it was gone for good, not even reachable by scrolling up. An erased screen is now pushed into scrollback instead of being cleared in place, which is what PuTTY does. As a side effect this also applies to `clear` and `Ctrl+L`: the screen still goes blank, but the screenful they wipe now stays reachable by scrolling up instead of being discarded.
- **Snippets no longer fail to load in a Quick Connect session.** Opening the command catalog (`Ctrl+Shift+L`) or the snippet palette (`Ctrl+Space`) during a Quick Connect session threw an IPC validation error and left both lists empty: a Quick Connect session carries no saved host, and the internal placeholder id used for it was rejected as an invalid host id. Such a session now correctly shows the global snippets, and the per-host snippet tab — which could never hold anything for a Quick Connect session, since server-scoped snippets can't be saved there — is hidden instead of shown empty.

- **`Ctrl+H` and `Ctrl+K` now work while the terminal has focus.** Opening the history drawer and Quick Connect from the keyboard silently did nothing in a focused terminal — the toolbar buttons worked, the shortcuts didn't. xterm recognizes those two as terminal input (`Ctrl+H` is Backspace, `Ctrl+K` is a kill-line) and stopped the key before the app ever saw it, while a shortcut like `Ctrl+,` — which maps to no control character — got through. All app shortcuts are now claimed before the terminal sees them, whatever they're bound to.
- **App shortcuts no longer send a stray control byte to the server on top of doing their job.** `Ctrl+F` (search) also sent `0x06` to the shell, `Ctrl+W` (close tab) also sent `0x17` — a kill-word in most shells. Only `Ctrl+Space` was handled correctly. A shortcut that the app acts on is now consumed by the app, and this holds for any combination you rebind it to.
- **Assigning a new shortcut in Settings no longer triggers the action you're rebinding.** Pressing `Ctrl+F` while capturing a combination assigned it *and* opened the terminal search behind the Settings overlay.

### Security

- **The "Test the connection" button no longer sends your password to a server whose host key was never checked.** For the target host, the button used to skip fingerprint verification entirely and authenticate anyway; a jump host's key was checked, but only against keys already known, so a jump host that had never been opened on its own always failed the test even though a real connection through it worked fine. Both hops now go through the same trust decision a normal connection uses: an unfamiliar or changed key shows the fingerprint and asks for confirmation before any password or key is sent. A server verified this way is remembered, so the first real connection to it doesn't ask again.

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
