# LucidSSH for Windows — Data Structures Specification

| Field | Value |
|---|---|
| Document version | 1.1 |
| Date | June 27, 2026 |
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
| Error database | Bundled with the package | `assets/errors.json` | No |
| Command catalog | Bundled with the package | `assets/commands.json` | No |

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
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
  -- IMPORTANT: no password, passphrase, or key contents live here.
  -- The secret is in Credential Manager under the key LucidSSH/{id}.
);
```

### 2.3 TypeScript types

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
}
```

### 2.4 Relation to Credential Manager

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
  note        TEXT
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

A 10,000-entry limit (HIST-06). Once exceeded, the oldest entry by `started_at` is removed, **except** entries marked as favorites (`is_favorite = 1`). Terminal output is not saved by default.

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

## 4. Built-in database — errors.json

### 4.1 Format

```json
{
  "version": "1.0.0",
  "patterns": [
    {
      "id": "permission-denied",
      "match": "(?i)permission denied",
      "category": "filesystem",
      "title": "Permission denied",
      "explanation": "The current user doesn't have permission for this action. The file or directory belongs to another user (often root).",
      "checks": [
        { "text": "Run with sudo", "command": "sudo {original}" },
        { "text": "Check the owner", "command": "ls -la {target}" },
        { "text": "Check the current user", "command": "whoami" }
      ],
      "scope": "command"
    }
  ]
}
```

### 4.2 TypeScript type

```ts
type ErrorScope = 'command' | 'ssh-connection';

interface ErrorCheck {
  text: string;             // what to check
  command?: string;         // a suggested command; {original}/{target} are substituted SAFELY
}

interface ErrorPattern {
  id: string;
  match: string;            // a regular expression (compiled on load)
  category: string;
  title: string;
  explanation: string;      // localized text (NFR-07)
  checks: ErrorCheck[];
  scope: ErrorScope;
}

interface ErrorsDatabase {
  version: string;          // semver, checked against the app version
  patterns: ErrorPattern[];
}
```

### 4.3 Required coverage (ERR-04, ERR-05)

permission denied, no such file or directory, command not found, connection refused, disk full, out of memory, segmentation fault, syntax error; SSH: Connection refused, Permission denied (publickey), Host key verification failed, Connection timed out.

### 4.4 Extension point for 1.2

The detector returns a result shaped like `{ matched: ErrorPattern } | { matched: null, fallback: FallbackRef }`. In 1.0, `fallback` leads to the generic template / documentation search (ERR-06). In 1.2, the same `fallback` will route to a local LLM (spec §12.13). The detector's contract doesn't need to change for that.

```ts
interface FallbackRef {
  kind: 'doc-search' | 'llm';   // always 'doc-search' in 1.0
  command: string;
  exitCode?: number;
  stderrExcerpt: string;        // a minimal excerpt, after secret masking
}
```

---

## 5. Built-in database — commands.json

### 5.1 Format

```json
{
  "version": "1.0.0",
  "categories": ["files", "processes", "network", "system", "text"],
  "commands": [
    {
      "name": "ls",
      "category": "files",
      "summary": "List a directory's contents",
      "keywords": ["list", "files", "directory", "show"],
      "flags": [
        { "flag": "-l", "desc": "Detailed listing with permissions and size" },
        { "flag": "-la", "desc": "Detailed, including hidden files" },
        { "flag": "-h", "desc": "Human-readable sizes" },
        { "flag": "-R", "desc": "Recurse into subdirectories" }
      ],
      "dangerous": false
    }
  ]
}
```

### 5.2 TypeScript type

```ts
type CommandCategory = 'files' | 'processes' | 'network' | 'system' | 'text';

interface CommandFlag {
  flag: string;             // e.g. "-la"
  desc: string;             // localized explanation (NFR-07)
}

interface CatalogCommand {
  name: string;
  category: CommandCategory;
  summary: string;          // a one-line explanation
  keywords: string[];       // for localized search: "delete" → rm (CAT-05)
  flags: CommandFlag[];
  dangerous: boolean;       // a UI hint; the guard makes the actual decision, not this field
}

interface CommandsDatabase {
  version: string;
  categories: CommandCategory[];
  commands: CatalogCommand[];
}
```

Clicking a flag builds the string and **sends it through the guard** (CAT-04 + GUARD-04), not straight to SSH.

---

## 6. config.json

```ts
interface AppConfig {
  version: string;
  window: {
    x?: number;
    y?: number;
    width: number;
    height: number;
    maximized: boolean;           // WIN-01
  };
  onboarding: {
    completed: boolean;           // OB-03: first run completed
  };
  ui: {
    expertMode: boolean;          // quick toggle to disable ALL hints (SET-05)
    // granular toggles (SET-05) — expertMode sets all of these to false
    hints: {
      commandCatalog: boolean;    // command catalog hints (CAT-06)
      outputTooltips: boolean;    // command output tooltips
      errorPanel: boolean;        // error detector panel (ERR-03)
      connectionDialog: boolean;  // learning hints in the connection dialog
    };
    theme: 'dark';                // dark only in 1.0; 'light' | string to be added in 1.1/1.2
    notifications: {
      systemToasts: boolean;      // Windows system notifications (NOTIF-04)
      longCommandThresholdSec: number; // 0 = off (NOTIF-02)
    };
    dashboardVisible: boolean;    // DASH-04
    catalogPanelOpen: boolean;
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
  history: {
    enabled: boolean;             // HIST-07: global disable
    perHostDisabled: number[];    // hostIds for which history is off
  };
  shownCounts: Record<string, number>; // hint id → how many times shown (cap 3)
  updates: {
    autoCheck: boolean;           // OQ-09
    source: string;               // update source URL
  };
}
```

config.json **contains no secrets** (SEC-01). `hints.shownCounts` implements the "shown at most 3 times" rule from spec §5.1.

---

## 7. IPC contract

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
  onNotification(cb: (event: AppNotification) => void): () => void; // NOTIF-03: fingerprint + update
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
  sessionOnly?: boolean;
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
4. The built-in databases' versions (`errors.json`, `commands.json`) are checked against the app version; their update strategy is OQ-06.
5. Extension points for 1.2 (`FallbackRef.kind`, `ErrorExplanation.source`) are in place, but the LLM implementation is absent in 1.0.
6. Denormalizing `host_name`/`username` into history is intentional: the entry stays readable after the host is deleted.

*— end of document —*
