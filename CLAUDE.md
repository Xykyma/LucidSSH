# CLAUDE.md — operating rules for Claude Code

This file contains the mandatory rules for working on **LucidSSH for Windows**. Read before every task. On conflict: the spec (`private/TZ.md`) and the implemented UI in `src/renderer/components/` take priority over this file; this file takes priority over general habits.

> **Public/private repository.** Part of the documentation lives in `private/` — not published, contains unimplemented requirements, roadmap, and internal decision context. `docs/` is the public showcase (README, implemented ✅ requirements, security architecture, data schemas) — published in **English**, since the repository audience isn't limited to Russian speakers; `private/` stays in **Russian**, it's the working source for the developer and Claude Code, not meant for outside readers. For internal work (including resolving open questions, planning features beyond 1.0) always use the full versions in `private/`, not the public ones in `docs/`. Split details — `docs/agent/domain.md` or ask the developer.

---

## 0. What this project is

A desktop SSH client for Windows built on Electron + TypeScript. Target audience: beginners, without getting in the way of experienced users. Fully local: **no account, no cloud, no telemetry**.

Four features set the product apart (must not be simplified without explicit agreement):
- **Dangerous command guard** — intercepts `rm -rf` and similar before they reach the server.
- **Error detector** — explains stderr/SSH errors offline, without an LLM (localized; Russian by default).
- **"Where am I" breadcrumb** — current path above the terminal, clickable.
- **Command catalog** — sidebar with explanations (localized, Russian by default).

---

## 1. Sources of truth (in priority order)

1. **`private/TZ.md`** — requirements, IDs, acceptance criteria (full version, including unimplemented requirements and open questions). If a rule here conflicts with the spec, the spec wins. The public showcase (✅ requirements only) is `docs/TZ.md`, not a source of truth for internal work.
2. **Implemented code in `src/renderer/components/`** — **source of truth for the UI**. `doc/screenshots/` has been removed (moved into git history); an archived design mockup lives at `private/backup/2026-07-05_v1.1/*.dc.html` and is useful as a reference for intent, but not as ground truth. Before laying out or changing any screen, open the corresponding component and check how it's already implemented: placement, states, colors, text. Don't invent a layout that exists neither in the code nor in `Design_Brief.md`. If a screen's behavior is unclear and undocumented — **stop and ask**, don't guess.
3. **`private/Design_Brief.md`** — design intent, tokens, behavior.
4. **`package.json`** — the single source of truth for the version number.
5. This file — operating rules.

Unsure about a requirement — ask, don't guess. I (the developer) prefer to understand the rationale before a rule is set; propose trade-offs, not directives.

### Project document map (`docs/` — public, `private/` — not published)

Where to look for what before working on a module. For internal work, Claude Code always uses the `private/` version when one exists — it has the full context (unimplemented requirements, roadmap, open questions); the public version in `docs/` is only a trimmed, English showcase for GitHub.

| Document | Path | When it must be opened |
|---|---|---|
| `TZ.md` | `private/TZ.md` (full, Russian), `docs/TZ.md` (public, ✅ only, English) | Any task: requirements, IDs, acceptance criteria. Highest priority. Work from `private/TZ.md`. |
| `src/renderer/components/` | — | Any UI work — source of truth for screens (screenshots/ removed, see §1). |
| `Design_Brief.md` | `private/Design_Brief.md` (Russian) | Layout, tokens, component behavior. |
| `Data_Structures.md` | `private/Data_Structures.md` (full, Russian), `docs/Data_Structures.md` (public, English) | **`hosts/`, `history/`, `errors/`** — SQLite schemas, content-database formats (`errors.core.json`, `commands.core.json`, translations in `locales/`), LLM extension points. Don't write a table schema or JSON parser without checking first. |
| `Security_Guide.md` | `private/Security_Guide.md` (full, Russian), `docs/Security_Guide.md` (public, English) | Any code touching section 4 (keytar, keys, IPC, fingerprint, masking). Rationale for security requirements. |
| `Development_Roadmap.md` | `private/Development_Roadmap.md` (Russian) | Doubt about "is this in 1.0 or later" — check against scope (§3). |
| `Release_and_Update_Strategy.md` | `private/Release_and_Update_Strategy.md` (full, Russian), `docs/Release_and_Update_Strategy.md` (public, English) | Work on the auto-update module (`updates/`), version bumps, channel/signing strategy. Check before any release-pipeline change — use the `private/` version. |
| `Local_LLM_Spec.md` | `private/Local_LLM_Spec.md` (Russian) | **Reference only, for a future version.** Do not implement in 1.0 code. |
| `Ideas_Backlog.md`, `Design_Readiness_Checklist.md` | `private/` (Russian) | Unsorted ideas and a design-phase checklist — usually not needed for writing code. |
| `README.md` | repository root | Public, usually not needed for writing code. |

