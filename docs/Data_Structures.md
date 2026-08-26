# LucidSSH for Windows — Data Structures Specification

| Field | Value |
|---|---|
| Document version | 1.2 |
| Date | August 26, 2026 |
| Purpose | DB schemas, built-in database formats, IPC contracts, and settings format for Claude Code |
| Base documents | `TZ.md`, `Security_Guide.md` |

> Everything related to data storage and exchange is described here so the implementation stays consistent. The TypeScript types are the target shape; specific column names can be adapted, but the semantics and security constraints are mandatory. Secrets are never stored in SQLite/JSON and are never passed to the renderer — this is a cross-cutting rule (SEC-01, guide §10).

---

## 1. Storage overview

| Data | Storage | File | Secrets |
|---|---|---|---|
| Hosts and groups | SQLite | `%APPDATA%\LucidSSH\hosts.db` | No — only a reference `LucidSSH/{hostId}` |
| Command history | SQLite | `%APPDATA%\LucidSSH\history.db` | No — secrets are masked (HIST-07) |
| Passwords and passphrases | Windows Credential Manager | system | Yes — via keytar |
| Known hosts | File | `%APPDATA%\LucidSSH\known_hosts` | No |
| Settings | JSON | `%APPDATA%\LucidSSH\config.json` | No |
| Error database | Bundled with the package | `assets/errors.core.json` + `assets/locales/{lang}/errors.json` | No |
| Command catalog | Bundled with the package | `assets/commands.core.json` + `assets/locales/{lang}/commands.json` | No |

Files are created with access restricted to the current Windows user (as far as the OS supports it). All SQL queries are parameterized; concatenating values into SQL is forbidden. History and hosts live in **separate** database files, so disabling/clearing history never touches hosts.

---

## 2. SQLite — hosts.db

### 2.1 The `groups` table

```sql
CREATE TABLE groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  collapsed   INTEGER NOT NULL DEFAULT 0,   -- 0/1, tree state (HM-02)
  created_at  TEXT    NOT NULL              -- ISO 8601
);
```

### 2.2 The `hosts` table

```sql
CREATE TABLE hosts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,            -- display name
  address       TEXT    NOT NULL,            -- IP or domain
  port          INTEGER NOT NULL DEFAULT 22,
  username      TEXT    NOT NULL,
  auth_method   TEXT    NOT NULL,            -- 'password' | 'key'
  key_path      TEXT,                        -- path to the ORIGINAL key file, not a copy (SEC-02)
  group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  proxy_jump_host_id INTEGER REFERENCES hosts(id) ON DELETE SET NULL, -- jump host, a reference to another saved host (SSH-05)
  note          TEXT,
  guard_enabled INTEGER NOT NULL DEFAULT 1,  -- per-host guard disable (GUARD-05)
  history_enabled INTEGER NOT NULL DEFAULT 1, -- per-host command history (HIST-07)
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
  -- IMPORTANT: no password, passphrase, or key contents live here.
  -- The secret is in Credential Manager under the key LucidSSH/{id}.
);
```

`history_enabled` is a Setting (the window writes it), positive polarity like `guard_enabled`.
Before document version 1.2 it lived in `config.json` as `history.perHostDisabled: number[]`
(negative, no UI) — moved to a column for `ON DELETE CASCADE` cleanup on host deletion.
Rationale: `docs/agent/adr/0015-host-scoped-state-lives-with-the-host.md`.

### 2.3 The `host_dismissed_alerts` table

```sql
CREATE TABLE host_dismissed_alerts (
  host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  issue   TEXT    NOT NULL,            -- 'cpu' | 'ram' | 'disk' | 'rebootRequired' (DASH-10)
  PRIMARY KEY (host_id, issue)
);
```

Dismissed health-banner findings (DASH-10) — "Don't show again" on a host. Deliberately not
a column on `hosts`: this is app state, not a Setting — the renderer never touches it.
Before document version 1.2 it lived in `config.json` as `dashboard.dismissedAlerts`
(never itself listed in this doc's `AppConfig` block in §6 — a pre-existing gap that
predates this migration); moving it here also gave it garbage collection for deleted hosts,
which it never had before. Rationale: `docs/agent/adr/0015-host-scoped-state-lives-with-the-host.md`.

