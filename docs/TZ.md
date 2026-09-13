# LucidSSH for Windows — Specification (public version)

| Field | Value |
|---|---|
| Product | LucidSSH for Windows |
| Status | Draft — under review |
| Stack | Electron + TypeScript |
| Platform | Windows 10 / 11 (x64) |
| Account and cloud | Fully local, no account |

> This is the public version of the specification — a showcase of implemented requirements for audit and feedback. The full version (change history, open questions, the 1.1+/1.2 roadmap, unimplemented requirements awaiting a scope decision) is kept in the project's internal documentation and is not published.

---

# 1. Introduction

## 1.1 Purpose of this document

This document defines the functional and non-functional requirements for LucidSSH for Windows — a desktop SSH client for Windows aimed at beginners, but usable by experienced users too. It's the basis for design, development, and acceptance testing.

## 1.2 Product context

Existing SSH clients fall into two groups: minimalist tools with no explanations (PuTTY, OpenSSH) and professional all-in-ones with excessive features and subscriptions (Termius, MobaXterm). A beginner connecting to a VPS or home server ends up with no guidance: they don't understand connection errors, don't know what a command does, and risk irreversibly damaging the server.

LucidSSH fills that gap: a full-featured SSH client with active protection against destructive actions and built-in learning hints — no subscription, no account, no cloud.

## 1.3 Target user groups

| Group | Description | Key needs |
|---|---|---|
| Beginner | First connection to a VPS, NAS, or Raspberry Pi. Doesn't know SSH terminology. | Understandable errors, protection from dangerous commands, explanation of what's happening |
| Home lab | Several servers, occasional use, not a sysadmin. | A convenient host manager, history, server dashboard |
| Developer | Several SSH connections in daily work, used to the terminal. | Fast connections, tabs, snippets, stay out of the way |
| PuTTY migrant | Used to PuTTY, wants tabs and a modern UI. | PuTTY session import, familiar reliability |

---

# 2. Version 1.0 scope

## 2.1 In scope for version 1.0

- SSH terminal with tabs and a host manager
- Dangerous command guard
- Error detector (exit code + stderr → a clear explanation, from a built-in database, no LLM)
- "Where am I" breadcrumb — current path in a bar above the terminal
- Command catalog with hints (sidebar)
- Command history with notes, secret masking, and snippets/favorites
- Mini server dashboard (CPU / RAM / disk / uptime)
- Basic SSH key management (local)
- PuTTY and ~/.ssh/config session import
- Host export and import (JSON, no secrets)
- Auto-update of the installed version (HTTPS, with SHA-256 integrity verification)
- Settings page with sections: Terminal, Connection, Security, Interface, Hotkeys
- Notifications: Windows system toasts + an event icon in the header
- First-run screen (onboarding)
- Terminal buffer search (Ctrl+F)
- SSH-level connection log
- Window size and position persistence
- Fully local operation, no account

---

# 3. Functional requirements

Priority markers: **Must** — required for the 1.0 release, **Should** — important, implemented if resources allow, **Could** — nice to have.

> Only requirements implemented in the current version (✅) are listed here. Requirements still in progress or awaiting a release-scope decision are tracked in internal documentation.

## 3.1 SSH connection

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ SSH-01 | The app establishes an SSH-2 connection with password or private-key authentication. | Must | — | Successful connection to a test server with a password and with a key. |
| ✅ SSH-02 | Supports OpenSSH key formats (Ed25519, ECDSA, RSA) and PEM. PPK → OpenSSH conversion is built in. | Must | SSH-01 | Successful connection with keys of every format. |
| ✅ SSH-03 | On first connection to a host, the server fingerprint (SHA-256) is shown with an explanation and explicit confirmation is required. The fingerprint is saved to the local known_hosts. | Must | SSH-01 | Fingerprint is shown; the connection isn't established without confirmation. |
| ✅ SSH-04 | When an existing host's fingerprint changes, a warning is shown explaining the possible causes (server update vs. an attack) and the available actions. The default "Continue" button is not available. | Must | SSH-03 | A fingerprint change blocks the connection until the user decides. |
| ✅ SSH-05 | Jump host (ProxyJump) and a custom port are supported. Settings are imported from ~/.ssh/config. | Should | SSH-01 | Connecting through a jump host from an imported config. |
| ✅ SSH-06 | The session automatically sends keepalive packets at a configurable interval (30s by default). Auto-reconnect on drop can be toggled in Settings → Terminal (enabled by default). | Should | SSH-01 | The session doesn't hang after 5 minutes of no input; with autoreconnect disabled, a drop doesn't trigger an automatic reconnect. |
| ✅ SSH-07 | Host key verification happens **before** a password or private-key signature is sent. | Must | SSH-03 | Authentication doesn't start before the host key is confirmed. Checked on every path that opens an SSH connection: a session, Quick Connect (HM-11), the trial connection from the host form ("Test connection"), and both hops of a jump-host chain (SSH-05). |
| ✅ SSH-08 | The first-connection dialog (SSH-03) has an expandable hint, "I can't find it," explaining what to do if the hosting provider doesn't show a fingerprint, and noting that LucidSSH will still protect against server spoofing on later connections. The hint links to "Learn more →", pointing to the "How to verify a server fingerprint" section of the help window (HELP-04, "Getting started" tab). | Should | SSH-03, HELP-04 | The hint expands/collapses on click without reloading the dialog; "Learn more →" opens the right help section. |

