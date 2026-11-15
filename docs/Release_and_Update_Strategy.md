# LucidSSH: Build, Release, and Update Strategy (public version)

| Field | Value |
|---|---|
| Platform | Windows 10/11 x64; Linux x64 (AppImage and .deb starting with 1.1) |
| Stack | Electron, TypeScript, electron-builder, electron-updater |
| Distribution channel | GitHub Releases |

> This is the public version of the document. Items covering the publisher's legal and organizational decisions are kept in the project's internal documentation.

## 1. Purpose of this document

This document defines:

- what form LucidSSH is delivered to the user in;
- how the developer builds and publishes new versions;
- how the app detects and installs updates;
- what files must be present in a GitHub Release;
- how previous versions are kept and how rollback works;
- how the installer and update packages are signed;
- what security and privacy requirements apply to updates.

## 2. The chosen approach

LucidSSH follows this scheme:

1. Primary Windows format — an NSIS `.exe` installer.
2. Additional Windows format — a portable exe requiring no installation (a single file with the profile data next to the exe; NFR-05). Linux x64 formats — AppImage and .deb.
3. The build runs through `electron-builder`.
4. NSIS and AppImage support auto-update via `electron-updater`, with user consent for downloading and installing. Portable and .deb are updated manually from Releases.
5. Version files are hosted on GitHub Releases.
6. The developer manually prepares a release from one source commit and version: Windows packages on Windows, Linux packages in a Linux environment.
7. CI checks builds; publishing a stable release remains a separate manual action. The current Linux job runs only for PRs and does not retain artifacts, so it is not a push-build source of release files.
8. A future signed Windows release must have a trusted publisher — **N/A for 1.0 and 1.1, releases without a certificate (see §9)**.
9. Previous stable versions are kept on GitHub Releases and never removed without a specific reason.

## 3. App formats

### 3.1 Main installer

File name:

```text
LucidSSH-Setup-1.1.0-x64.exe
```

The installer must:

- install into the current user's profile without requiring admin rights;
- create a Start menu shortcut;
- create a desktop shortcut if the user opts in;
- register LucidSSH in the Windows list of installed applications;
- support installing a new version over a previous one;
- never delete user data on update;
- cleanly remove program files via the standard Windows mechanism.

### 3.2 Portable version

File name:

```text
LucidSSH-Portable-1.1.0-x64.exe
```

The portable version:

- runs without installation;
- requires no admin rights;
- keeps the entire profile (settings, both databases, `known_hosts`, backups) next to the exe instead of `%APPDATA%` (NFR-05);
- is updated manually by the user: download the new exe from GitHub Releases and replace the old one while the app is closed — the profile files stay in place, the regular migrations preserve `profile.id`, `credentialId`, hosts, and history, and the mandated schema backup is created (UPD-04);
- is not the primary option for a beginner;
- must never automatically replace its own executable files: the app never invokes auto-update in the portable build and shows a manual-only state with a link to GitHub Releases.

On Windows, auto-update is supported only for the installed NSIS version. `latest.yml` is produced only for the NSIS Setup and its blockmap — the portable exe never appears in update metadata, and `latest.yml` is never edited by hand.

### 3.3 Linux: AppImage and .deb

- `LucidSSH-1.1.0-x86_64.AppImage` — run after `chmod +x`; supports auto-update through `latest-linux.yml` with user consent.
- `LucidSSH-1.1.0-amd64.deb` — install with `sudo apt install ./LucidSSH-1.1.0-amd64.deb`, recommended for Ubuntu/Debian. Update manually with a new package; the app never checks, downloads, or installs updates through electron-updater for this format.
- The profile lives in Electron's system `userData` directory (usually `~/.config/LucidSSH`), passwords in Secret Service via keytar. An unavailable store never permits saving secrets to files.
- The main live verification used Ubuntu 24.04; Ubuntu 22.04/Debian 12 have not been tested. Actual AppImage update installation remains unverified until the first real release with Linux artifacts.
- Electron's sandbox stays enabled. The .deb installer prepares `chrome-sandbox`; the app never adds `--no-sandbox`. FUSE requirements and an optional AppArmor workaround for AppImage are documented in the README.

