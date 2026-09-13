# LucidSSH for Windows: Build, Release, and Update Strategy (public version)

| Field | Value |
|---|---|
| Platform | Windows 10/11 x64 |
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

1. Primary distribution format — an NSIS `.exe` installer.
2. Secondary format — a portable ZIP requiring no installation.
3. The build runs through `electron-builder`.
4. The installed version auto-updates via `electron-updater`.
5. Version files are hosted on GitHub Releases.
6. At this stage, the developer builds, verifies, and publishes releases manually from their Windows machine.
7. The build may later move to GitHub Actions, but publishing a stable release must always require manual confirmation.
8. Every public stable update must be signed by a single trusted publisher.
9. Previous stable versions are kept on GitHub Releases and never removed without a specific reason.

## 3. App formats

### 3.1 Main installer

File name:

```text
LucidSSH-Setup-1.0.0.exe
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
LucidSSH-Portable-1.0.0.zip
```

The portable version:

- runs without installation;
- requires no admin rights;
- is updated manually by the user;
- is not the primary option for a beginner;
- must never automatically replace its own executable files.

Automatic updates in version 1.0 are only supported for the installed NSIS version.

## 4. GitHub Release contents

Every stable version gets its own Git tag and its own GitHub Release.

Example release `v1.0.1`:

```text
v1.0.1
├── LucidSSH-Setup-1.0.1.exe
├── LucidSSH-Setup-1.0.1.exe.blockmap
├── LucidSSH-Portable-1.0.1.zip
└── latest.yml
```

File purposes:

| File | Purpose |
|---|---|
| `LucidSSH-Setup-1.0.1.exe` | Installs the app and installs the update |
| `.exe.blockmap` | Differential update downloads, where supported for a given build |
| `LucidSSH-Portable-1.0.1.zip` | Manual, install-free use |
| `latest.yml` | Latest-version metadata for `electron-updater` |

