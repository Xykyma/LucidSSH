# LucidSSH for Windows: Security Guide

| Field | Value |
|---|---|
| Document version | 1.1 |
| Date | June 23, 2026 |
| Related documents | `TZ.md` (section 4 — requirements SEC-01…08), `Data_Structures.md`, `Release_and_Update_Strategy.md` |

> This document is the normative basis for requirements SEC-01…SEC-08, TERM-07, HIST-07, and UPD/SIGN in the spec. When convenience and security conflict, security wins.

## Purpose of this document

This document describes LucidSSH's security model in plain language while also setting mandatory implementation rules.

The document is meant to be handed to Claude for:

- refining the specification;
- designing the architecture;
- writing and reviewing code;
- preparing security tests.

If a requirement in this document conflicts with implementation convenience, security takes priority. Exceptions must be separately agreed on and documented.

## 1. What needs protecting

LucidSSH works with remote servers, so the app must protect:

- server passwords;
- private-key passphrases;
- private SSH keys;
- the user's commands and command history;
- the contents of the terminal session;
- the list of servers and their addresses;
- the user, from connecting to a spoofed server;
- the user's computer, from malicious terminal output;
- the app, from tampered updates;
- the main process, from malformed or malicious requests from the interface.

## 2. Scope of protection

LucidSSH must protect against:

- interception of SSH traffic;
- SSH server spoofing;
- accidentally saving secrets to files or logs;
- the interface performing arbitrary operations on Windows;
- malicious output from the remote server;
- accidentally sending multi-line and recognized dangerous commands;
- a tampered installer or update;
- known vulnerabilities in outdated dependencies.

LucidSSH cannot fully protect against:

- malware already running as the Windows user;
- the computer's administrator;
- physical access to an unlocked computer;
- actions the user knowingly confirmed;
- every possible destructive shell command.

The interface must never promise absolute protection. For example, the guard should be described as a way to warn about recognized dangerous commands, not as a guarantee that blocks every dangerous operation.

## 3. Electron architecture

An Electron app has several distinct parts:

| Part | Purpose | Trust level |
|---|---|---|
| Renderer | React UI, xterm.js, forms and panels | Untrusted |
| Preload | A limited bridge between renderer and main | Partially trusted |
| Main process | SSH, secrets, files, SQLite, and system APIs | Trusted |
| Remote server | Sends terminal output | Untrusted |

The renderer must be treated as potentially compromised, because it processes data from the remote server. It must never directly receive passwords, passphrases, private-key contents, Node.js access, filesystem access, or SSH-connection objects.

## 4. IPC and contextBridge

### What IPC is

IPC, Inter-Process Communication, means passing data between processes. In LucidSSH, the interface never opens an SSH connection itself. It sends the main process a narrow request, e.g.: "connect hostId 42."

The safe sequence:

1. The renderer calls an allowed preload method.
2. Preload forwards the request to the main process.
3. Main validates the request.
4. Main performs the operation.
5. The renderer receives only the necessary result.

### Mandatory IPC rules

- IPC is only available through `contextBridge`.
- The renderer must never be given generic `send`, `invoke`, or a channel name as an argument.
- Every method performs exactly one specific operation.
- All incoming data is validated in the main process against a schema: type, format, allowed length and range.
- `sessionId` is checked for existence and ownership by the calling window.
- `hostId` must reference an existing record accessible to the current app profile.
- Errors returned to the renderer must never contain secrets, sensitive file paths, or an internal stack trace in production.
- Secrets are never returned over IPC.

Example of an allowed API:

```ts
window.lucidSSH.connectHost(hostId);
window.lucidSSH.disconnectSession(sessionId);
window.lucidSSH.sendTerminalInput(sessionId, text);
window.lucidSSH.confirmHostKey(requestId, decision);
```

Unsafe API:

```ts
window.electron.invoke(channelName, arbitraryData);
window.files.read(arbitraryPath);
window.shell.execute(arbitraryCommand);
```

## 5. Renderer isolation