---

## 2. Stack and boundaries

Electron 30+ / Node 20+ · TypeScript (strict) · React + Tailwind · xterm.js · ssh2 · better-sqlite3 · keytar · electron-builder · **i18next + react-i18next + i18next-fs-backend** (multi-language support).

- Strict TypeScript: no `any` without an explicit reason in a comment, no `// @ts-ignore` without an explanation.
- Don't add dependencies without asking. Especially ones that duplicate what's already in the stack.
- Target platform is Windows 10/11 x64 only. No cross-platform code needed.

---

## 3. Repository structure

Follow the existing tree. New code goes where it belongs, not into the root of `main/` or `renderer/`.

```
src/main/      ssh/ guard/ errors/ hosts/ history/ dashboard/ keychain/ i18n/
src/renderer/  components/{Terminal,HostManager,Breadcrumb,Dashboard,
               CommandCatalog,History,Guard,ErrorPanel}  stores/  i18n/
assets/        locales/{ru,en}/*.json   errors.core.json   commands.core.json
```

- SSH, guard, and metrics logic — **in the main process**. The renderer never opens sockets or touches SSH directly.
- Guard patterns — in `guard/patterns.ts`, **not inline**.
- `i18n/` exists on both main and renderer: guard/detector messages are built in the main process, so translations are needed on both sides of the IPC boundary (see section 5a).

---

## 4. Security — non-negotiable

- Passwords — **only** through keytar → Windows Credential Manager. Never in files, SQLite, logs, or history.
- Private keys — used from their original path, **never copied** into the app directory.
- Electron: `contextIsolation: true`, `nodeIntegration: false`. IPC — only through `contextBridge`, no direct Node access from the renderer.
- Verify the server fingerprint on **every** connection, store it in `known_hosts`.
- Mask secrets in command history (HIST-07).

Any change that weakens the above — stop and get agreement first.

---

## 5. Rules for key modules

**Dangerous command guard**
- Intercepted in the main process **before** the command is sent over SSH.
- The dialog requires typing the **object's name**, not just clicking "OK".
- Logged to history with a "blocked" / "confirmed" marker.
- An experienced user can disable it globally or per host.

**Error detector**
- Offline only, driven by `assets/errors.core.json` + the active translation. **No LLM** in 1.0.
- Trigger: exit code ≠ 0 or non-empty stderr.
- The panel slides up from the bottom, **never covers** the input line. Closes via Esc or ×.

**Breadcrumb**
- Path via shell integration (PROMPT_COMMAND / precmd), **not** separate commands sent into the session.
- Updates after every `cd`. Root session shown in red. Clicking inserts the element into the input line.

**Server dashboard**
- A separate SSH exec channel, **not the main session**. 10-second interval.
- Unavailable → "—", not an error. CPU > 80% orange, RAM > 90% red.

**UX**
- Hints — shown at most 3 times, then hidden.
- "Expert mode" in settings turns off all hints.
- **No hardcoded strings in the UI.** All user-visible text goes through i18n (section 5a). Default language is Russian, fallback is English.

---

## 5a. Multi-language support (i18n) — built in from the start

The architecture is designed for **N languages**. 1.0 ships with **ru + en**; adding a language = a new folder in `assets/locales/<lang>/`, **no code changes**.