The installer, `.blockmap`, and `latest.yml` must all come from the same build. Manually editing `latest.yml` or mixing files from different builds is forbidden.

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
   - the GitHub Release description (markdown, with the installer's SHA-256 and a note about the SmartScreen warning) — shown on the release page only;
   - `build/release-notes.md` (plain text, `## RU`/`## EN` sections) — picked up by `electron-builder` into `latest.yml`'s `releaseNotes` field and shown in the app's Settings → About card by the installed previous version.
3. Run tests and a production build.
4. Build the NSIS installer and the portable ZIP via `electron-builder --publish never` (publishing is a separate manual step — see §6.2).
5. Sign the executables with a code-signing certificate — **N/A, unsigned release (see §9)**.
6. Verify the digital signature and timestamp — **N/A, unsigned release (see §9)**.
7. Install the new version on a clean test system.
8. Verify updating from the previous stable version.
9. Verify that hosts, history, settings, and private-key references survive.
10. Create a Git tag like `v1.0.1`.
11. Create a GitHub Release with the same version number.
12. Upload every file produced by that one build.
13. Publish the release as a draft first and do a final review.
14. Publish the stable release.
15. Verify that the installed previous version detects the update.

### 6.2 Forbidden actions

- Never upload the certificate's private key or its password to GitHub.
- Never put a GitHub Personal Access Token in the app's code, `package.json`, or the installer.
- Never replace a published installer with a different file under the same version number.
- Never publish `latest.yml` before the corresponding installer has been uploaded.
- Never publish an unverified build directly as stable.

## 7. How auto-update works

### 7.1 Checking for a new version

The installed LucidSSH:

1. checks for an update after the app launches;
2. lets the user trigger a manual check via "Check for updates";
3. only requests the GitHub Releases data needed for the update;
4. never sends command history, the host list, server addresses, terminal contents, or any other user data;
5. keeps working normally with no internet, without an error message on every launch.

The check must never delay opening the interface or connecting over SSH.

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

Version 1.0 uses only the stable channel.

- Draft releases are never offered to users.
- Prerelease versions are never offered to stable-channel users.
- Alpha and beta channels are out of scope for version 1.0.

## 8. Update security

### 8.1 Mandatory checks

Before installing an update, the app must:

- fetch release metadata over HTTPS;
- download the update package and its SHA-256 checksum from the GitHub Release;
- verify the downloaded file's integrity by comparing its hash against the published checksum;
- reject a package that's corrupted or whose checksum doesn't match;
- log a technical update error without saving secrets or SSH session contents.

Checksum verification must run in the main process. The renderer gets no direct access to the filesystem, publishing tokens, or the install mechanism.

### 8.2 Publisher consistency

The publisher name and certificate must be chosen before the first stable public release. Changing the publisher name or certificate must be planned separately, since it can break update verification for already-installed versions.

Every signature must carry a trusted timestamp. Thanks to the timestamp, a previously released version stays validly signed even after the certificate expires.

### 8.3 GitHub and a private repository

For direct updates via GitHub Releases, a public repository or a separate public release source is recommended.

The app must never contain a token for accessing a private GitHub repository — such a token could be extracted from the installed app. If the source stays private, updates need either a separate public server or a public repository containing only the release files.

## 9. Package signing and integrity

### 9.1 Decision for version 1.0: no Code Signing Certificate

As things stand, the decision is: LucidSSH 1.0 ships **without a trusted Code Signing Certificate signature**.

**What replaces signing in 1.0:**

1. Every release ships with a **published SHA-256 checksum** in the GitHub Release description and on the download page.
2. **On first download** (the GitHub Release description), the user gets an explanation of what the Windows "Unknown publisher" warning means and how to verify the file via the checksum — this is the only point where the explanation is useful, since SmartScreen fires BEFORE launch, not after. The app's first-launch window doesn't explain anything specifically — instead, Settings → About has a calm informational line about why there's no digital signature, with a link to the checksum, for anyone who checks after the fact.
3. Before a stable publish, every release is submitted to **Microsoft Security Intelligence** for review (submit.microsoft.com, best-effort scanning, no guarantees).
4. Once a signed version exists, this explanation will be updated.

### 9.2 Integrity-verification mechanism

On update, the app compares the downloaded package's SHA-256 hash against the checksum published in the GitHub Release's `latest.yml`. A corrupted package is rejected and not installed.

### 9.3 Microsoft SmartScreen and reputation

SmartScreen shows an "Unknown publisher" warning for unsigned files; a signature only clears part of the warnings.

After enough downloads accumulate with no negative signals, SmartScreen may lower the warning level. However, that isn't a controllable criterion and isn't part of the acceptance requirements.

### 9.4 Future versions: returning to signing

Once the distribution model is settled, returning to signing the stable installer is possible in a future version. The specific path and implementation belong to the roadmap for future versions.

## 10. SmartScreen

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
- LucidSSH's entries in Windows Credential Manager.

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
| Invalid signature | The update is blocked as potentially unsafe |
| An SSH session is active | Restart only happens after user confirmation |
| Install failed | The current version stays functional, retry instructions are shown |

Every message shown to the user must be localized. The technical update log must never contain secrets, server addresses, commands, or terminal output.

## 16. Requirements for the spec

### UPD-01. Update check

The app checks GitHub Releases on launch and on manual request, without blocking the interface or SSH connections.

**Acceptance criteria:** when a new stable version exists, its number and changelog are shown; with no internet, the app keeps working.

### UPD-02. User consent

Downloading and restarting only happen after a clear user action.

**Acceptance criteria:** the app never closes an active SSH session without confirmation.

### UPD-03. Integrity verification

Before installing, package integrity is verified by comparing SHA-256 against the checksum published in the GitHub Release.

**Acceptance criteria:** a corrupted package, or one whose checksum doesn't match, is rejected and not installed.

### UPD-04. Data preservation

An update never deletes user data or secrets.

**Acceptance criteria:** after updating from a previous stable version, prior hosts, history, settings, and Credential Manager entries are still available.

### UPD-05. Release publishing

Every version has a unique number, a Git tag, and a GitHub Release. All update files come from the same build.

**Acceptance criteria:** an installed previous version detects the published release and updates successfully.

### UPD-06. Previous versions

Previous stable versions are kept on GitHub Releases.

**Acceptance criteria:** the user can manually download a previous installer, unless the release was pulled for security reasons.

### SIGN-01. Stable-version signing (N/A for v1.0)

**Not applicable to version 1.0.** The release ships without a Code Signing Certificate.

**Principle for the future:** the stable installer and update package are signed with a trusted, timestamped Code Signing Certificate.

**Acceptance criteria (once applicable):** Windows file properties show a valid signature and the expected publisher.

### SIGN-02. Signing-key protection (N/A for v1.0)

**Not applicable to version 1.0.** The release ships with no certificate.

**Principle for the future:** the certificate's private key is never stored in the repository or the source code.

**Acceptance criteria (once applicable):** auditing the repository and release files finds no certificate with a private key, password, or access token.

## 17. Version 1.0 end-to-end flow

```text
Developer
    → bumps the version number
    → builds LucidSSH locally
    → computes the SHA-256 checksum of the files
    → submits the release to Microsoft Security Intelligence for scanning
    → verifies a clean install and an update
    → creates a Git tag and a draft release
    → uploads the EXE, blockmap, ZIP, and latest.yml
    → adds the SHA-256 to the Release description
    → publishes the stable GitHub Release

The user's LucidSSH
    → checks latest.yml over HTTPS
    → reports the new version
    → downloads the update with the user's consent
    → verifies integrity by comparing SHA-256
    → offers a safe restart
    → installs the version over the current one
    → preserves user data
```