Every `BrowserWindow` must have:

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: preloadPath
}
```

What this means:

- `contextIsolation: true` separates the interface page from the privileged preload code.
- `nodeIntegration: false` stops the interface from reading files, spawning processes, or using Node.js directly.
- `sandbox: true` further restricts the renderer process.
- `preload` exposes only a predefined, minimal API.

Also required:

- disable `webview`;
- forbid arbitrary window navigation;
- block `window.open`;
- disable remote debugging in production;
- never load the interface or JavaScript from external servers;
- never use `eval`, `new Function`, or similar execution of strings as code.

## 6. CSP

CSP, Content Security Policy, defines where the interface can load code from and where it can send data.

LucidSSH needs a strict, local-only CSP:

- scripts only from the app package;
- `unsafe-eval` forbidden;
- external frames forbidden;
- loading remote JavaScript forbidden;
- renderer network connections forbidden unless the architecture requires them;
- external images and fonts aren't loaded without a separate decision.

SSH connections and update checks run from the main process, never from the renderer.

## 7. SSH and encryption

SSH creates an encrypted channel between LucidSSH and the server. Someone intercepting network traffic must not be able to see the password, commands, or server responses.

Mandatory rules:

- use SSH-2;
- use the `ssh2` library or the system's OpenSSH;
- never implement custom cryptography;
- never enable outdated algorithms purely for compatibility without a separate warning;
- verify the host key before authentication;
- never write secrets or cryptographic material to logs.

## 8. Fingerprint and known_hosts

A fingerprint is a short hash of the SSH server's public key. It confirms the user is connecting to the same server as before.

### First connection

LucidSSH must:

1. Fetch the server's host key.
2. Compute and show the fingerprint, preferably SHA-256.
3. Explain to the user where they can verify it.
4. Not proceed with the connection without explicit confirmation.
5. After confirmation, save the key to the local `known_hosts`.

### Reconnecting

- Key matches: proceed with the connection.
- Server previously unknown: ask for confirmation.
- Key changed: block the connection until the user decides.

When the key has changed, a generic warning with a primary "Continue" button must never be shown. The possible server reinstall and the risk of a man-in-the-middle attack must be explained. The user should verify the new fingerprint through an independent source.

Host key verification happens before a password or private-key signature is sent.

## 9. Connection protocol

The mandatory connection sequence:

1. The renderer passes only `hostId` to main.
2. Main loads the host's settings from SQLite.
3. Main fetches the password or passphrase from Windows Credential Manager, if needed.
4. Main opens a connection to the given address and port.
5. Main fetches and verifies the host key.
6. On a new or changed key, the connection waits for the user's decision.
7. Authentication only proceeds after the host key has been verified successfully.
8. Main creates the SSH session and returns only an identifier and a status to the renderer.
9. The secret is dropped from any accessible reference immediately after use and never cached beyond the session.
10. On disconnect, references to secrets, streams, and connection objects are destroyed.

The renderer must never know the password, passphrase, or private-key contents at any stage.

## 10. Passwords and Windows Credential Manager

Server passwords and key passphrases are stored only in Windows Credential Manager, via `keytar`.

They must never be saved:

- in SQLite;
- in `config.json`;
- in a production build's `.env`;
- in logs;
- in crash reports;
- in command history;
- in renderer state;
- in IPC messages.

SQLite only stores a reference like `LucidSSH/{hostId}`. When a host is deleted, the associated Credential Manager entry must also be removed after user confirmation.

The password field in the UI must never auto-fill with the actual saved value. The interface only shows a "password saved" state.

## 11. Private keys

LucidSSH stores the path to the original private key but never copies the key into its own directory.

Mandatory rules:

- the key is only ever read in the main process;
- key contents are never passed to the renderer;
- key contents are never saved to SQLite or logs;
- no temporary unencrypted copies of the key are created;
- the passphrase is stored in Credential Manager;
- before use, verify a regular file of an acceptable size was selected;
- read errors must never expose the key's contents.

If PPK conversion is performed, an unencrypted temporary key must never be left behind. In-memory conversion via a vetted library is preferred. If that's not possible, the scenario needs its own separate design and review.

## 12. SSH config and PuTTY import

Imported files and registry entries are treated as untrusted data.

In version 1.0, only the following may be imported from `.ssh/config`:

- `Host`;
- `HostName`;
- `User`;
- `Port`;
- `IdentityFile`;
- `ProxyJump`, after separate, safe handling.

Automatically executing the following is forbidden:

- `ProxyCommand`;
- `LocalCommand`;
- `Match exec`;
- `KnownHostsCommand`;
- arbitrary external commands and scripts.

Unsupported directives are shown to the user but never run.

## 13. Untrusted terminal output

SSH encrypts the channel, but that doesn't make the server itself trusted. The server controls the data that flows into xterm.js.

Protection is required against:

- control/escape sequences;
- OSC 52, which can write data to the clipboard;
- malicious or disguised links;
- infinite or excessively large output;
- attempts to change the window title;
- HTML or JavaScript injection via terminal text.

Mandatory rules:

- never insert terminal output via `innerHTML`;
- disable OSC 52 by default;
- never open links automatically;
- show the address and require confirmation before opening a URL;
- only allow explicitly supported protocols, e.g. `https:` and `http:`;
- block `file:`, `javascript:`, `data:`, and launching programs;
- cap scrollback and the amount of buffered data;
- never let excessive output block the renderer.

## 14. Clipboard and multi-line paste

When pasting text from the clipboard:

- a single line is inserted into the input line but is checked by the guard before being sent;
- multiple lines always show a preview dialog first;
- dangerous lines found are highlighted;
- the user must explicitly confirm the paste;
- a paste must never automatically simulate Enter without confirmation;
- the app must never copy passwords or passphrases to the clipboard.

## 15. Dangerous command guard

The guard runs in the main process before a command is sent over SSH.

Commands from every source are checked:

- manual input;
- clipboard;
- history;
- command catalog;
- breadcrumb;
- snippets.

Patterns are kept separately in `src/main/guard/patterns.ts` and are covered by tests.

An "OK" button is not enough to confirm a dangerous command. The user types the name of the affected object or other contextual text. The result is saved to history as "blocked" or "confirmed."

The guard is not a sandbox and can't recognize every equivalent way to perform a destructive action. This limitation must be explicitly reflected in the documentation and the interface.

## 16. Command history

History can accidentally contain tokens and passwords, e.g.:

```bash
export API_KEY=secret
curl -H "Authorization: Bearer secret" example.com
mysql --password=secret
```

Requirements:

- detect common ways secrets are passed;
- mask the secret's value before writing it;
- allow skipping the save for an individual command;
- allow disabling history globally or per host;
- never save terminal output by default;
- allow deleting an individual entry and clearing history;
- never expose a masked secret via search or export;
- restrict access to the SQLite file to the current Windows user.

Automatically deleting old entries once a limit is hit does not replace manual cleanup and secret masking.

## 17. Logs and diagnostics

Production logs must never contain:

- passwords and passphrases;
- private-key contents;
- secrets from commands;
- full terminal output;
- clipboard contents;
- raw IPC objects;
- Credential Manager data.

Internal IDs and safe error categories are used instead of secret values.

Safe:

```text
SSH authentication failed: hostId=42, method=publickey
```

Unsafe:

```text
Authentication failed: host=server.example password=qwerty123
```

Debug logging of sensitive data must never be enabled in a production build.

## 18. Local files and SQLite

LucidSSH's storage:

| Data | Storage |
|---|---|
| Hosts and groups | SQLite |
| History | SQLite |
| Passwords and passphrases | Windows Credential Manager |
| Known hosts | A local file in OpenSSH format |
| Settings | JSON, no secrets |

Requirements:

- files are created with access restricted to the current user, as far as Windows supports it;
- SQL queries are parameterized;
- values are never combined into SQL via string concatenation;
- input data has length limits;
- a corrupted database must never lead to code execution;
- backups and exports must never silently include secrets.

Full SQLite encryption doesn't protect against malware running as the user, and it doesn't replace properly storing secrets.

## 19. Shell integration, breadcrumb, and dashboard

Shell integration and the dashboard send commands to the server, so their strings must be static and controlled by the app.

Forbidden:

- interpolating a host name, path, or other untrusted text into a shell command without safe escaping;
- executing text the server sends as a control message without a strict format;
- mixing shell-integration control markers with regular output without validation.

The dashboard uses a separate SSH exec channel and a predefined set of commands. Metric values are parsed as data and never executed.

### 19.1 Shell support

The breadcrumb/history marker (`__lucidssh_mark`) is re-attached before every prompt: a `precmd` hook for zsh, embedded in `PS1` for the rest (POSIX-compatible — re-expanded on every prompt display).

Confirmed on real servers (2026-07-09):
- **bash** — works (`PS1`).
- **zsh** — works (`precmd` hook).
- **ash / BusyBox** (including on routers — Keenetic and similar) — works via `PS1` as of 2026-07-09; before that, `PROMPT_COMMAND` (bash-specific) never fired on ash at all — the marker arrived once on connect, and the breadcrumb/history silently stopped updating.

Untested and likely won't work without dedicated work: **fish**, **csh/tcsh** — non-POSIX syntax, `PS1`/`PROMPT_COMMAND`/`precmd` don't work this way there. Degradation is expected to be silent (the SSH session and terminal itself work fine, the breadcrumb/history/error detector just never activate) — this hasn't been verified on a real server, it's an assumption based on the architecture. If support is needed, a separate branch in the setup script, similar to the zsh branch.

## 20. Updates and signing

An update must pass several checks:

- downloaded only over HTTPS from a predetermined domain;
- package integrity is verified against the checksum published in the GitHub Release (UPD-03);
- a corrupted package, or one whose checksum doesn't match, is rejected;
- protection against installing an older, vulnerable version;
- an atomic install with safe recovery on failure.

**Version 1.0 ships unsigned** (see `Release_and_Update_Strategy.md` §9). So in 1.0 the following do not apply:

- the installer package carries a digital signature;
- the expected publisher is verified;
- an unsigned package is rejected.

These three checks return together with signing in a future version.

HTTPS protects the download in transit; the checksum protects against a corrupted file. Only a digital signature confirms the file's origin: the checksum is published in the same GitHub Release as the package itself, so it does not protect against a replaced release. 1.0 does not have this protection — it is a residual risk of shipping unsigned.

The update check is a separately allowed network connection. So the "no external traffic" requirement should be phrased as: the app only ever creates SSH connections, an explicitly initiated update check against a specified domain, and any other separately documented connections.

## 21. Dependencies and build

Supply-chain requirements:

- keep the dependency lockfile in the repository;
- use a reproducible dependency install;
- regularly check for known vulnerabilities;
- keep Electron, `ssh2`, xterm.js, and native modules up to date;
- minimize the number of dependencies;
- never load executable code at runtime;
- keep the signing certificate and its password outside the repository — **N/A for 1.0, unsigned release (see §20)**, a principle for the future;
- never publish secrets in CI logs or artifacts;
- sign production builds and the installer — **N/A for 1.0, unsigned release (see §20)**, a principle for the future.

## 22. External links

Any link from the terminal, the error database, the command catalog, or the interface is treated as untrusted until verified.

Before opening one:

1. Parse the URL with a standard parser.
2. Verify the protocol is allowed.
3. Show the user the real address.
4. Open it in the system browser only after a valid user action.

Opening links inside a privileged Electron window is forbidden.

## 23. Automatic reports and telemetry

Version 1.0 has none of:

- telemetry;
- automatic crash-report submission;
- usage analytics;
- sending commands or terminal output;
- cloud sync.

Even anonymized data submission is never added without a separate decision, a description of what data would be included, and explicit user consent.

## 24. Minimum security checks

Before shipping, verify:

- no password appears in SQLite, JSON, logs, or crash data;
- private keys are never copied into the app directory;
- a changed fingerprint blocks the connection;
- authentication never starts before the host key is verified;
- the renderer has no access to Node.js or the filesystem;
- IPC has no generic channels and validates its arguments;
- secrets are never returned to the renderer;
- OSC 52 is disabled by default;
- dangerous URL schemes are blocked;
- multi-line paste requires confirmation;
- commands with common tokens are masked in history;
- `ProxyCommand`, `LocalCommand`, and `Match exec` are never executed on import;
- a tampered update is rejected;
- the production build is signed — **N/A for 1.0, unsigned release (see §20)**; instead: the SHA-256 checksum is published in the GitHub Release;
- dependencies have been checked for critical known vulnerabilities.

## 25. Rule for Claude when writing code

When implementing any module, Claude must:

1. Identify what untrusted data flows into the module.
2. Determine whether the module handles secrets.
3. Perform privileged operations only in the main process.
4. Add a narrow, typed IPC contract if renderer access is needed.
5. Validate data in the main process independently of UI checks.
6. Never write secrets to logs or errors.
7. Add negative tests: wrong types, overly long strings, unknown IDs, and disallowed values.
8. Check whether the change expands the app's network access without a documented decision.
9. Never weaken existing Electron settings for development convenience.
10. Clearly state when a requirement can't be met safely within the chosen architecture.

## 26. The core principle

LucidSSH uses defense in depth:

1. SSH encrypts the connection.
2. The fingerprint confirms the server.
3. Credential Manager protects passwords.
4. The main process isolates secrets and system operations.
5. IPC only allows specific actions.
6. The renderer has no direct access to Windows or Node.js.
7. Terminal output is treated as untrusted.
8. History is scrubbed of likely secrets.
9. The guard reduces the risk of user error.
10. Signing protects updates.
11. Dependency auditing closes known vulnerabilities.

One layer failing must never automatically grant access to all the others.