## 3.2 Host manager

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ HM-01 | The user creates, edits, and deletes saved hosts. Each host has: name, address, port, username, auth method, group, and a note (optional text field, up to 200 characters, not part of the host name and doesn't affect dedup on import EXP-02). | Must | — | A host is created, appears in the list, and connects on click. If filled in, the note shows as a tooltip on hover in the manager tree and in the connection confirmation dialog. |
| ✅ HM-02 | Hosts are organized into groups. Groups collapse and expand. | Must | HM-01 | Groups render as a tree; state persists across launches. |
| ✅ HM-03 | Import sessions from the PuTTY registry (HKCU\Software\SimonTatham\PuTTY\Sessions). | Must | HM-01 | After import, all PuTTY sessions show up as hosts. |
| ✅ HM-04 | Import hosts from ~/.ssh/config (HostName, User, Port, IdentityFile, ProxyJump). ProxyCommand, LocalCommand, Match exec, KnownHostsCommand directives are **not executed** — shown as unsupported instead. | Must | HM-01 | All safe entries are imported; executable directives aren't run. |
| ✅ HM-05 | Real-time search by host name, address, and group. | Should | HM-01 | Partial-match search returns correct results. |
| ✅ HM-06 | Passwords and passphrases are stored in Windows Credential Manager. Private keys stay local and never leave the device. | Must | HM-01 | No password is stored in plaintext in any app file. |
| ✅ HM-10 | Import sessions from WinSCP's configuration (`WinSCP.ini` or the `HKCU\Software\Martin Prikryl\WinSCP 2\Sessions` registry key). Address, port, username, and private-key path (if set) are imported. Passwords stored encrypted by WinSCP are not imported — the user is prompted to re-enter them. | Should | HM-01 | After import, WinSCP sessions show up as hosts; no attempt is made to decrypt a WinSCP password. |
| ✅ HM-11 | A dedicated "Quick Connect" command/field is available: typing a string like `user@host[:port]` (via a hotkey or a button in the host manager) establishes an SSH connection immediately, without going through the host-creation dialog and without writing to the `hosts` table. After a successful or unsuccessful (for diagnostics) connection, a "Save as host?" prompt appears — accepting opens a pre-filled host-creation dialog. Entry points: a button in the server panel header; a hotkey; a text link on the no-active-session screen; recognizing a `user@host[:port]`-shaped string in the host manager's search field — on a match, a "Connect" item is shown first, with found hosts listed below it. | Should | SSH-01, HM-01 | Typing `user@192.0.2.10` establishes a connection without first creating a host; after connecting, saving as a host is offered. Each of the four entry points opens quick connect; a string without @ in the search field behaves like a normal search. |
| ✅ HM-12 | In the host-creation dialog, when the "key" auth method is selected and no suitable key exists, a "Create a new key" button is available. It opens a wizard: (1) generates an Ed25519 key pair with the system `ssh-keygen.exe` (consistent with SEC-04 — no custom cryptography) and saves it to `~/.ssh/id_ed25519_<slug>` (slug — the host name, or the address/username); (2) explains the passphrase in plain language, with the option to leave it empty; it's stored via keytar like any other key; (3) shows the public key with a copy button; (4) an "add the key to the server" step — after the first password connection to the same host, the public key is automatically appended to `~/.ssh/authorized_keys` over the exec channel (an equivalent of `ssh-copy-id`, which Windows doesn't ship with), creating `~/.ssh`/`authorized_keys` with 700/600 permissions if needed, with no duplicates on repeated runs. The "Create a new key" button is only visible when there's no file at the given path on this PC — the host import preview (EXP-02/03) uses the same check to hint that "a new key will be needed" when moving to another PC. | Should | SEC-04, SSH-01 | The wizard creates a key pair via `ssh-keygen.exe`; the public key is correctly added to the target server's `authorized_keys` after a password connection. |

## 3.3 Terminal

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ TERM-01 | Terminal built on xterm.js with xterm-256color emulation. | Must | SSH-01 | Correct rendering of color, unicode, vim, htop. |
| ✅ TERM-02 | Multiple concurrent SSH sessions in tabs. Rename via double-click. Right-click a tab → "Duplicate" opens a new session to the same host. | Must | SSH-01 | 5 tabs open, switching without losing the session; "Duplicate" opens a new session to the same host. |
| ✅ TERM-03 | Tabs show a status indicator: connected (green), reconnecting (yellow), disconnected (gray). | Must | TERM-02 | The indicator changes on a network drop without a restart. |
| ✅ TERM-04 | Terminal settings are configurable under Settings → Terminal without an app restart: font (from a monospace list), font size, color scheme (dark only in 1.0), opacity, bell (sound/flash/off), bright colors for bold text (xterm bright), select-to-copy (selection → clipboard), right-click-to-paste. | Should | TERM-01 | All settings apply without a restart; a font change is reflected in the active session immediately. |
| ✅ TERM-05 | Pasting multi-line text shows a preview dialog requiring confirmation; dangerous lines are highlighted in it. Pasting never simulates Enter without confirmation. | Must | TERM-01 | Pasting 3 lines shows a confirmation dialog before execution. |
| ✅ TERM-06 | On a connection drop — a clear message with the cause and "Reconnect" / "Close" buttons. | Must | SSH-01 | A network disconnect shows the message; reconnecting restores the session. |
| ✅ TERM-07 | Untrusted server output is neutralized: OSC 52 (clipboard write) is disabled by default; output isn't inserted via innerHTML; scrollback and buffer size are capped; links aren't opened automatically. | Must | TERM-01 | OSC 52 doesn't write to the clipboard; a large output stream doesn't block the UI. |
| ✅ TERM-08 | A ping indicator (ms) in the mini dashboard under the breadcrumb (replacing uptime there — more useful for a quick daily glance) and in the "Server dashboard" modal. Computed from the exec-channel open time of the already-running dashboard poll (DASH-02) — no extra server requests are added. Updates together with the rest of the dashboard metrics (every 10s). Shows "—" with no error when the server is unavailable (DASH-05). | Should | DASH-01, DASH-02 | The mini panel shows live ping instead of uptime; on a connection drop it shows "—" with no error; uptime remains available in the full "Server dashboard" modal (DASH-06). |
| ✅ TERM-09 | When a password prompt is detected in the output stream (a static list of patterns in code: `[sudo] password for`, `Password:`, `Enter passphrase`, plus Russian variants `Пароль:`/`пароль для`), a HintBar hint appears above the input line: "Hidden input — that's normal. Type the password and press Enter." Detection is limited to known patterns; arbitrary prompts aren't recognized. Follows the general hint-display rule (SET-05: shown at most 3 times, disabled in expert mode). Text typed in hidden mode is never intercepted, logged, or written to history (SEC-01, HIST-07). | Should | TERM-01, SET-05 | The first 3 sudo password prompts show the hint, the fourth doesn't; expert mode disables it; the password text never appears in history or logs. |
| ✅ TERM-10 | The terminal itself is the only command-input surface (there's no separate input field). While the session is "at the prompt" (signaled by the shell-integration marker BRD-04), typed text is buffered locally with local echo and is only sent to the server as a whole on Enter, after passing through the guard (GUARD-02/04); local history via ↑/↓ is supported within the session (no tab-completion/reverse-search). When the session isn't at the prompt (an interactive program is running — vim/htop/less, etc.), input goes through character-by-character and raw, unbuffered. Hosts where a working marker has never been confirmed (no marker arrived within 4s after the first command sent) fail safe: the guard keeps checking blindly (buffering stays on), the GUARD-08 indicator and NOTIF-03 notification are shown; the timeout isn't re-armed for the same session — "no marker while a long-running program is up" doesn't count as broken. | Must | GUARD-02, GUARD-04, BRD-04 | A regular command runs on Enter without a dialog; a dangerous one is intercepted; `htop`/`vim` launched from the terminal respond to every key (including function keys) right up until exit, with no false guard triggers along the way. |

## 3.4 Dangerous command guard

> **Note:** a key competitive advantage. The guard is a warning mechanism for **recognized** dangerous commands, not a guarantee against every destructive action. This limitation is reflected in the UI and documentation.

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ GUARD-01 | A built-in list of dangerous patterns (rm -rf, dd, mkfs, chmod -R 777, truncate, >/dev/sda, etc.) in a dedicated file `src/main/guard/patterns.ts`, covered by tests. Updated together with the app. | Must | — | Every command in the control list is intercepted. |
| ✅ GUARD-02 | When a dangerous command is typed and Enter is pressed, the app intercepts it **in the main process before it's sent to the server** and shows a dialog with: (a) an explanation of what will happen, (b) the scope of the consequences, (c) a confirmation field (typing the object's name or the word CONFIRM). | Must | GUARD-01 | `rm -rf /var/www` doesn't run without a confirmation being typed. |
| ✅ GUARD-03 | The warning names the specific affected target with the real path from the command, not a generic phrase. | Must | GUARD-02 | The warning text contains the real path from the command. |
| ✅ GUARD-04 | The guard checks commands from every source: manual input, clipboard, history, command catalog, breadcrumb, snippets. | Must | GUARD-01 | A dangerous command from history and from the catalog is intercepted the same way. |
| ✅ GUARD-05 | An experienced user can disable the guard for a specific host or globally. | Must | GUARD-01 | After disabling, commands run without the dialog. |
| ✅ GUARD-06 | Every intercepted command is logged to history with a "blocked" or "confirmed" marker. | Should | GUARD-01 | History contains entries with the correct status. |
| ✅ GUARD-07 | The guard recognizes commands that can lead to losing SSH access: **write** commands on `/etc/ssh/sshd_config` (editors, `sed -i`, `>`/`>>`/`tee`; plain viewing — `cat`/`grep`/`less` — doesn't trigger), restarting/stopping/disabling `sshd` via `systemctl`/`service`, **modifying** `ufw`/`iptables`/`firewalld` subcommands (viewing ones — `status`/`-L`/`--list-all` — don't trigger), any `passwd` invocation, and deleting or changing permissions on `~/.ssh`. Instead of the standard type-to-confirm, a separate warning type is shown — a two-button modal ("Run anyway" / "Cancel", no input field): "This action may break the SSH connection," plus a recommendation to open a second tab with a new connection and verify it before closing the current session. If the command also matches a regular destructive guard pattern (e.g. `rm -rf ~/.ssh`), only the regular type-to-confirm modal is shown — this category isn't checked. Disabled together with the guard (GUARD-05); there's no separate toggle. For SSH config changes, running `sshd -t` before restarting the service is additionally recommended. The wording never claims the action "will definitely cut off access" — it's a warning, per the principle in §5.1. | Should | GUARD-01, GUARD-02 | `sudo systemctl restart sshd` shows the access-loss warning and the second-tab recommendation instead of the regular object-confirmation modal. |
| ✅ GUARD-08 | A persistent guard-status indicator next to the active session's breadcrumb (a shield icon, reusing the `success`/`danger`/`warning` colors from the shared palette): green (`shield-check`) — enabled, red (`shield-x`) — disabled (globally or for this host), orange (`shield-alert`) — shell state undetermined (fail-safe keeps checking blindly, see TERM-10). Clicking the green/red icon opens the guard settings (Settings → Security when disabled globally, the host form when disabled per host); the orange icon isn't clickable — there's nothing to open, details are given in the notification (NOTIF-03). | Should | GUARD-05 | On a host with the guard disabled globally, the icon is red and clicking it opens Settings → Security; on a host with working integration, it's green; on integration failure, it's orange and not clickable. |