Quick Connect has no saved host row, so its mute can't persist here — the "Don't show again"
button is hidden in its banner instead.

### 2.4 TypeScript types

```ts
type AuthMethod = 'password' | 'key';

interface HostGroup {
  id: number;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  createdAt: string;
}

interface Host {
  id: number;
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string;        // path to the original
  groupId?: number;
  proxyJumpHostId?: number;
  note?: string;
  guardEnabled: boolean;
  historyEnabled: boolean; // HIST-07 — command history for this host
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// The create/edit form. The secret is passed SEPARATELY and goes straight
// into the keychain — it's never stored on the host object or returned to the renderer.
interface HostInput {
  name: string;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  keyPath?: string;
  groupId?: number;
  proxyJumpHostId?: number;
  note?: string;
  guardEnabled: boolean;
  historyEnabled: boolean;
}
```

### 2.5 Relation to Credential Manager

```ts
// keychain/ — the only place that touches secrets
const CRED_SERVICE = 'LucidSSH';
// account = String(hostId); the password OR the key's passphrase
keytar.setPassword(CRED_SERVICE, String(hostId), secret);
keytar.getPassword(CRED_SERVICE, String(hostId)); // main only, never in an IPC response
keytar.deletePassword(CRED_SERVICE, String(hostId)); // on host deletion, after confirmation
```

The password UI never fills in the actual value — it only shows a "password saved" state (guide §10).

---

## 3. SQLite — history.db

### 3.1 The `history` table

```sql
CREATE TABLE history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  command     TEXT    NOT NULL,             -- ALREADY masked (HIST-07)
  host_id     INTEGER,                       -- can be NULL if the host was deleted
  host_name   TEXT    NOT NULL,             -- denormalized: stays readable after the host is deleted
  username    TEXT    NOT NULL,
  started_at  TEXT    NOT NULL,             -- ISO 8601
  finished_at TEXT,
  exit_code   INTEGER,                       -- NULL until it finishes
  guard_status TEXT,                         -- NULL | 'blocked' | 'confirmed' (HIST-05)
  has_secret  INTEGER NOT NULL DEFAULT 0,   -- 1 if a value in the command was masked
  is_favorite INTEGER NOT NULL DEFAULT 0,   -- reserved for "favorites": nothing writes it besides the
                                            -- DEFAULT, no UI; only read by the FIFO deletion exclusion (§3.4)
  note        TEXT,
  output      TEXT,                         -- command output, masked and truncated (§3.4); NULL = not saved
  output_truncated INTEGER NOT NULL DEFAULT 0 -- 1 if output was cut by the limit (§3.4)
);

CREATE INDEX idx_history_command ON history(command);
CREATE INDEX idx_history_host    ON history(host_id);
CREATE INDEX idx_history_time    ON history(started_at);
```

### 3.2 TypeScript type

```ts
type GuardStatus = 'blocked' | 'confirmed';

interface HistoryEntry {
  id: number;
  command: string;          // masked
  hostId?: number;
  hostName: string;
  username: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  guardStatus?: GuardStatus;
  hasSecret: boolean;
  note?: string;
  output?: string;          // masked and truncated (§3.4); undefined = not saved
  outputTruncated?: boolean;
}

/** Recording a new command (main masks it and fills in metadata, HIST-07). */
interface HistoryRecordInput {
  command: string;          // raw — masked in main
  hostId?: number;
  hostName: string;
  username: string;
  exitCode?: number;
  guardStatus?: GuardStatus;
  output?: string;          // raw command output — masked/truncated in main
}
```

### 3.3 Masking rules (HIST-07)

Masking happens in main **before** the write. A masked value is never restored anywhere and never surfaces in search/export. The minimum set of detected patterns:

```ts
// secrets/maskers.ts — patterns live in their own file and are covered by tests,
// mirroring guard/patterns.ts
const SECRET_PATTERNS: { re: RegExp; mask: (m: RegExpMatchArray) => string }[] = [
  // export KEY=value / KEY=value before a command
  { re: /\b([A-Z_][A-Z0-9_]*)=(\S+)/g, mask: m => `${m[1]}=••••••••` },
  // --password=value / --pass value
  { re: /(--password=|--pass(word)?[= ])(\S+)/gi, mask: m => `${m[1]}••••••••` },
  // -p<value> (mysql/curl style, no space)
  { re: /(\s-p)(\S+)/g, mask: m => `${m[1]}••••••••` },
  // Authorization: Bearer <token>
  { re: /(Authorization:\s*Bearer\s+)(\S+)/gi, mask: m => `${m[1]}••••••••` },
  // mysql --password=...  (covered by the general --password= rule above)
];
```