## 4. GitHub Release contents

Every stable version gets its own Git tag and its own GitHub Release.

Expected `v1.1.0` contents (an example, not a publication announcement):

```text
v1.1.0
├── LucidSSH-Setup-1.1.0-x64.exe
├── LucidSSH-Setup-1.1.0-x64.exe.blockmap
├── LucidSSH-Portable-1.1.0-x64.exe
├── latest.yml
├── LucidSSH-1.1.0-x86_64.AppImage
├── LucidSSH-1.1.0-amd64.deb
└── latest-linux.yml
```

File purposes:

| File | Purpose |
|---|---|
| `LucidSSH-Setup-1.1.0-x64.exe` | Installs the app and installs the update |
| `.exe.blockmap` | Differential update downloads, where supported for a given build |
| `LucidSSH-Portable-1.1.0-x64.exe` | Manual, install-free use, profile next to the exe (NFR-05) |
| `latest.yml` | NSIS metadata for `electron-updater`, including `sha512` |
| `LucidSSH-1.1.0-x86_64.AppImage` | Linux x64, run without installation, auto-update support |
| `LucidSSH-1.1.0-amd64.deb` | Linux x64, manual installation and updates |
| `latest-linux.yml` | AppImage metadata for `electron-updater`, including `sha512` |

All artifacts have one source commit and version; each platform's files come from one build of that platform. Mixing builds or manually editing `latest.yml`/`latest-linux.yml` is forbidden. Before publishing, verify versions, names, sizes, and the actual files' `sha512`: `latest.yml` refers only to NSIS, never portable; `latest-linux.yml` must contain a valid AppImage entry and may also contain .deb entries in `files`, as generated by electron-builder. The AppImage updater selects AppImage and excludes .deb; the .deb build remains manual-only. Include any additional update files produced by that same build if the metadata references them.

## 5. Version numbering

Semantic Versioning is used:

```text
MAJOR.MINOR.PATCH
```

Examples:

| Change | New version |
|---|---|
| A bug fix with no compatibility change | `1.0.0` → `1.0.1` |
| A new backward-compatible feature | `1.0.1` → `1.1.0` |
| An incompatible architecture or data change | `1.1.0` → `2.0.0` |

The version in `package.json`, the installer's file name, the Git tag, and the GitHub Release must all match.

Re-publishing a different file under an already-released version number is forbidden. Any fix gets a new version — e.g. `1.0.1` instead of replacing `1.0.0`'s files.

## 6. Manual local publishing

At this stage, releases are created manually.

### 6.1 Sequence

1. Bump the version number in `package.json`.
2. Update the release notes — there are two, prepared in the same version-bump commit, before the build:
   - the GitHub Release description (markdown, with space for the SHA-256 of all four packages — NSIS Setup, portable exe, AppImage, .deb — and a Windows SmartScreen note); fill in the actual hashes after building; shown on the release page only;
   - `build/release-notes.md` (plain text, `## RU`/`## EN` sections) — picked up by `electron-builder` into `latest.yml`'s `releaseNotes` field and shown in the app's Settings → About card by the installed previous version.
3. Run tests and a production build.
4. Build the same prepared commit on Windows with `npm run dist -- --win --publish never` (NSIS and portable), and in Linux with `npm run dist -- --linux --publish never` (AppImage and .deb). Build resources live in `build/`; `build/release-notes.md` is included in both platforms' metadata. These commands never publish. Ensure the final commit's Linux files are available before release; PR-CI without artifact retention does not replace this step.
5. Check the generated `latest.yml` and `latest-linux.yml`: the version matches; file names, sizes, and SHA-512 match one build of the relevant platform; portable is absent from `latest.yml`. Verify a valid AppImage entry and its selection by the AppImage updater; .deb entries in `latest-linux.yml` are allowed and must not be removed manually. Compute SHA-256 for the four user-facing packages and add the actual hashes to the prepared release description.
6. Sign the executables with a code-signing certificate — **N/A, unsigned release (see §9)**.
7. Verify the digital signature and timestamp — **N/A, unsigned release (see §9)**.
8. Install the new version on a clean test system.
9. Verify updating from the previous stable version.
10. Verify that hosts, history, settings, and private-key references survive.
11. Create a Git tag like `v1.1.0` on the source commit of the verified builds.
12. Create a draft GitHub Release with the same version number.
13. Upload all files for both platforms listed in §4.
14. Verify the draft's completeness, hashes, and release notes. No automatic publishing.
15. Publish the stable release.
16. Verify update detection by the installed previous NSIS version and actual AppImage update installation using a previously prepared build. The latter remains deferred until the first real Linux release; do not report it as passed beforehand.