## 3.5 Error detector

> **Note:** a built-in error database with no LLM — works offline.

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ ERR-01 | Exit code and stderr are tracked after every command. The detector activates when exit code ≠ 0 — with three narrow exceptions where a non-zero code is a normal or intentional result rather than a failure: (1) a compound command (`&&`/`\|\|`) with an explicit `2>/dev/null` on a segment and an empty final stderr; (2) `systemctl status`/`service status` exiting with 1/2/3 (LSB "not running" — code 4, "status unknown," still triggers); (3) declining an interactive `[Y/n]` confirmation (the output ends with the prompt plus a negative answer, with at most one short line after it). The exceptions apply only when the database's regular patterns (ERR-02/04/05) didn't match — they never override recognition of real errors. | Must | TERM-01 | A failing command triggers the detector, a successful one doesn't; the three exceptions above don't open the panel, every other non-zero code does. |
| ✅ ERR-02 | A built-in database of stderr patterns (JSON): regular expression, explanation, list of checks. | Must | ERR-01 | All patterns from the control list are recognized. |
| ✅ ERR-03 | The explanation shows in a panel that slides up from the bottom of the terminal. The panel never covers the input, closes via Esc or ×. | Must | ERR-02 | The panel appears and closes without covering the input. |
| ✅ ERR-04 | The database covers at minimum: permission denied, no such file or directory, command not found, connection refused, disk full, out of memory, segmentation fault, syntax error. | Must | ERR-02 | All listed errors are recognized with a correct explanation. |
| ✅ ERR-05 | SSH connection errors (Connection refused, Permission denied publickey, Host key verification failed, etc.) get dedicated explanations with troubleshooting steps. | Must | ERR-02 | Every SSH error from the §5 table gets a clear explanation. |
| ✅ ERR-06 | For unrecognized errors — a generic template with the stderr, possible causes, and a link to search the documentation. If stderr is empty with exit code ≠ 0, the text "The command exited with code N with no error message" is shown, suggesting rerunning with `-v` or checking the service logs. | Should | ERR-02 | An empty stderr with exit code ≠ 0 doesn't leave a blank panel; a meaningful message is shown. |
| ✅ ERR-07 | For a `command not found` error, the detector additionally looks up the closest command name in the command database (Levenshtein distance ≤ 2; up to 3 candidates when tied at the minimum distance, each clickable). On a match, the panel shows "Perhaps you meant: `ls`?" — clicking replaces only the command name in the original line (arguments are kept, `sl -la` → `ls -la`) and inserts it into the input line (through the guard, like CAT-04). With no match — the standard explanation, with no suggestion. The word "perhaps" is required — the suggestion is a guess, not a fact (the honesty principle, §5.1). | Should | ERR-04, CAT-03 | `sl` shows the suggestion `ls`, and clicking inserts it into the input line; `qwzx` shows the standard explanation with no suggestion. |
| ✅ ERR-08 | The error detector panel has a "Copy for a question" button: it builds a single markdown block (in triple backticks) — command, exit code, stderr, LucidSSH version — for pasting into a forum, a help chat, or a message to an administrator. The "server distribution" field is omitted in 1.0 (OS auto-detection isn't implemented). Before copying, the block goes through the same secret masking as command history (HIST-07). | Should | ERR-03, HIST-02, HIST-07 | The copied block contains the command, exit code, and stderr in readable form; the value from `export API_KEY=secret` is masked in the block. |

## 3.6 "Where am I" breadcrumb

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ BRD-01 | Always shown above the terminal: `[user]@[host] > [path]`. Updates after every cd. | Must | TERM-01 | After `cd /var/log`, the bar shows the correct path. |
| ✅ BRD-02 | Every path segment is clickable — clicking inserts the full path up to that segment into the input line. | Must | BRD-01 | Clicking `/var` inserts `/var` into the input line. |
| ✅ BRD-03 | A privilege indicator: regular user (no marker) / sudo (warning color) / root (red marker). | Should | BRD-01 | `sudo su` shows the red root marker. |
| ✅ BRD-04 | Path detection via shell integration (PROMPT_COMMAND / precmd). Control strings are static and escaped; untrusted text is never interpolated into a shell command unescaped. After privilege escalation/a nested shell (su, sudo -i, bash), the setup automatically re-runs in the new shell process. | Must | BRD-01 | The breadcrumb works on a clean Ubuntu/Debian/CentOS with no packages installed; keeps working after `sudo -i`/`su`/a nested `bash`. |
| ✅ BRD-05 | When a sent command matches the list of known interactive programs (`nano`, `vim`, `less`, `man`, `htop`, `top`) — including with a `sudo` prefix or inside a `&&`/`;` chain — a static status line appears above the breadcrumb: "[program] is open now." The line uses the existing shell-integration mechanism (BRD-04): the status is shown from the moment such a command is sent and hidden automatically on the next prompt return. Detection is limited to the list of known programs; recognizing an arbitrary foreground process or parsing its output (e.g. Y/n prompts) is out of scope for this requirement. | Should | BRD-04 | `htop` shows the status indicator; quitting htop (`q`) hides it automatically when the prompt returns. |
| ✅ BRD-06 | The status line (BRD-05) also shows the relevant hotkeys for the recognized program (e.g. for `nano`: "Ctrl+O — save · Ctrl+X — exit"; for `less`/`man`: "q — quit"). Each program's hotkey list is static, from a fixed table in code. The hint follows the general display rule (SET-05: at most 3 times for the same program — a separate counter per program — then hidden; disabled in expert mode). | Should | BRD-05, SET-05 | The first 3 launches of `nano` show the hotkey line; the fourth doesn't. Expert mode disables it entirely. |
| ✅ BRD-07 | On entering a sudo/root session (detected via the same mechanism as BRD-03), a one-time tooltip/toast appears: "You've entered a root session. Commands now run with full privileges." Follows the general hint-display rule (SET-05: shown at most 3 times, then hidden; expert mode disables it). Nested SSH sessions and detecting a user switch without sudo/su are out of scope for this requirement — they can't be detected reliably in 1.0, and showing them with a reliability caveat would contradict the interface-honesty principle (§5.1). | Should | BRD-03, SET-05 | The first 3 transitions into root show the explanatory toast; later ones don't; expert mode disables it. |

## 3.7 Command catalog

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ CAT-01 | The sidebar opens via a button/hotkey (Ctrl+Shift+L), hides without losing the session. | Must | TERM-01 | The panel opens and closes; the session isn't interrupted. |
| ✅ CAT-02 | Commands are grouped by category: Files, Processes, Network, System, Text. | Must | CAT-01 | All categories are present, commands are distributed among them. |
| ✅ CAT-03 | Each command: name, a one-line explanation, a list of common flags with explanations. | Must | CAT-02 | The explanation for ls, rm, chmod, ps, netstat is correct. |
| ✅ CAT-04 | Clicking a flag inserts the command with that flag into the input line (goes through the guard). | Must | CAT-03 | Clicking "-la" inserts `ls -la` into the input line. |
| ✅ CAT-05 | Search by command name and keyword ("delete" finds `rm`). | Should | CAT-02 | Searching "delete" returns `rm` and `rmdir`. |

## 3.8 Command history

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ HIST-01 | Every command is saved locally (SQLite): command, host, user, start and end time, exit code. | Must | TERM-01 | After 10 commands, all are present with correct data. |
| ✅ HIST-02 | The user can add a text note to any entry. | Must | HIST-01 | The note is saved and shown on the next open. |
| ✅ HIST-03 | History opens as a panel (Ctrl+H) with search by command, host, and note. | Must | HIST-01 | Search returns correct results across all three fields. |
| ✅ HIST-04 | Clicking an entry inserts the command into the active terminal's input line. | Must | HIST-01 | A command from history is inserted unchanged. |
| ✅ HIST-05 | Dangerous commands intercepted by the guard are shown with a "blocked" / "confirmed by user" status. | Should | GUARD-06, HIST-01 | History shows the correct status for blocked commands. |
| ✅ HIST-06 | History keeps at least 10,000 entries; old ones are removed once the limit is reached (FIFO). | Should | HIST-01 | At 10,001 entries, the oldest is automatically removed. |
| ✅ HIST-07 | Before an entry is written to history, common secrets are detected and masked: `export KEY=...`, `--password=...`, `-p<password>`, `Authorization: Bearer ...` headers, `mysql --password=`, and similar. A masked value is never exposed via search or export. The user can skip saving an individual command and disable history globally or per host. Terminal output is not saved by default. | Must | HIST-01 | The command `export API_KEY=secret` is saved with the value masked; the secret isn't visible in search or export; the host form has a "Record command history" toggle, and once it's turned off, commands from that host no longer reach history. |
| ✅ HIST-08 | In the History panel (Ctrl+H), the user can clear a single host's history via the filter chip without touching other hosts' entries. With a host filter active (including "This session" and the orphaned host of a deleted server — the chip is built from the history entries, not from live hosts), the "Clear" button at the bottom of the drawer removes only that `host_id`'s entries; the confirmation shows that host's exact entry count (independent of the search text). With the "All" filter, the button behaves as before. Quick Connect entries (HM-11) aren't a host: all such sessions share `host_id=0`, and the servers behind it can't be told apart. They're grouped under a separate "Quick Connect" chip; clearing it removes the history of every Quick Connect session, and the dialog says so plainly instead of calling it a host's history. The "This session" chip isn't shown in a Quick Connect session. | Should | HIST-01, HIST-06 | With a filter on host A (3 entries) and host B (2 entries), "Clear" removes only host A's 3 entries; the dialog shows "3," not the total; after deletion, the filter resets to "All". Entries from two Quick Connect sessions to different servers appear under one "Quick Connect" chip, not under a server name; the clear dialog for it describes removing all Quick Connect history. |

## 3.9 Mini server dashboard

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ DASH-01 | A compact panel under the breadcrumb: CPU %, RAM (used/total), disk on /, ping (TERM-08). | Must | SSH-01 | The panel shows correct values on a test server. |
| ✅ DASH-02 | Data refreshes every 10s over a separate SSH exec channel with a fixed set of commands; metrics are parsed as data and never executed. | Must | DASH-01 | Refreshing doesn't produce artifacts in the terminal. |
| ✅ DASH-03 | Warning/danger thresholds: CPU and disk — orange ≥80%, red ≥90%; RAM — orange ≥85%, red ≥90% (fraction of memory in use). | Should | DASH-01 | Color changes correctly for all three metrics under simulated load. |
| ✅ DASH-04 | The panel hides/shows with one click; state persists across launches. | Should | DASH-01 | Panel state is restored after a restart. |
| ✅ DASH-05 | If the server is unreachable or the exec channel fails, the dashboard shows "—" with no error. | Must | DASH-01 | Force-closing the exec channel doesn't produce a UI error. |
| ✅ DASH-06 | Clicking the mini dashboard opens a "Server dashboard" modal (680px) with CPU/RAM/Disk plus: uptime, load average (1/5/15 min), network ↑/↓ (KB/s or MB/s), ping (TERM-08), top 5 processes by CPU (PID/USER/COMMAND/CPU%/MEM%). | Should | DASH-01 | The modal opens on click and shows all listed metrics on a test server. |
| ✅ DASH-07 | Network and load are collected over the same exec channel and at the same polling interval as CPU (no increase in poll frequency or SSH channel count). | Must | DASH-02, DASH-06 | The polling interval stays at 10s with the modal open. |
| ✅ DASH-08 | Server unavailability in the modal — same "—" and banner with no error (DASH-05), including an empty process list. | Must | DASH-05, DASH-06 | Force-closing the exec channel doesn't produce an error in the modal. |
| ✅ DASH-09 | After a connection is established and the first dashboard poll succeeds, if any metric exceeds its "red" threshold (DASH-03) or `/var/run/reboot-required` exists on the server, a one-time (per session) non-blocking banner is shown: "Disk is 93% full" / "The server needs a reboot after installing updates." With several problems at once — one banner listing all of them, not a series of separate ones. With healthy metrics, no banner is shown at all. The reboot-required check runs once on connect over the same dashboard exec channel — neither the SSH channel count nor the polling frequency increases (DASH-07). | Should | DASH-02, DASH-03, DASH-07 | On a server with disk > 90%, the banner appears once after connecting and doesn't repeat in the same session; on a healthy server, no banner appears. |
| ✅ DASH-10 | Each finding in the DASH-09 banner can be muted with a "Don't show again" button — persistently, per host and finding type (stored with the host in `hosts.db`), surviving reconnects. A mute resets itself as soon as the finding stops occurring (disk cleaned up / server rebooted) — if it recurs, the banner shows again; there's no separate UI for removing a mute manually. Quick Connect sessions (no saved host) don't show the mute button — there's no host to attach the mute to. | Should | DASH-09 | A muted finding isn't shown on reconnect while the problem persists; once resolved and then recurring, it's shown again; a Quick Connect session has no "Don't show again" button. |

## 3.10 Application settings

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ SET-01 | Settings open as a separate page (not a modal) via Ctrl+, or the menu. Sections: Terminal, Connection, Security, Interface, Hotkeys, **About**. | Must | — | The page opens, all sections are present; the "About" section is present and shows the version, signature status (NFR-06), and a link to the guide (HELP-01). |
| ✅ SET-02 | **Terminal** section: font, size, bell, bright bold, select-to-copy, right-click-to-paste, autoreconnect, emulation type (xterm-256color only in 1.0, selector locked). | Should | TERM-04 | All options are saved and applied without a restart. |
| ✅ SET-03 | **Connection** section: keepalive interval (sec.), connection timeout (sec.), autoreconnect (global). | Should | SSH-06 | Changing the keepalive interval applies to new sessions. |
| ✅ SET-04 | **Security** section: enable/disable the guard globally with an explanation of what that means; enable/disable history globally; manage known_hosts (view, delete entries). | Must | GUARD-05, HIST-07 | Disabling the guard removes the warnings; disabling history stops logging. |
| ✅ SET-05 | **Interface** section — granular toggles for "beginner" features (not a single switch): (a) command catalog hints, (b) output tooltips, (c) error detector panel, (d) learning hints in the connection dialog. An "Expert mode" button as a quick all-off, with the ability to re-enable individually. | Must | CAT-06, ERR-03 | Each toggle only affects its own hint group; "Expert mode" turns them all off at once. |
| ✅ SET-06 | **Hotkeys** section — a reference page listing all of the app's hotkeys (view-only in 1.0). Search by action. | Should | — | Every documented hotkey is shown; search works. |
| ✅ SET-07 | Settings are saved to `config.json` immediately on change (no "Save" button). | Must | SET-01 | Settings are restored after closing and reopening the app. |
| ✅ SET-08 | A "Reset settings to factory defaults" button at the bottom of the page, with a warning that it won't affect hosts, keys, or history. | Could | SET-01 | After a reset, `config.json` contains only defaults; hosts and history aren't deleted. |
| ✅ SET-09 | The **About** section contains: version number; a "Report a bug" link (opens GitHub Issues with the bug-report template in the system browser); a "Suggest a feature" link (opens GitHub Issues with the feature-request template); a "Changelog" link (opens the current repository's GitHub Releases page). All external links open through the existing hardened mechanism (SEC-08). | Should | SEC-08, HELP-01, NFR-06 | Clicking each of the three links opens the corresponding GitHub page in the system browser, not inside the app. |
| ✅ SET-10 | The **Hotkeys** section (SET-06) becomes editable for 9 of the 11 hotkeys — all except `Esc` (the universal "close," tied to several independent panels) and `F1` (opens help), which stay non-editable. Assigning a combination that's already taken is blocked, with a hint naming the action that currently owns it. The `Ctrl+L` default changes from "open the command catalog" to "clear the terminal" (the common terminal convention); the command catalog gets a new default hotkey. | Should | SET-06, SET-07 | Each of the 9 hotkeys can be reassigned and is saved to `config.json` immediately (SET-07); `Esc`/`F1` show no editing control; entering a taken combination shows which action owns it and isn't saved; a fresh `config.json` gives `Ctrl+L` = "clear the terminal". |

## 3.11 Notifications

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ NOTIF-01 | On an SSH connection loss, the app shows a Windows system notification with the host name and a "Reconnect" button, if the window is minimized or not in focus. | Must | TERM-06 | With the window minimized and a connection drop, a system toast appears. |
| ✅ NOTIF-02 | When a long-running command finishes (exit code ≠ 0 or runtime > 30s), a system notification appears if the window isn't focused. The threshold is configurable (0 = off). | Should | TERM-01 | A command taking > 30s triggers a toast with the window minimized. |
| ✅ NOTIF-03 | An event icon with a numeric badge in the app header for: (a) a host fingerprint change (needs action, red badge), (b) an available update, (c) an undetermined guard state on a host (GUARD-08/TERM-10, fail-safe) — the badge stays blue for (b) and (c) (neither outranks (a), and the badge doesn't get a third color), while event (c) gets its own marker in the expanded list (an orange dot). Clicking it expands a compact event list linking to the source. | Should | SSH-04, UPD-01, TERM-10 | A fingerprint change, an available update, and an undetermined guard state all appear in the event list; the badge is only red for a fingerprint event. |
| ✅ NOTIF-04 | System notifications can be turned off globally under Settings → Interface. | Should | NOTIF-01 | Toasts stop appearing after disabling; the header event icon remains. |

## 3.12 First run (Onboarding)

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ OB-01 | On first launch (no hosts, no history), a welcome screen with three actions is shown instead of an empty list: "Create your first connection," "Import from PuTTY" (likewise from MobaXterm and WinSCP if detected) (shown only when sessions are found in the registry), "Open the guide." | Must | HM-01 | A hostless first launch shows the welcome screen, not an empty list. |
| ✅ OB-02 | The welcome screen contains a one-to-two-line explanation of what SSH is and what the app is for — no technical jargon. | Must | OB-01 | The text is understandable to someone who's never heard the word "SSH." |
| ✅ OB-03 | After the first host is created, the welcome screen no longer appears. There's no separate "first run completed" flag: the signal is the presence of at least one host. The consequence is intentional — a user who deletes all hosts sees the welcome screen again rather than an empty list: that's exactly the situation OB-01 exists for. | Must | OB-01 | Relaunching after the first host is created opens the normal interface; deleting all hosts brings back the welcome screen. |

## 3.13 Snippets / favorites

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ SNIP-01 | A command can be saved as a snippet from a history row via a bookmark button (a `bookmark` icon with a `+` badge, 24×24px) on the right side of the row. Clicking opens SnippetSaveDialog with the command field pre-filled. | Must | HIST-01 | Clicking the bookmark opens the dialog; the command is pre-filled; the saved snippet appears in the "Commands" panel. |
| ✅ SNIP-02 | The currently typed command can be saved as a snippet from the terminal via a context menu or button (without sending it to the server). A snippet has a name, a command, and an optional description. | Must | TERM-01 | The snippet is saved without running the command. |
| ✅ SNIP-03 | Favorite snippets are available in a dedicated tab of the history panel (Ctrl+H) and via search by name and description. | Must | SNIP-01, SNIP-02 | Searching by snippet name returns correct results. |
| ✅ SNIP-04 | Clicking a snippet inserts the command into the input line (goes through the guard). A snippet can be edited and deleted. | Must | SNIP-03 | The snippet is inserted; a dangerous snippet is intercepted by the guard. |
| ✅ SNIP-05 | When saving a snippet, the user picks a scope: **This server** (tied to the current connection's `host_id`) or **Global** (available in sessions with any host). Default: "This server." The scope is shown as a chip next to the snippet name. | Must | SNIP-02 | A snippet scoped "This server" doesn't appear in sessions with other hosts. |
| ✅ SNIP-06 | In the snippets panel, when a session with a specific host is open, that host's server-scoped snippets appear first, above the global ones. With no active session, only global ones are shown. | Should | SNIP-05 | Opening a session with host A and pressing Ctrl+H shows host A's snippets above the global ones. |
| ✅ SNIP-07 | When deleting a host that has server-scoped snippets attached, the app offers a choice: "Delete the snippets along with the host" or "Convert to global." Silently deleting snippets with no warning is not allowed. | Should | SNIP-05, HM-01 | Deleting a host with server-scoped snippets shows the dialog; the chosen action is applied correctly. |
| ✅ SNIP-08 | After the 5th command in a session, a one-time HintBar appears: "Using this command often? Save it — click 🔖 in history or right-click in the terminal." Shown at most twice total; not shown in "Expert mode." | Should | HIST-01, CTX-01 | The HintBar appears on the 5th command; it doesn't appear after 2 shows; it's absent in expert mode. |
| ✅ SNIP-09 | A hotkey (`Ctrl+Space` by default) opens a floating panel near the cursor listing snippets: current host's snippets first (ordered as in SNIP-06/SNIP-10), global ones below. The list filters as you type. Enter or a click inserts the selected snippet into the terminal (goes through the guard like a normal paste). Esc closes the panel without inserting. `Ctrl+Space` is intercepted before xterm.js, so the shell's `set-mark` binding on that combination doesn't reach a session inside LucidSSH. | Should | SNIP-05, SNIP-06, GUARD-02 | Pressing the hotkey opens the panel next to the caret; typing filters the list; Enter inserts the snippet into the terminal; a dangerous snippet is still intercepted by the guard. The snippet order in the palette matches the SNIP-10 manual sort (or the active preset), not the order they were added. |
| ✅ SNIP-10 | Snippets in the `[host]`/"Global" tabs of the command catalog (`Ctrl+Shift+L`) are manually reordered by the user via drag-and-drop; the new order is saved immediately. Order is tracked separately for each host's server-scoped snippets and for the global ones. Two quick-sort presets are also available via a toggle above the list: "Alphabetical" and "Date added" (switching to a preset doesn't discard the manual order). | Should | SNIP-01, SNIP-06 | Dragging a snippet in the list preserves the new order after an app restart; server-scoped and global lists sort independently; switching to "Alphabetical" and back to "Manual" restores the original manual order. |
| ✅ SNIP-11 | When saving a snippet (creating or editing), the app checks whether the exact same command is already saved in the same scope (server or global — checked separately), and shows a warning naming the existing snippet. The warning doesn't block saving — the user decides. | Should | SNIP-01, SNIP-05 | Saving the same command again in the same scope shows a warning naming the existing snippet; the "Save" button stays enabled; the same command in a different scope (server vs. global) doesn't trigger a warning. |

## 3.14 Window state and closing

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ WIN-01 | Window size, position, and state (normal/maximized) are saved to `config.json` on every change and restored on the next launch. | Must | — | After a restart, the window opens at the same position and size. |
| ✅ WIN-02 | Attempting to close the app with one or more active SSH sessions shows a confirmation dialog: "N connections are active. Close and disconnect all?" with "Close" and "Cancel" buttons. | Must | SSH-01 | The window doesn't close with an active session without confirmation. |
| ✅ WIN-03 | Closing an individual tab with an active session shows a similar dialog for that tab. | Must | TERM-02 | The tab doesn't close with an active session without confirmation. |
| ✅ WIN-04 | If a command is running in a session when a tab or the window is closed (WIN-02/WIN-03) — per shell integration, the prompt hasn't returned since the command was sent — the existing confirmation dialog additionally contains the line "A command is running — closing will interrupt it" and a link that opens the `tmux` card in the command catalog. When closing a window with several tabs, the extension is shown if at least one active session is running a command. "A command is running" is a heuristic; the wording is a warning, per the principle in §5.1. No new dialog is created — the existing one's content is extended. | Should | WIN-02, BRD-04, CAT-03 | Closing a tab during `sleep 60` shows the extended warning with the link; closing with the prompt returned shows the regular WIN-02 dialog. |

## 3.15 Terminal context menu

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ CTX-01 | Right-clicking the terminal area shows a context menu with: "Copy" (enabled when text is selected), "Paste," "Save as snippet," "Find in terminal" (Ctrl+F). | Must | TERM-01 | All items work; "Copy" is disabled without a selection. |
| ✅ CTX-02 | With select-to-copy enabled (TERM-04), selecting text automatically copies it to the clipboard; the context menu still works. | Should | CTX-01, TERM-04 | With select-to-copy on, a selection copies without a click; right-click still works. |
| ✅ CTX-03 | Right-clicking a tab: "Rename," "Duplicate," "Close." | Must | TERM-02 | All three actions work correctly. |

## 3.16 Terminal buffer search

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ FIND-01 | Ctrl+F opens a search bar over the terminal (without blocking input). Search runs against the scrollback buffer via xterm.js's SearchAddon. Matches are highlighted; navigate with Enter / Shift+Enter. Closes via Esc. | Must | TERM-01 | Searching for a word from earlier output finds and highlights all matches. |
| ✅ FIND-02 | Search supports "case-sensitive" and "regular expression" options (toggle icons in the search bar). | Should | FIND-01 | A regex search for `err[or]+` finds the correct matches. |

## 3.17 Connection log

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ CLOG-01 | Each tab has a "Connection details" button that expands an SSH-level log: address and port, auth method used, negotiated algorithms (kex, cipher, mac), handshake time, server fingerprint. | Should | SSH-01 | The log shows correct data for the current connection. |
| ✅ CLOG-02 | On a failed connection attempt, the log states the failure reason at every step — up to the one where it failed. | Must | SSH-01 | A failure at the auth step is reflected in the log with a clear description. |
| ✅ CLOG-03 | The log never contains passwords, passphrases, or key contents. | Must | CLOG-01 | Auditing the log finds no secrets. |
| ✅ CLOG-04 | A terminal tab is created immediately on a connection attempt; until the session is ready, it shows a live stepper of stages instead of the terminal: DNS → port → SSH handshake → fingerprint → authentication → shell start (DNS and "port" are technically one `tcp` stage — ssh2 provides no separate DNS event, so both switch to done together). Each stage is marked visually as it progresses (in progress / success / error). It uses the same data the connection log already collects (an ssh2 event at every stage) — no new data-collection mechanism, only visualization. At the fingerprint stage, the existing SSH-03/SSH-04 modal appears over the stepper with no change to its logic. Works the same for saved hosts and Quick Connect (HM-11); not shown on auto-reconnect (SSH-06) — only on the initial connection. On an error, the stepper stops at the failing stage and expands the corresponding explanation (ERR-05 for SSH errors). | Should | CLOG-01, CLOG-02, SSH-01 | A failed connection attempt (e.g. an unreachable port) visually stops the stepper at the "Port" stage without advancing further. |

## 3.18 Host export and import

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ EXP-01 | The host manager has an "Export hosts" button — saves all hosts and groups to a JSON file. Passwords, passphrases, and key contents are **never exported** — only the key file path is. | Must | HM-01 | The exported file contains no secrets; verified by a content audit. |
| ✅ EXP-02 | The "Import hosts" button accepts JSON in the same format. Import doesn't overwrite existing hosts with a matching address and username — it offers to skip or rename. | Must | HM-01 | Re-importing the same file doesn't create duplicates without an explicit choice. |
| ✅ EXP-03 | Before importing, a preview shows: how many hosts will be added, how many skipped, how many conflicts. | Should | EXP-02 | The preview correctly reflects the file's contents before "Import" is clicked. |
| ✅ EXP-04 | Imported JSON is validated against a schema; a malformed or unexpected file is rejected with a clear message. The file's contents are never executed. | Must | EXP-02 | An arbitrary JSON file doesn't crash the app or execute its contents. |

## 3.19 Help and feature discovery

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ HELP-01 | The "About" section of the settings page has a "Guide" button that opens the full guide (HELP-03). The "About" section is described separately under SET-09. | Must | SET-01 | The button is visible; the guide opens. |
| ✅ HELP-02 | Pressing `F1` anywhere in the app opens the full guide (HELP-03). `F1` is fixed (it can't be reassigned, SET-10) and is always captured by the app before the terminal — it never reaches the SSH session; as a side effect, F1 inside programs on the server (e.g. mc's help) isn't available. | Should | — | F1 opens the guide, including while the terminal has focus; F1 inside vim/mc never reaches the terminal. |
| ✅ HELP-03 | The full guide is a modal window over the main app window (not a separate `BrowserWindow`). It opens via F1 (HELP-02), the "Guide" button in settings (HELP-01), the "Help" button in the title bar, and the "Detailed guide" link at the bottom of FeatureGuide. FeatureGuide — a short card-based feature overview — opens from the welcome screen (OB-01). SSH sessions keep running underneath the guide. | Must | — | Each of the four entry points opens the guide; closing it leaves the active session uninterrupted. |
| ✅ HELP-04 | The help window has 5 tabs: **Getting started**, **Snippets**, **Guard**, **Error detector**, **Hotkeys**. Tabs switch without reloading the window. Each tab's content is static HTML, requiring no network connection. | Must | HELP-03 | All 5 tabs are present and show correct content offline. |
| ✅ HELP-05 | The "Snippets" tab explains: how to save a command (★ in history / terminal context menu), and the difference between a global and a server-scoped snippet. | Must | SNIP-05, HELP-04 | The tab describes both modes. |
| ✅ HELP-06 | The "Hotkeys" tab contains a table of all the app's keyboard shortcuts. | Should | HELP-04 | The table contains at least 10 current shortcuts. |

---

# 4. Security requirements

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ SEC-01 | Passwords and passphrases are stored exclusively in Windows Credential Manager. Storing them in configs, SQLite, logs, crash reports, renderer state, or IPC messages is forbidden. | Must | — | A code audit finds no passwords in configs or the database. |
| ✅ SEC-02 | Private keys are never copied into the app directory; the original path is used. No unencrypted temporary copies are created. | Must | — | The app data directory contains no .pem or .key files. |
| ✅ SEC-03 | The fingerprint is verified on every connection; on a change, the connection is blocked until the user decides. "Connection" here means every established SSH connection, not every tab (see "Connection" in `docs/agent/CONTEXT.md`). | Must | SSH-03, SSH-04 | A fingerprint change blocks the connection. The fingerprint is also verified in the trial connection from the host form ("Test connection"), including the jump-host hop: an unknown or changed key raises the SSH-03/04 modal before any secret is sent. |
| ✅ SEC-04 | Uses the system OpenSSH or the ssh2 library. Custom cryptography is not allowed. | Must | — | No hand-rolled cryptography among the dependencies. |
| ✅ SEC-05 | Every BrowserWindow: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a minimal preload. IPC only via contextBridge, no general-purpose channels; every argument is validated in the main process. | Must | — | The Electron configuration code has the correct flags; the renderer has no access to Node.js or the filesystem. |
| SEC-06 | Auto-update verifies the package's digital signature and expected publisher before installing. Verification happens in the main process. *(Not applicable to version 1.0 — the installer is unsigned, see NFR-06.)* | Must | UPD-03 | A tampered package, or one signed by a different publisher, is rejected. |
| ✅ SEC-07 | The app never sends host data, SSH session data, commands, terminal output, keys, or credentials to external services. In 1.0, only the following are allowed: (a) SSH connections to servers the user specifies, and (b) HTTPS requests to the configured update source (GitHub Releases). The update request contains only the technical data inherent to HTTPS plus what's needed to identify the version. There's no telemetry or analytics. | Must | — | The app's network traffic contains only SSH to the specified servers and HTTPS to the update source; no other outbound connections. |
| ✅ SEC-08 | External links (from the terminal, error database, catalog, UI) are treated as untrusted: the URL is parsed, the protocol is checked (http/https only), the real address is shown, and it opens in the system browser only after a user action. The file:, javascript:, and data: schemes are blocked. | Must | — | Dangerous URL schemes never open; an https link opens after confirmation. |

---

# 5. UX and interface requirements

## 5.1 Interface principles

- **Don't get in an experienced user's way.** Every learning hint appears at most 3 times, then hides. A global "Expert mode" switch turns off all hints.
- **Local-first.** Anything that can work without the internet does work without the internet. The only external connections: SSH to the user's servers and HTTPS to the update source.
- **Understandable errors.** No SSH error or command error goes without an explanation.
- **Visual context.** The user can always see: which server they're connected to, who they are, where they are, and whether the server is healthy.
- **Interface honesty.** Protective mechanisms never promise an absolute guarantee. The guard is described as a warning for recognized dangerous commands.
- **Honesty about uncertainty.** If the app can't determine the cause, consequence, or context with full confidence, it explicitly shows its confidence level instead of presenting a guess as fact.

## 5.2 Required UI components

| Component | Description |
|---|---|
| First-run screen | A welcome screen with three actions; disappears after the first connection. |
| Host manager (left panel) | A tree of groups and hosts, search, a new-connection button, export/import. |
| Tabs | A horizontal row at the top, a status indicator, a context menu (rename / duplicate / close). |
| Breadcrumb | A `user@host > path` bar with clickable elements. |
| Terminal | xterm.js, full color, full size, a right-click context menu. |
| Buffer search bar | Opens with Ctrl+F over the terminal, doesn't block input. |
| Server dashboard | A compact CPU / RAM / disk / uptime bar under the breadcrumb. |
| Error detector panel | Slides up from the bottom on an error, never covers the input. |
| Command catalog (right panel) | Opens via a button/hotkey, has categories and search. |
| History and snippets panel | Opens via Ctrl+H, "History" and "Favorites" tabs, search. |
| Connection log | Expands via a button on the tab, SSH details of the current connection. |
| Settings page | Sections: Terminal, Connection, Security, Interface, Hotkeys. |
| Event icon (header) | A badge for fingerprint changes and updates; expands into a list. |

## 5.3 Connection dialog for beginners

The new-host dialog has a hint for every field:

- **Address:** "The server's IP address or domain name, e.g. 192.168.1.1 or myserver.com"
- **Username:** "The account name on the server. `ubuntu` for Ubuntu, `root` for Debian, `ec2-user` for AWS"
- **Key:** "The private key file (usually id_rsa or id_ed25519). The public key must already be added to the server"
- **Passphrase:** "The password protecting the key, if you set one when creating it. Don't confuse this with the server's password"

---

# 6. Non-functional requirements

| ID | Requirement | Priority | Dependency | Acceptance criteria |
|---|---|---|---|---|
| ✅ NFR-01 | Cold-start time ≤ 3s on a machine with 8 GB RAM and an SSD. | Must | — | Measured startup time < 3s on a test machine. |
| ✅ NFR-02 | Idle RAM usage (1 tab) ≤ 200 MB. | Should | — | The profiler shows < 200 MB idle. |
| ✅ NFR-03 | The terminal handles ≥ 50,000 lines/sec with no visible lag. | Must | — | `yes | head -50000` doesn't hang the UI. |
| ✅ NFR-04 | Supports Windows 10 (1903+) and Windows 11 (x64). | Must | — | Successful launch and core scenarios on both OSes. |
| ✅ NFR-06 | The installer is not signed by a trusted certificate. On first download (the GitHub Release description), the Windows "Unknown publisher" warning is explained to the user, along with what it means (no signature, not that the file is dangerous); this is intentionally NOT repeated in the first-launch window, since SmartScreen fires BEFORE launch. Instead, Settings → About has a calm informational line with the same substance and a link to the release page. Package integrity is verified via the published SHA-256 checksum. Every release is submitted to Microsoft Security Intelligence for scanning (best-effort, no guarantees). | Must | UPD-03 | The release description explains the SmartScreen warning and includes the SHA-256 checksum. Settings → About has an informational line with the same substance. Downloaded-package integrity is verified against the checksum. |
| ✅ NFR-07 | UI language: Russian. All error messages, hints, and UI strings are in Russian. | Must | — | No interface string is in English without a translation. |

---

# 7. Data storage

| Data type | Storage | Format | Notes |
|---|---|---|---|
| Hosts and groups | %APPDATA%\LucidSSH\hosts.db | SQLite | No passwords stored; only a reference `LucidSSH/{hostId}` |
| Passwords and passphrases | Windows Credential Manager | System | Key: `LucidSSH/{hostId}` |
| Command history | %APPDATA%\LucidSSH\history.db | SQLite | 10,000-entry limit; secrets masked (HIST-07) |
| Known hosts | %APPDATA%\LucidSSH\known_hosts | OpenSSH format | — |
| App settings | %APPDATA%\LucidSSH\config.json | JSON | No secrets |
| Error database | Bundled with the app package | JSON | Updated together with the app |
| Command database (catalog) | Bundled with the app package | JSON | Updated together with the app |

Files are created with access restricted to the current Windows user. SQL queries are parameterized; string concatenation in SQL is forbidden.

---

# 8. Technical stack

| Component | Technology | Rationale |
|---|---|---|
| Framework | Electron 30+ (Node.js 20+) | Cross-platform, mature ecosystem, TypeScript out of the box |
| Language | TypeScript (strict mode) | Type safety, IDE support |
| Terminal | xterm.js | De facto standard, actively maintained |
| SSH | ssh2 (npm) | Mature Node.js SSH library, every key format |
| UI framework | React + Tailwind CSS | Component-based, convenient styling |
| Database | better-sqlite3 | Synchronous SQLite for the main process, no dependencies |
| Secret storage | keytar (npm) | Wrapper around Windows Credential Manager |
| Build | electron-builder | NSIS installer (x64) |
| Updates | electron-updater | Auto-update with SHA-256 checksum verification |

---

# 9. Update and signing requirements

> The full strategy is in `Release_and_Update_Strategy.md`. This section lists the requirements with acceptance criteria.

| ID | Requirement | Priority | Acceptance criteria |
|---|---|---|---|
| ✅ UPD-01 | The app checks GitHub Releases on launch and on manual request, without blocking the UI or SSH. | Must | On a new stable version, its number and changes are shown; without internet, the app keeps working with no intrusive error. |
| ✅ UPD-02 | Downloading and restarting only happen after a clear user action. | Must | The app never closes an active SSH session without confirmation. |
| ✅ UPD-03 | Before installing, package integrity is verified by comparing SHA-256 against the checksum published in the GitHub Release. | Must | A corrupted package, or one whose checksum doesn't match, is rejected and not installed. |
| ✅ UPD-04 | An update never deletes user data or secrets. A local backup is created before any irreversible database migration. | Must | After updating from a previous version, prior hosts, history, settings, and Credential Manager entries are still available. |
| ✅ UPD-05 | Every version has a unique number, a Git tag, and a GitHub Release; all update files come from the same build. | Must | An installed previous version detects the release and updates. |
| ✅ UPD-06 | Previous stable versions are kept on GitHub Releases. | Should | The user can manually download a previous installer, unless the release was pulled for security reasons. |
| ✅ SIGN-01 | The stable installer and update package are signed with a trusted, timestamped Code Signing Certificate. *(Not applicable to version 1.0 — the release ships without a signing certificate.)* | — | Windows file properties show a valid signature and the expected publisher. |
| ✅ SIGN-02 | The certificate's private key is never stored in the repository or the source code. *(Not applicable to version 1.0 — the release has no certificate.)* | — | Auditing the repository and release files finds no certificate with a private key, password, or access token. |

---

*— end of the public version of this document —*