> This is not an exhaustive detector, just protection against common leaks. The list grows via tests against real-world examples from guide §15. The user can additionally skip saving an individual command or disable history (HIST-07).

### 3.4 FIFO limit

A 10,000-entry limit (HIST-06). Once exceeded, the oldest entry by `started_at` is removed, **except** entries marked as favorites (`is_favorite = 1` — the column is reserved: nothing writes it besides the default, and there's no UI to mark an entry favorite yet). Command output is saved when the caller provides it: masked with the same rules as the command (if the command itself already contained a secret, output isn't saved at all), and truncated at a 4000-character limit (`output_truncated = 1` when truncated).

---

## 4. SQLite — snippets (in history.db)

```sql
CREATE TABLE snippets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,             -- short snippet name
  command     TEXT    NOT NULL,             -- the command (secrets masked the same way as in history)
  description TEXT,                         -- optional description
  host_id     INTEGER,                      -- tied to a host (NULL = global, SNIP-05)
                                            -- on host deletion: set to NULL (converted to global)
                                            -- or the row is deleted — the user's choice (SNIP-07)
  danger      INTEGER NOT NULL DEFAULT 0,   -- 1 if the command matches a dangerous-command pattern
  sort_order  INTEGER NOT NULL DEFAULT 0,   -- manual order within its group (host_id or NULL); SNIP-10
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX idx_snippets_host ON snippets(host_id);
CREATE INDEX idx_snippets_danger ON snippets(danger);
```

> **sort_order (SNIP-10):** unique and sequential within a group (all rows sharing the same `host_id`, including NULL for globals); a newly inserted row gets `max(sort_order)+1` within its group.

```ts
interface Snippet {
  id: number;
  name: string;
  command: string;
  description?: string;
  hostId?: number;        // undefined / null = global; a number = server-scoped (SNIP-05)
  danger: boolean;        // true if the command matches a dangerous-command pattern (determined on save)
  sortOrder: number;      // manual order within its group (SNIP-10)
  createdAt: string;
  updatedAt: string;
}

// Used for display: globals + the current host's server-scoped snippets (SNIP-06)
type SnippetScope = 'global' | 'server';
```

> **Host deletion rule (SNIP-07):** when a host is deleted, the main process checks for snippets with `host_id = deletedHostId`. If any exist, it shows a dialog with two options: "Delete the snippets" (DELETE WHERE host_id = ?) or "Make global" (UPDATE SET host_id = NULL WHERE host_id = ?). Silently deleting or nulling them out without a dialog is forbidden.

---

## 4. Built-in database — errors.core.json + translation

The schema is multi-language (CLAUDE.md §5a): the technical part (`id`, `match`, `category`, `scope`, `checks[].command`) is shared, lives in `assets/errors.core.json`, and is never translated or duplicated per language. The human-readable text (`title`, `explanation`, `checks[].text`) lives in `assets/locales/{lang}/errors.json`, linked to the core by `id`. Loading and merging — `src/main/content/loader.ts` (`loadErrorPatterns`) and `src/main/content/merge.ts` (`mergeErrors`), covered by required tests (CLAUDE.md §10).

### 4.1 Core format (`errors.core.json`)

```json
{
  "version": "1.0.0",
  "patterns": [
    {
      "id": "permission-denied",
      "match": "(?i)permission denied",
      "category": "filesystem",
      "scope": "command",
      "checks": [
        { "command": "sudo {original}" },
        { "command": "ls -la {target}" },
        { "command": "whoami" }
      ]
    }
  ]
}
```

### 4.2 Translation format (`locales/{lang}/errors.json`)

An object keyed by the core pattern's `id`. `checks` is an array of strings the same length and in the same order as the core's `checks` (matched by index, not by key).