**Library:** i18next + react-i18next (renderer) + i18next-fs-backend (main). Chosen as the standard for Electron+React: one mechanism on both sides of the IPC boundary, namespaces per module, CLDR pluralization (important for Russian: 1 file / 2 files / 5 files).

**Rules:**
- No UI strings in code. Only `t('namespace:key')`. This applies to the main process too (guard messages, detector titles/text are built there).
- Keys are semantic (`guard.confirm.title`), not text-derived (`guard.udalit_fayl`).
- Pluralization and interpolation go through i18next, not string concatenation.
- Default language `ru`, fallback `en`. The chosen language is stored in `config.json`, switched in settings.
- **The content databases (`errors.core.json`, `commands.core.json`) are multi-language too**, but under a special scheme: the technical part (regex `match`, `id`, `category`, `flag`, command names) is **shared, not translated**; only the human-readable text (`title`, `explanation`, `summary`, `desc`, `checks[].text`, `keywords`) is translated, in `locales/{lang}/`. The exact schema is in `Data_Structures.md` (sections 5–6). **Don't duplicate regexes per language.**
- EN translations can be filled in gradually: missing key → falls back to ru. But the **structure** for translation must be in place from the first commit of the corresponding module.

---

## 6. What's NOT in version 1.0

For the list of features outside the current release, see `private/Development_Roadmap.md` §3 (not published here).

A permanent architectural constraint, not a version deferral (decision closed for good, not a backlog item): **a local PowerShell/CMD/WSL terminal is not being added** — the product stays an SSH client, not a general-purpose terminal emulator; the guard/detector/breadcrumb/dashboard are hard-wired to the remote SSH exec channel and can't be ported to a local process without duplicating the whole architecture. Rationale — `docs/agent/adr/0002-no-local-shell.md`.

The data structures already include extension points for a future explanations module (`FallbackRef`, `ErrorExplanation.source`, see `docs/Data_Structures.md`, public) — **don't touch or implement** these, just don't break them.

---

## 7. Open questions

All questions from the spec except one were closed during the `/grill-with-docs` session on 2026-07-16/17 — see the decisions in `private/TZ.md` §11.2 and `private/adr/` (not published).

One question remains open — OQ-10, needs a technical performance measurement before it can be decided. Details — `private/TZ.md` §11.2.

Of the three ADRs recorded from that session, only `docs/agent/adr/0002-no-local-shell.md` is public (an architectural boundary, not a business decision) — the other two are in `private/adr/`.

---

## 8. Git and versioning

**Versions**
- `package.json` — the single source of truth for the version number.
- Semantic Versioning per the Release Strategy.
- Version bumps — **always a separate commit**: `chore: bump version to X.Y.Z`, never inside a feature commit. Claude Code prepares the `package.json` change and proposes the message; the developer makes the commit.

**Who commits:** Claude Code prepares changes and proposes commit-message text. Claude Code makes the commit **only on an explicit command for that specific commit** (decision 2026-07-17) — not by default, and not as a one-time blanket permission for the rest of the session's commits. Without an explicit command — propose the message only, don't commit. This applies to all commits, not just version bumps; pushing is a separate permission, even after a commit.

**Commits** — Conventional Commits:
- `feat:` new functionality · `fix:` bug fix · `chore:` maintenance/bump · `refactor:` · `docs:` · `test:` · `style:` · `build:`
- Subject line ≤ 72 characters, imperative mood.
- One commit = one logical change. Don't mix a refactor with a feature.