Commit, push, merge, tag creation, and publication require separate explicit developer commands. The version bump stays a separate commit; final SHA-256 hashes are added only after building. Before native-module tests, run `npm run rebuild:test`; restore the Electron ABI afterward with `npm run rebuild:app` (AGENTS.md §9).

### 6.2 Forbidden actions

- Never upload the certificate's private key or its password to GitHub.
- Never put a GitHub Personal Access Token in the app's code, `package.json`, or the installer.
- Never replace a published installer with a different file under the same version number.
- Never publish `latest.yml`/`latest-linux.yml` before the matching packages; publish the draft only after the complete set for both platforms is uploaded.
- Never publish an unverified build directly as stable.

## 7. How auto-update works

### 7.1 Checking for a new version

The NSIS build and AppImage:

1. check for an update after launch if automatic checks are enabled;
2. let the user trigger a manual check via "Check for updates";
3. only request the GitHub Releases data needed for the update;
4. never send command history, the host list, server addresses, terminal contents, or any other user data;
5. keep working normally with no internet, without an error message on every launch.

The check must never delay opening the interface or connecting over SSH.

Portable and .deb show a manual-only state linking to Releases: they never invoke electron-updater to check, download, or install. Opening the link is an explicit user action in the system browser.

### 7.2 User flow

When a new version is found, the app shows:

- the installed version number;
- the new version number;
- a short changelog;
- the approximate download size;
- "Download" and "Later" actions.

After downloading, the app shows:

- a "Update ready to install" message;
- "Restart now" and "On next exit" actions.

An update must never force-close an active SSH session. Before restarting, the app warns about any unfinished sessions.

### 7.3 Update channels

Versions 1.0 and 1.1 use only the stable channel.

- Draft releases are never offered to users.
- Prerelease versions are never offered to stable-channel users.
- Alpha and beta channels are out of scope for versions 1.0 and 1.1.

## 8. Update security

### 8.1 Mandatory checks

Before installing an update, the app must:

- fetch release metadata over HTTPS;
- download the package and use `sha512` from the generated `latest.yml` (NSIS) / `latest-linux.yml` (AppImage);
- verify the downloaded file's integrity by comparing its hash against the published checksum;
- reject a package that's corrupted or whose checksum doesn't match;
- log a technical update error without saving secrets or SSH session contents.

Checksum verification must run in the main process. The renderer gets no direct access to the filesystem, publishing tokens, or the install mechanism.

### 8.2 Publisher consistency

**Not applicable to versions 1.0 and 1.1.** Releases ship with no certificate (§9). The principle for a future signed Windows release follows.

The publisher name and certificate must be chosen before the first signed stable Windows release. Changing the publisher name or certificate must be planned separately, since it can break update verification for already-installed versions.

Every signature must carry a trusted timestamp. Thanks to the timestamp, a previously released version stays validly signed even after the certificate expires.

### 8.3 GitHub and a private repository

For direct updates via GitHub Releases, a public repository or a separate public release source is recommended.

The app must never contain a token for accessing a private GitHub repository — such a token could be extracted from the installed app. If the source stays private, updates need either a separate public server or a public repository containing only the release files.

## 9. Package signing and integrity

### 9.1 Decision for versions 1.0 and 1.1: no Code Signing Certificate

LucidSSH 1.0 and 1.1 ship **without a trusted Code Signing Certificate signature**. Returning to signing is a separate future decision with no assigned version.

**Measures for an unsigned release (not equivalent to signing):**