```json
{
  "permission-denied": {
    "title": "Permission denied",
    "explanation": "The current user doesn't have permission for this action. The file or directory belongs to another user (often root).",
    "checks": ["Run with sudo", "Check the owner and permissions", "Check who you are"]
  }
}
```

### 4.3 Merging (`mergeErrors`)

For each core pattern, the active language's translation is used; if the key is missing, it falls back to the fallback language's translation (`ru`, CLAUDE.md §5a); if missing there too, `title` falls back to the `id` itself, `explanation` to an empty string, and `checks[i].text` to an empty string (a partial translation shouldn't drop the entry, only impoverish it). `checks[i].command` always comes from the core — that substitution text is never translated.

### 4.4 TypeScript type (merged result)

```ts
type ErrorScope = 'command' | 'ssh-connection';

interface ErrorCheck {
  text: string;             // what to check, localized
  command?: string;         // a suggested command; {original}/{target} are substituted SAFELY
}

interface ErrorPattern {
  id: string;
  match: string;            // a regular expression (compiled on load)
  category: string;
  title: string;            // after merging with the translation
  explanation: string;      // after merging with the translation (NFR-07)
  checks: ErrorCheck[];
  scope: ErrorScope;
}
```

`loadErrorPatterns(lang)` returns `ErrorPattern[]` directly — there's no separate wrapper type with a `version` field for the merged result; `version` only exists on the core format (§4.1) and is checked against the app version (OQ-06, §9.4).

### 4.5 Required coverage (ERR-04, ERR-05)

permission denied, no such file or directory, command not found, connection refused, disk full, out of memory, segmentation fault, syntax error; SSH: Connection refused, Permission denied (publickey), Host key verification failed, Connection timed out.

### 4.6 Extension point for 1.2

The detector returns a result shaped like `{ matched: true, explanation: ErrorExplanation } | { matched: false, fallback: FallbackRef }` (`DetectResult`, `src/main/errors/detector.ts`). In 1.0, `fallback` leads to the generic template / documentation search (ERR-06). In 1.2, the same `fallback` will route to a local LLM (spec §12.13). The detector's contract doesn't need to change for that.

```ts
interface FallbackRef {
  kind: 'doc-search' | 'llm';   // always 'doc-search' in 1.0
  command: string;
  exitCode?: number;
  stderrExcerpt: string;        // a minimal excerpt, after secret masking
}
```

---

## 5. Built-in database — commands.core.json + translation

The same split as §4 (CLAUDE.md §5a): the technical fields (`name`, `category`, `dangerous`, `flags[].flag`) live in `assets/commands.core.json` and are never translated; `summary`, `keywords`, `flags[].desc`, and category labels live in `assets/locales/{lang}/commands.json`. Loading and merging — `loadCommandCatalog`/`mergeCommands` (the same files as in §4).

### 5.1 Core format (`commands.core.json`)

```json
{
  "version": "1.0.0",
  "categories": ["files", "processes", "network", "system", "text"],
  "commands": [
    {
      "name": "ls",
      "category": "files",
      "dangerous": false,
      "flags": [{ "flag": "-l" }, { "flag": "-la" }, { "flag": "-h" }, { "flag": "-R" }]
    }
  ]
}
```

### 5.2 Translation format (`locales/{lang}/commands.json`)

```json
{
  "categories": { "files": "Files", "processes": "Processes", "network": "Network", "system": "System", "text": "Text" },
  "commands": {
    "ls": {
      "summary": "List a directory's contents",
      "keywords": ["list", "files", "directory", "show"],
      "flags": {
        "-l": "Detailed listing with permissions and size",
        "-la": "Detailed, including hidden files",
        "-h": "Human-readable sizes",
        "-R": "Recurse into subdirectories"
      }
    }
  }
}
```

### 5.3 Merging (`mergeCommands`)

A category's label and a command's `summary`/`keywords`/`flags[].desc` come from the active language's translation; if the key is missing, from the fallback translation (`ru`); if missing there too, the category label falls back to its technical name, `summary` falls back to the command's `name`, and `keywords`/`desc` fall back to empty. The result is `CommandsDatabase.categoryLabels`, kept separate from `categories` (the list of technical names).

### 5.4 TypeScript type (merged result)

```ts
type CommandCategory = 'files' | 'processes' | 'network' | 'system' | 'text';

interface CommandFlag {
  flag: string;             // e.g. "-la"
  desc: string;             // localized explanation (NFR-07), after merging
}

interface CatalogCommand {
  name: string;
  category: CommandCategory;
  summary: string;          // a one-line explanation, after merging with the translation
  keywords: string[];       // for localized search: "delete" → rm (CAT-05)
  flags: CommandFlag[];
  dangerous: boolean;       // a UI hint; the guard makes the actual decision, not this field
}

interface CommandsDatabase {
  version: string;                        // from the core (§5.1)
  categories: CommandCategory[];          // technical names, from the core
  categoryLabels: Record<string, string>; // labels after merging with the translation (§5.3)
  commands: CatalogCommand[];
}
```

Clicking a flag builds the string and **sends it through the guard** (CAT-04 + GUARD-04), not straight to SSH.

---

## 6. config.json

Split by who initiates the write (ADR-0014): `Settings` is written by the window (both sides read it — this is the only part the renderer gets via `configGet`), `AppState` is written by main, the window never sees it. The format of the file on disk doesn't change — the file holds their intersection; the split is only the line drawn for what gets handed to the renderer. Mirrors `src/shared/config.ts` exactly. `HotkeyAction` (`shared/hotkeys.ts`) and `PendingKeyDeployment` (`shared/keygen.ts`) are types from neighboring modules, not redefined here; their IPC contract (SET-10, HM-12) is part of the future full rewrite of §7.

```ts
/** Written by the window, read by both sides. Handed to the renderer whole (`configGet`). */
interface Settings {
  ui: {
    expertMode: boolean;          // quick toggle to disable ALL hints (SET-05)
    // granular toggles (SET-05) — expertMode sets all of these to false
    hints: {
      commandCatalog: boolean;    // command catalog hints (CAT-06)
      outputTooltips: boolean;    // command output tooltips
      errorPanel: boolean;        // error detector panel (ERR-03)
      connectionDialog: boolean;  // learning hints in the connection dialog
    };
    theme: 'dark';                // dark only in 1.0
    notifications: {
      systemToasts: boolean;      // Windows system notifications (NOTIF-04)
      longCommandThresholdSec: number; // 0 = off (NOTIF-02)
    };
    dashboardVisible: boolean;    // DASH-04
    catalogPanelOpen: boolean;
    leftPanelWidth: number;       // 160..340
    rightPanelWidth: number;      // 200..480
  };
  terminal: {
    font: string;                 // TERM-04
    fontSize: number;
    opacity: number;              // 0..1
    bell: 'off' | 'sound' | 'visual'; // TERM-04
    brightBold: boolean;          // bright colors for bold text (TERM-04)
    selectToCopy: boolean;        // TERM-04
    rightClickPaste: boolean;     // TERM-04
  };
  connection: {
    autoreconnect: boolean;       // SSH-06, SET-03
    keepaliveIntervalSec: number;
    connectTimeoutSec: number;
  };
  guard: {
    globalEnabled: boolean;       // GUARD-05
  };
  /** SET-10: bindings for the 9 editable hotkeys. Esc/F1 aren't included —
   *  they're fixed (FIXED_HOTKEYS in shared/hotkeys.ts). */
  hotkeys: Record<HotkeyAction, string>;
  history: {
    enabled: boolean;             // HIST-07: global disable
    // Per-host disable is not here: hosts.history_enabled in hosts.db (§2.2),
    // moved out of this field in document version 1.2.
  };
  shownCounts: Record<string, number>; // hint id → how many times shown (cap 3, spec §5.1)
  updates: {
    autoCheck: boolean;           // OQ-09
  };
}

/** Written by main, the window never sees it — stripped out before handing to the renderer. */
interface AppState {
  version: string;
  /** UI language (CLAUDE.md §5a): default 'ru', fallback 'en'. Written only
   *  through the language-change channel — never through the regular settings-update path. */
  language: string;
  window: {
    x?: number;
    y?: number;
    width: number;
    height: number;
    maximized: boolean;           // WIN-01
  };
  /** HM-12: keys from the wizard still waiting to be deployed to the server — survives a restart. */
  pendingKeyDeployments: PendingKeyDeployment[];
  updates: {
    source: string;               // update source URL; can't go stale — nothing writes it at runtime
  };
}

/** The shape of the file on disk — unchanged by this split. */
type AppConfig = Settings & AppState;
```

The `onboarding: { completed: boolean }` field listed in earlier versions of this document has been removed from the code — the welcome screen is shown based on `hosts.length === 0`, there's no separate first-run flag (ADR-0014). config.json **contains no secrets** (SEC-01). `hints.shownCounts` implements the "shown at most 3 times" rule from spec §5.1.

---

## 7. IPC contract

> **This section is partially stale.** The `LucidSSHBridge` below is a snapshot of a much earlier version of the app — the real `src/preload/index.ts` has ≈80 methods (i18n, the HM-12 key-generation wizard, PuTTY/WinSCP/ssh-config import, window controls, auth prompts, and more) that aren't listed here; `explainError`/`FallbackRef` doesn't exist as an IPC method at all in the real code (an error explanation only ever arrives via the `onError` event — the detector runs entirely in main). A full rewrite is tracked separately (see the internal ticket referenced from `private/Data_Structures.md`). Only the dashboard method (DASH-09/10) and the `DashboardAlertIssue` type below have been brought current — **the rest is not guaranteed fresh**.

> Every method is one operation. There's no generic `invoke(channel, data)`. All arguments are validated in main (type, format, length, range). `sessionId`/`hostId` are checked for existence and ownership by the window. Secrets are never returned in responses (SEC-05, guide §4).

```ts
interface LucidSSHBridge {
  // --- Hosts ---
  listHosts(): Promise<Host[]>;
  listGroups(): Promise<HostGroup[]>;
  createHost(input: HostInput, secret?: string): Promise<{ id: number }>; // secret goes straight to the keychain
  updateHost(id: number, input: HostInput, secret?: string): Promise<void>;
  deleteHost(id: number): Promise<void>;                 // also cleans up Credential Manager
  hostHasSecret(id: number): Promise<boolean>;           // for the "password saved" UI state, no value
  // DASH-09/10 "Don't show again": a channel about a dashboard finding, not host CRUD
  // (renamed from config:dismiss-dashboard-alert, ADR-0015).
  dismissDashboardAlert(hostId: number, issue: DashboardAlertIssue): Promise<void>;

  // --- Sessions ---
  connectHost(hostId: number): Promise<{ sessionId: string; status: SessionStatus }>;
  disconnectSession(sessionId: string): Promise<void>;
  confirmHostKey(requestId: string, decision: 'accept' | 'reject'): Promise<void>;

  // --- Guard (a command reaches the server only through this check, ADR-0008) ---
  // Both entry points return SubmitResult: 'sent' — it went out; 'blocked' — the
  // type-to-confirm dialog (GUARD-02); 'access-risk' — the advisory dialog (GUARD-07).
  // The prompt comes back as the reply to the call itself; there is no separate event.
  submitCommand(sessionId: string, command: string): Promise<SubmitResult>;   // Enter-submitted input
  sendTerminalInput(sessionId: string, text: string): Promise<SubmitResult>;  // raw text (paste)
  confirmDangerousCommand(requestId: string, confirmationText: string): Promise<{ allowed: boolean }>;
  cancelDangerousCommand(requestId: string): void;       // cancel: the pending record is dropped in main

  // --- Catalog / errors (read-only access to the built-in databases) ---
  getCommandCatalog(): Promise<CommandsDatabase>;
  explainError(ref: FallbackRef): Promise<ErrorExplanation>; // doc-search in 1.0

  // --- Snippets ---
  // listSnippets: no args — globals only; with hostId — globals + that host's server-scoped ones (SNIP-06)
  listSnippets(hostId?: number): Promise<Snippet[]>;
  createSnippet(input: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>): Promise<{ id: number }>;
  // updateSnippet: hostId is included to allow changing a snippet's scope
  updateSnippet(id: number, input: Partial<Pick<Snippet, 'name' | 'command' | 'description' | 'hostId'>>): Promise<void>;
  deleteSnippet(id: number): Promise<void>;
  // Called before deleting a host that has server-scoped snippets (SNIP-07)
  resolveHostSnippets(hostId: number, action: 'delete' | 'make-global'): Promise<void>;
  reorderSnippets(hostId: number | null, orderedIds: number[]): Promise<void>; // SNIP-10, atomically rewrites sort_order within the group

  // --- Connection log ---
  getConnectionLog(sessionId: string): Promise<ConnectionLogEntry[]>;

  // --- Host export / import ---
  exportHosts(): Promise<string>;                        // returns a JSON string (EXP-01)
  previewImportHosts(json: string): Promise<ImportPreview>; // EXP-03
  importHosts(json: string, conflictStrategy: 'skip' | 'rename'): Promise<{ imported: number; skipped: number }>; // EXP-02
  listHistory(query?: HistoryQuery): Promise<HistoryEntry[]>;
  addHistoryNote(id: number, note: string): Promise<void>;
  deleteHistoryEntry(id: number): Promise<void>;
  clearHistory(): Promise<void>;

  // --- Import ---
  importPuttySessions(): Promise<{ imported: number }>;
  importSshConfig(): Promise<{ imported: number; skippedDirectives: string[] }>;

  // --- Updates ---
  checkForUpdate(): Promise<UpdateInfo | null>;
  startUpdateDownload(): Promise<void>;
  applyUpdate(): Promise<void>;                           // after confirmation

  // --- Events (main → renderer) ---
  // Every subscription returns its own unsubscribe function (called on unmount).
  onTerminalData(cb: (sessionId: string, data: string) => void): () => void;
  onSessionStatus(cb: (sessionId: string, status: SessionStatus) => void): () => void;
  onHostKeyPrompt(cb: (req: HostKeyPrompt) => void): () => void;
  onError(cb: (sessionId: string, explanation: ErrorExplanation) => void): () => void;
  onDashboard(cb: (sessionId: string, metrics: DashboardMetrics) => void): () => void;
  onBreadcrumb(cb: (sessionId: string, crumb: Breadcrumb) => void): () => void;
}
```

### 7.1 Supporting types

```ts
type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface HostKeyPrompt {
  requestId: string;
  hostId: number;
  fingerprintSha256: string;
  isChanged: boolean;          // true → changed, blocked (SSH-04)
  previousFingerprint?: string;
}

// DASH-09/10: findings for the one-shot health banner after the first successful poll.
// Dismissed ones live in hosts.db, table host_dismissed_alerts (§2.3, ADR-0015).
type DashboardAlertIssue = 'cpu' | 'ram' | 'disk' | 'rebootRequired';

type DangerScope = 'file' | 'directory' | 'disk' | 'other';

// Id of a dangerous pattern (guard/patterns.ts, GUARD-01) — the i18n key of its
// explanation (guard.explain.<id>) and what the renderer compares against. The
// union is closed: a new pattern that is not listed here fails to compile.
type DangerPatternId =
  | 'rm-recursive' | 'dd-write' | 'mkfs' | 'chmod-777' | 'truncate'
  | 'redirect-device' | 'shred' | 'wipefs' | 'fork-bomb'
  | 'drop-database' | 'kill-init';

interface DangerousCommandPrompt {
  requestId: string;
  sessionId: string;
  command: string;
  patternId: DangerPatternId;  // pattern of the CHOSEN object — the explanation describes that one
  // The object whose name must be typed (GUARD-03). When a compound command has
  // several dangerous fragments, it is drawn at random among the heaviest ones
  // ('disk' outranks everything, the rest are level); the draw happens once in
  // main and is not re-rolled when the user retypes after a typo.
  target: string;
  // ALL recognized objects of the command — for display only: the whole-string
  // match first (fork bomb), then per-fragment matches in fragment order. Always
  // contains target; with a single dangerous fragment it is exactly that one.
  targets: string[];
  scope: DangerScope;          // scope of the CHOSEN object
  confirmationKind: 'target' | 'word'; // by the object's name, or by a generic confirmation word
  confirmationText: string;    // what exactly to type, already localized; compared in main
}

// Category of the risk of losing SSH access (GUARD-07).
type AccessRiskId = 'sshd-config' | 'firewall' | 'passwd' | 'sshd-service';

// Warning about the risk of losing SSH access (GUARD-07): advisory, not a block —
// a two-button dialog with no type-to-confirm. Only checked when no dangerous
// pattern matched the command.
interface AccessRiskPrompt {
  requestId: string;
  sessionId: string;
  command: string;
  riskId: AccessRiskId;        // the text comes from i18n keyed by riskId, it is not sent as a string
}

// Result of submitting a command through the guard (submitCommand / sendTerminalInput).
type SubmitResult =
  | { status: 'sent' }
  | { status: 'blocked'; prompt: DangerousCommandPrompt }
  | { status: 'access-risk'; prompt: AccessRiskPrompt };

// The header events feed (NOTIF-03) is assembled in the renderer and never crosses
// IPC: there is no notification channel. Held in memory by stores/events.tsx (these
// are active alerts, not history) and fed by three signals that already exist —
// onHostKeyPrompt with isChanged (fingerprint), onUpdateStatus with state
// 'available' (update), and the renderer's own shell-state signal (guardUncertain,
// TERM-10 fail-safe).
interface AppEvent {
  id: string;
  type: 'fingerprint' | 'update' | 'guardUncertain';
  hostName?: string;           // fingerprint, guardUncertain
  version?: string;            // update
  createdAt: number;
}

interface DashboardMetrics {
  cpuPercent: number | null;   // null → "—" (DASH-05)
  ramUsedMb: number | null;
  ramTotalMb: number | null;
  diskPercent: number | null;
  uptimeSeconds: number | null;
  loadAvg1: number | null;     // /proc/loadavg, 1/5/15 min (full dashboard modal only)
  loadAvg5: number | null;
  loadAvg15: number | null;
  netUpKbps: number | null;    // delta over /proc/net/dev, same measurement window as CPU
  netDownKbps: number | null;
  topProcesses: DashboardProcess[];  // top 5 by CPU, [] if unavailable
}

interface DashboardProcess {
  pid: number;
  user: string;
  cmd: string;          // short name (ps comm, no arguments)
  cpuPercent: number;
  memPercent: number;
}

interface Breadcrumb {
  username: string;
  host: string;
  path: string;
  privilege: 'normal' | 'sudo' | 'root';  // BRD-03
}

interface ErrorExplanation {
  title: string;
  explanation: string;
  checks: ErrorCheck[];
  source: 'database' | 'fallback';        // 'llm' will be added in 1.2
}

interface HistoryQuery {
  text?: string;
  hostId?: number;
  sessionId?: string; // the "This session" filter — applied in the renderer, by id list
}

interface UpdateInfo {
  currentVersion: string;
  newVersion: string;
  notes: string;
  downloadSizeBytes: number;
}

type AppNotificationKind = 'fingerprint-changed' | 'update-available';

interface ConnectionLogEntry {
  timestamp: string;            // ISO 8601
  level: 'info' | 'warn' | 'error';
  message: string;              // no secrets (CLOG-03)
  step?: 'tcp' | 'handshake' | 'hostkey' | 'auth' | 'session';
}

interface ImportPreview {
  toAdd: number;
  toSkip: number;
  conflicts: Array<{ name: string; address: string; username: string }>;
}

interface AppNotification {
  id: string;                         // unique, for deduplication
  kind: AppNotificationKind;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  hostId?: number;                    // for fingerprint-changed
  createdAt: string;                  // ISO 8601
  read: boolean;
}
```

---

## 8. known_hosts

OpenSSH format (`known_hosts`), managed in main. On first connection, an entry is added after confirmation (SSH-03). A key change never overwrites an entry automatically — only after an explicit user decision (SSH-04). The file is accessible only to the current user.

---

## 9. Cross-cutting rules for every structure

1. Secrets (passwords, passphrases, key contents) — Credential Manager only, never in SQLite/JSON/logs/IPC responses (SEC-01, guide §10, §17).
2. Key paths are stored as a reference to the original; the key is never copied (SEC-02).
3. Any string coming from the server (stderr, breadcrumb, metrics, man/--help) is untrusted input: parsed as data, never executed, masked for secrets before being saved/logged.
4. The built-in databases' versions (`errors.core.json`, `commands.core.json`) are checked against the app version; their update strategy is OQ-06.
5. Extension points for 1.2 (`FallbackRef.kind`, `ErrorExplanation.source`) are in place, but the LLM implementation is absent in 1.0.
6. Denormalizing `host_name`/`username` into history is intentional: the entry stays readable after the host is deleted.

*— end of document —*