**CHANGELOG.md** — Keep a Changelog format, **in English** (decision from 2026-07-25: the repository is public, the audience isn't limited to Russian speakers — as a technical document for contributors, the CHANGELOG is kept in a single language to avoid drift risk; only the user-facing GitHub Release description is bilingual). Sections: Added, Changed, Fixed, Removed, Security. The GitHub Release description mirrors the corresponding CHANGELOG block (can be bilingual, ru+en, like the release itself).

**Release blocker:** BLK-01 — code signing certificate (closed: decision — ship without a signature, SHA-256 instead, see `docs/TZ.md` NFR-06 — public). Full rationale — `private/TZ.md` §11.1 and `private/Release_and_Update_Strategy.md` §9 (not published).

---

## 9. Build, run, environment

- Package manager: **npm** (decision from 2026-07-02). Lockfile — `package-lock.json` only.
- Build: **electron-vite** (main + preload + renderer), packaging — electron-builder.
- Scripts (`package.json` is the source of truth):
  - `dev` — run Electron in development mode (electron-vite dev)
  - `build` — production build (electron-vite build)
  - `dist` — build + package the installer via electron-builder
  - `typecheck` — `tsc --noEmit` for the node and web projects
  - `lint` — ESLint (flat config)
  - `test` / `test:watch` — vitest
  - `rebuild:test` / `rebuild:app` — see below, native-module ABI switch
- Node 20+ is required (`engines`), locally pinned to Node 22 (`.nvmrc`).
- Run `typecheck` and `lint` before committing code changes; don't propose a commit with a failing typecheck.
- **Native module ABI switch (`better-sqlite3`, `keytar`).** `npm run dev`/`dist` need a build against the Electron ABI, `vitest` needs the system Node ABI; the same `node_modules` can't satisfy both at once (discovered 2026-07-24). Before running tests that touch `better-sqlite3`/`keytar` (e.g. `history/*.test.ts`) — `npm run rebuild:test`; afterward, before going back to `npm run dev` — always `npm run rebuild:app`. The repository's working (default) state is the Electron ABI.

---

## 10. Testing

- **Must be covered by tests** (critical for security and product behavior):
  - guard patterns (`guard/patterns.ts`) — both firing correctly and not false-positiving;
  - secret masking (`secrets/maskers.ts`) — against real-world leak examples (guide §15);
  - merging content-database cores with translations (errors/commands) — linked by `id`, fallback when a key is missing;
  - error detector — matching patterns from the required-coverage set (ERR-04/05);
  - the host-key decision module (`src/main/ssh/`, extracted from `sessionManager` — see `docs/agent/adr/0016-host-key-trust-is-a-property-of-the-connection.md`) — every branch of "may we trust this key": match, unknown key, changed key, accept, reject, decision timeout, and a decision taken without a live Session. Reject and timeout must leave `known_hosts` untouched. The same applies to the wiring in `src/main/ssh/connection.ts` — the only place a `hostVerifier` is set for any Connection: it always delegates to the decision module; `verify(false)` yields a `hostkey-rejected` outcome and never reaches `ready`; a `verify` arriving after the Connection closed never reaches ssh2. This is the implementation of SEC-03 and SSH-07, and a wrong branch degrades silently: no screen reports it, `known_hosts` just quietly fills with the wrong keys.
- These modules **cannot be changed without updating their tests** in the same change.
- Test framework — **vitest** (decision from 2026-07-02). Test files — `*.test.ts` next to the module.
- UI components are covered in 1.0 as needed, with no hard requirement; priority is main-process logic.

---

## 11. Workflow

- Before a task: read the relevant spec section and check the screen against the implemented component in `src/renderer/components/`.
- Big changes — plan first, then code.
- Don't silently do things that weren't asked for (new dependencies, architecture changes, scope expansion).
- When a trade-off is honestly explained, I'm inclined to accept scope expansion rather than defer the feature — so show alternatives along with their timeline consequences.

---

## Agent skills

### Issue tracker

Issues/specs live as local markdown under `.scratch/<feature-slug>/` — GitHub Issues exists (public remote) and is used as raw incoming user reports, triaged via `/triage` before landing in `.scratch/`. See `docs/agent/issue-tracker.md`.

### Triage labels

Default canonical label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, plus `bug`/`enhancement`), all created on the GitHub repo. See `docs/agent/triage-labels.md`.

### Domain docs

Single-context layout, but at a non-default path: `docs/agent/CONTEXT.md` (glossary + decision rationale only — `private/TZ.md` stays the requirements/ID registry) — **not created yet**, appears only when a genuine glossary term needs sharpening (see `docs/agent/domain.md`) — and ADRs split across `docs/agent/adr/` (published, architecture-only) and `private/adr/` (not published, business/legal).