1. Every release ships with a **published SHA-256 checksum** for each user-facing package (NSIS Setup, portable exe, AppImage, .deb) in the GitHub Release description and on the download page.
2. **On first download** (the GitHub Release description), the user gets an explanation of what the Windows "Unknown publisher" warning means and how to verify the file via the checksum — this is the only point where the explanation is useful, since SmartScreen fires BEFORE launch, not after. The app's first-launch window doesn't explain anything specifically — instead, Settings → About has a calm informational line about why there's no digital signature, with a link to the checksum, for anyone who checks after the fact.
3. Before a stable publish, Windows packages are submitted to **Microsoft Security Intelligence** for review (submit.microsoft.com, best-effort scanning, no guarantees).
4. Once a signed version exists, this explanation will be updated.

### 9.2 Integrity-verification mechanism

For auto-update, electron-updater in the main process verifies the package's **SHA-512** against `sha512` in `latest.yml` (NSIS) / `latest-linux.yml` (AppImage). A corrupted package is rejected and not installed. The **SHA-256** in the release description is for manual verification of a downloaded file; the app does not parse it from that text.

HTTPS protects transmission; a checksum verifies file integrity. Neither SHA-256 nor SHA-512 from the same GitHub Release authenticates the publisher if the release itself is replaced. This is a residual risk of shipping without a trusted signature, not a promise of complete protection.

### 9.3 Microsoft SmartScreen and reputation

SmartScreen shows an "Unknown publisher" warning for unsigned files; a signature only clears part of the warnings.

After enough downloads accumulate with no negative signals, SmartScreen may lower the warning level. However, that isn't a controllable criterion and isn't part of the acceptance requirements.

### 9.4 Future versions: returning to signing

Once the distribution model is settled, returning to signing the stable installer is possible in a future version. The specific path and implementation belong to the roadmap for future versions.

## 10. SmartScreen

**The requirement wording below applies to a future signed Windows release.** For 1.0 and 1.1, NFR-06 applies: the installer is unsigned, see §9.

A digital signature confirms the publisher and file integrity, but on its own it doesn't guarantee the absence of a Microsoft Defender SmartScreen warning.

SmartScreen reputation also depends on the certificate's history, how widely the file is distributed, and the absence of negative signals. So the acceptance criterion can't just be phrased as "SmartScreen shows no warning."

The correct requirement wording:

> The stable installer is signed with a valid, trusted Code Signing Certificate, carries a trusted timestamp, shows the expected publisher name, and passes Windows digital-signature verification. The project team takes reasonable steps to build SmartScreen reputation, but the absence of a warning on every device is not a fully controllable criterion.

## 11. Version retention

GitHub Releases must keep every published stable version:

```text
v1.0.0
v1.0.1
v1.1.0
```

Rules:

- previous stable versions stay available for manual download;
- auto-update only ever offers the latest suitable stable version;
- drafts and prereleases don't count as the latest stable version;
- removing an old version is only allowed for a critical vulnerability, a legal reason, or corrupted release files;
- when an unsafe version is pulled, a visible warning is posted on the release page;
- deleting a Git tag and release is only ever done as a separate, deliberate action.

## 12. Rollback

Automatic downgrades never happen.

If a new version has a critical bug:

1. publishing of the problem version is stopped or it's flagged with a warning;
2. a new fixed version is released with a higher number, e.g. `1.0.2`;
3. users are offered the update to the fixed version;
4. if needed, the user can manually download a previous installer from GitHub Releases.

Local database migrations must be designed so a failed update never corrupts data. A local database backup is made before any irreversible migration.

## 13. User data preservation

An update or a reinstall over an existing version must never delete:

- saved hosts and groups;
- command history and notes;
- `known_hosts`;
- app settings;
- references to the original private-key files;
- LucidSSH's entries in the system Secret Store (Windows Credential Manager / Secret Service).

Private keys are never copied into the app package or the update directory. Passwords and passphrases play no role in verifying or installing an update.

Fully deleting user data is only allowed via a separate, explicit user choice in the uninstaller.

## 14. Privacy and network connections

Auto-update requires a separate outbound HTTPS connection to GitHub Releases, on top of the user's SSH connections. The corresponding requirement (`SEC-07`) is worded as:

