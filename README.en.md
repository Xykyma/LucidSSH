<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
  <img alt="LucidSSH" src="docs/assets/logo-light.svg" width="360">
</picture>
</p>

<p align="center"><a href="README.md">🇷🇺 Русский</a> | 🇬🇧 English</p>

An SSH client for Windows and Linux that explains what's happening and stops you from breaking your server by accident.

> Version **1.1.0**, with Linux packages and Windows portable, is being prepared. Instructions for them follow below; download only artifacts already published in [Releases](https://github.com/Xykyma/LucidSSH/releases).

---

## Why another SSH client

PuTTY is reliable but doesn't explain errors or warn you about dangerous commands. Termius looks great but requires a subscription and an account, and your keys go to the cloud. MobaXterm is packed with features most people need once a year.

LucidSSH fills a different gap: it's for people who manage one or two servers, aren't professional sysadmins, and want to understand what's happening — without extra effort.

---

## Key features

### Dangerous Command Guard

Before running `rm -rf`, `dd`, `mkfs`, `chmod 777`, and similar commands, the app stops execution and explains exactly what will happen. Confirmation requires manually typing the name of the object being affected — not just clicking "OK". The Guard warns about **recognized** dangerous commands; it's protection against mistakes, not a guarantee against every destructive action.

![Dangerous Command Guard](docs/assets/guard_en.png)

### Error Detector

After every failed command, a panel explains what went wrong. `Permission denied` gives you a list of causes and concrete checks. `Connection refused` shows how it differs from `Connection timed out`. Works fully offline, from a built-in database, with nothing sent anywhere.

![Error Detector](docs/assets/error_en.png)

### "Where am I" breadcrumb and a mini server dashboard

The bar above the terminal always shows which server you're on, as which user, and in which folder. Each path segment is clickable and inserts itself into the input line. A root session is highlighted in red. Next to it, a compact CPU/RAM/disk/ping line updates every 10 seconds over a background channel without interrupting your work.

![Breadcrumb and mini dashboard](docs/assets/breadcrumbs-dashboard_en.png)

### Command catalog

A sidebar with plain-language explanations: what a command does, what each flag means, examples. Clicking a flag inserts the command into the terminal.

![Command catalog](docs/assets/catalog_en.png)

### History with notes

Every command is saved locally with a timestamp, host name, and exit code. You can attach a note to any entry, and search across commands and notes. Common secrets (passwords, tokens, keys typed into a command) are masked before being saved.

### Fully local

No account, no cloud, no telemetry. Passwords live in the system password store (Windows Credential Manager, Secret Service on Linux). Private keys stay where they already are — the app never copies them into its own directory. The only outbound connections are SSH to your own servers and an HTTPS update check.

---

## Who it's for

- First-time connection to a VPS, home server, NAS, or Raspberry Pi
- Managing a handful of servers in a home lab
- Developers who want quick SSH access without the extra weight
- PuTTY users tired of juggling one window per server

---

## Installation

### Windows

1. Download `LucidSSH-Setup-x.x.x-x64.exe` from [Releases](https://github.com/Xykyma/LucidSSH/releases).
2. Verify the SHA-256 checksum — it's published in the release description.
3. Run the installer.

#### Portable (starting with 1.1.0)

Download `LucidSSH-Portable-x.x.x-x64.exe`, verify its SHA-256, and put it in a dedicated writable folder. No installation or administrator rights are needed. Settings, hosts, history, `known_hosts`, and backups live next to the exe; to move the profile, close the app and move the whole folder, including `profile.id`.

Passwords and passphrases stay in Windows Credential Manager and **do not travel with the folder to another PC or user** — enter them again there. Private keys are not copied: check the original key path on the other PC. Profile files are not encrypted; portable makes no promise of leaving no incidental OS traces.

Updates are manual: with the app closed, replace only the exe with the new file from Releases, keeping the other profile files. Do not delete or regenerate `profile.id`.

**About the Windows SmartScreen warning.** Versions 1.0 and 1.1 ship without a code-signing certificate; returning to signing is a separate future decision. Windows may therefore show a "Windows protected your PC" warning. The warning alone proves neither that the file is dangerous nor that it is safe. If you trust the source and choose to proceed, Windows offers "More info" → "Run anyway". Compare the downloaded file's SHA-256 with the release description: this verifies integrity, but does not protect against replacement of the GitHub Release itself.

### Linux

Linux x64 is packaged as AppImage and `.deb` starting with 1.1.0. Before downloading, check that the selected release already contains Linux artifacts.

Download a build from [Releases](https://github.com/Xykyma/LucidSSH/releases):

- **`.deb`** — recommended for Ubuntu and Debian: `sudo apt install ./LucidSSH-x.x.x-amd64.deb`. Updated manually — download the new version from Releases (the button in About opens the page).
- **`.AppImage`** — `LucidSSH-x.x.x-x86_64.AppImage`: `chmod +x` and run. Supports auto-update; downloading and installing require the user's consent. Actual AppImage update installation has not yet been verified; it is scheduled for the first release with Linux artifacts.

Before running either Linux package, compare its SHA-256 with the release description.

Saving passwords requires Secret Service — gnome-keyring or KWallet (usually already present in GNOME and KDE). Without it the app works, but passwords can't be saved: connect with a key or type the password each time.

**AppImage on Ubuntu 24.04:**

- Requires the `libfuse2t64` package: `sudo apt install libfuse2t64`. Without it the AppImage won't start. (On Ubuntu 22.04 the package is named `libfuse2`; the build has not been tested on 22.04 — verified on 24.04.)
- AppArmor on Ubuntu 23.10+ forbids unprivileged user namespaces, so an Electron AppImage may fail to start. The simplest fix is to install the `.deb`. If you need the AppImage, create the profile `/etc/apparmor.d/lucidssh` (use your own file path):

  ```
  abi <abi/4.0>,
  include <tunables/global>
  profile lucidssh /home/USER/Applications/LucidSSH-*.AppImage flags=(unconfined) {
    userns,
  }
  ```

  and load it: `sudo apparmor_parser -r /etc/apparmor.d/lucidssh`. We don't use `--no-sandbox` — it weakens window isolation.

The key-creation wizard needs `ssh-keygen`: `sudo apt install openssh-client`.

### System requirements

- Windows 10 (version 1903+) or Windows 11, x64; or Linux x64. Linux packages have been tested on Ubuntu 24.04; Ubuntu 22.04, Debian 12, and other distributions have not been tested separately.
- 200 MB RAM idle

---

## Privacy

LucidSSH collects no telemetry, requires no account, and sends data nowhere except your own servers. The only outbound traffic the app initiates itself:

- SSH connections to the hosts you add;
- in the NSIS build and AppImage, a check for new versions against GitHub Releases (on demand and at startup if automatic checks are enabled, non-blocking). Portable and `.deb` never invoke auto-update; they offer to open Releases in the system browser.

Passwords are stored in the system password store: Windows Credential Manager, or Secret Service (gnome-keyring, KWallet) on Linux. Private keys are never copied into the app's directory — the original path on disk is used.

---

## What's not in the app yet

An SFTP browser, Mosh, Telnet, RDP, VNC, X11, Serial, cloud sync, and a mobile version — either planned for future releases or not planned at all.

Local, offline AI-powered explanations are planned for a future release, to complement the built-in databases for rare commands and non-standard errors. The built-in command and error databases already provide immediate value — no model downloads, no setup.

A light theme, additional hotkeys, an absolute path in the Guard dialog, and snippet placeholders are planned after 1.1.0; exact versions have not been assigned.

---

## Stack

Electron · TypeScript · React · xterm.js · ssh2 · SQLite (better-sqlite3) · system password store (keytar)

---

## License

The source code is available to view, but it is **not licensed** for use, copying, modification, or distribution without the author's explicit permission (all rights reserved). This is a deliberate choice while the project's monetization model is still being decided — an open license would foreclose future options. If you're interested in using LucidSSH's code in your own project, reach out and let's talk.

---

## Security

Found a vulnerability? Please don't open a public Issue. Report it privately via **[GitHub Security Advisory](https://github.com/Xykyma/LucidSSH/security/advisories/new)** — details in [SECURITY.md](SECURITY.md).

---

## Feedback

Bug reports and feature requests go through [Issues](https://github.com/Xykyma/LucidSSH/issues). Pull requests aren't accepted yet — this is a solo, actively developed project.

---

## Status

The 1.0 series is released. Version 1.1.0 is being prepared for publication; available files and versions are listed in Releases.
