---
status: accepted
---

# Portable profiles and secrets use durable identities, not build type, path, or numeric ID

Decision (November 2026): a portable profile has two durable identities —
`profile.id` (a UUID v4 in a separate file in the profile folder) and `credentialId`
(a UUID v4 in `hosts.credential_id`). Portable-host secrets are addressed as
`LucidSSH/{profileId}/{credentialId}`. Installed builds and other platforms keep
the legacy `LucidSSH/{hostId}` address.

**Why this is a decision, not an obvious default.** Portability exposes three
implicit assumptions in the old scheme:

1. **A numeric SQLite ID was treated as host identity.** Copying `hosts.db`
   preserves it, so unrelated profiles and the installed build could address
   the same Credential Manager entry. Keeping access when a folder is copied
   should be an explicit rule, not a side effect of coinciding row IDs.
2. **Build type or path was treated as identity.** A secret address based on
   the exe path changes when a folder is renamed or a drive letter changes.
   The fact that the running artifact is portable does not identify its profile.
3. **The profile had no independent identity.** Silently regenerating it after
   configuration loss or corruption would make saved secrets unreachable.

**Rejected secret-addressing alternatives:**

- **Only numeric `hostId`** — cannot isolate independent portable profiles.
  Retained for installed builds: avoiding a migration of existing Secret Store
  entries matters more than making every build use the same address shape.
- **Profile-folder path** — moving or renaming the folder, or changing a drive
  letter, would lose access to secrets.
- **Build-type flag** — two copies of one profile are still the same profile,
  not separate identities merely because each is launched as portable.
- **Only `credentialId`, without `profile.id`** — rejected in favor of an explicit
  profile namespace and a separate host credential identity. Copying a database
  preserves its IDs intentionally; independent profiles must have their own
  profile identities. Changing an SSH destination mints a new `credentialId`,
  detaching that host without modifying the secret shared by other copies.

**Why `profile.id` is a separate file, not configuration.** Identity is read before
the configuration, database opening, and migrations: a corrupted `config.json`
must not change which secrets are addressed. A missing identity next to existing
profile data, or an invalid identity, blocks startup without regeneration.
Regeneration would silently lose the address. A profile is new only when both
`profile.id` and all known data artifacts are absent; the exe and unrelated files
alone do not make the folder an existing profile.

**Boundaries:**

- Installed profiles, Linux, and dev mode do not get a `profile.id`. Host records
  do get `credentialId` through migration/creation on every platform, but installed
  and Linux secret addressing still uses `LucidSSH/{hostId}`. Adding the column
  does not migrate or invalidate existing Secret Store entries.
- On Windows, secrets do not travel between machines with the folder: DPAPI is
  bound to the user/machine. This is an architectural limit, explained once on
  first launch of a new portable profile.
- `profile.id` and `credentialId` are not secrets, but remain main-only: not in the
  renderer host model, `AppInfo`, host export/import, or logs.