> The app never sends host data, SSH session data, commands, terminal output, keys, or credentials to external services. In version 1.0, only SSH connections to servers the user specifies and HTTPS requests to the configured GitHub Releases update source are allowed. The update request contains only the technical network data inherent to HTTPS, plus what's needed to identify the version. There's no telemetry or analytics.

Settings must show a link to the update source. The manual-check button must clearly state that it connects to GitHub.

## 15. Error handling

| Situation | Behavior |
|---|---|
| No internet | The app keeps working; the check error doesn't interfere with SSH |
| GitHub unreachable | Retry later or manually |
| Not enough disk space | The download stops, a clear message is shown |
| Corrupted file | The file is deleted, the install never starts |
| Invalid signature (future signed Windows release; N/A for 1.0 and 1.1) | The update is blocked as potentially unsafe |
| An SSH session is active | Restart only happens after user confirmation |
| Install failed | The current version stays functional, retry instructions are shown |

Every message shown to the user must be localized. The technical update log must never contain secrets, server addresses, commands, or terminal output.

## 16. Requirements for the spec

### UPD-01. Update check

NSIS and AppImage check GitHub Releases on launch (if automatic checks are enabled) and on manual request, without blocking the interface or SSH connections. Portable and .deb show a manual-only state linking to Releases.

**Acceptance criteria:** when a new stable version exists, its number and changelog are shown; with no internet, the app keeps working.

### UPD-02. User consent

Downloading and restarting only happen after a clear user action.

**Acceptance criteria:** the app never closes an active SSH session without confirmation.

### UPD-03. Integrity verification

Before automatic installation, electron-updater verifies SHA-512 against `sha512` in the platform's metadata. SHA-256 in the release description is for manual verification.

**Acceptance criteria:** a corrupted package, or one whose checksum doesn't match, is rejected and not installed.

### UPD-04. Data preservation

An update never deletes user data or secrets.

**Acceptance criteria:** after updating from a previous stable version, prior hosts, history, settings, and system Secret Store entries are still available.

### UPD-05. Release publishing

Every version has a unique number, a Git tag, and a GitHub Release. Packages have one source commit and version; each platform's files come from one build of that platform. Upload both platforms' artifacts, including `latest.yml` and `latest-linux.yml`, before publishing.

**Acceptance criteria:** a previous auto-update-capable build detects the published release and updates successfully. Actual AppImage update installation remains deferred until the first real Linux release (§3.3).

### UPD-06. Previous versions

Previous stable versions are kept on GitHub Releases.

**Acceptance criteria:** the user can manually download a previous installer, unless the release was pulled for security reasons.

### SIGN-01. Stable-version signing (N/A for 1.0 and 1.1)

**Not applicable to versions 1.0 and 1.1.** Releases ship without a Code Signing Certificate.

**Principle for the future:** the stable installer and update package are signed with a trusted, timestamped Code Signing Certificate.

**Acceptance criteria (once applicable):** Windows file properties show a valid signature and the expected publisher.

### SIGN-02. Signing-key protection

**Versions 1.0 and 1.1 have no certificate.** Keeping the private key out of the repository is required regardless of version.

**Acceptance criteria (once applicable):** auditing the repository and release files finds no certificate with a private key, password, or access token.

## 17. Version 1.1 end-to-end flow

```text
Developer
    → bumps the version number
    → builds Windows/Linux from one source commit and version
    → computes the SHA-256 checksum of the files
    → submits Windows packages to Microsoft Security Intelligence for scanning
    → verifies a clean install and an update
    → creates a Git tag and a draft release
    → uploads Setup, blockmap, portable exe, AppImage, .deb, and both metadata files
    → adds the SHA-256 to the Release description
    → publishes the stable GitHub Release

The user's LucidSSH
    → NSIS/AppImage: checks its platform's metadata over HTTPS
    → reports the new version
    → downloads the update with the user's consent
    → verifies SHA-512 against metadata
    → offers a safe restart
    → installs the version over the current one
    → preserves user data

Portable and .deb: the user opens Releases and updates manually.
```
