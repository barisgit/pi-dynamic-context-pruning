# Infrastructure

## Responsibility

`src/infrastructure/` houses all side-effectful, host-environment code that sits at the boundary between DCP and pi. These modules own:

- reading and writing the user's DCP configuration file
- appending structured debug logs to disk
- serializing and deserializing DCP runtime state across pi sessions (including cross-branch repair)

They must not be imported by domain modules (`src/domain/`). Application modules (`src/application/`) and the extension entry point (`src/index.ts`) are the only clients.

---

## Files

### `src/infrastructure/config.ts`

**Responsibility:** Load and merge DCP configuration from layered sources, with best-effort defaults.

**What it does:**

- Defines `DEFAULT_CONFIG` (the full typed baseline `DcpConfig` object) and `DEFAULT_CONFIG_FILE_CONTENT` (the annotated JSONC skeleton written to new config files).
- Exposes `loadConfig(projectDir: string): DcpConfig`, which builds a config by deep-merging four layers in order:
  1. Built-in defaults (deep-cloned so the constant is never mutated).
  2. Global user config — `~/.pi/agent/dcp.jsonc`, falling back to `~/.config/pi/dcp.jsonc` (XDG legacy). The preferred path is created automatically if neither exists.
  3. `$PI_CONFIG_DIR/dcp.jsonc` (read if the env var is set).
  4. Project-local `$(projectDir)/.pi/dcp.jsonc`, discovered by walking up the directory tree from `projectDir`.
- Provides `deepMerge<T>()` — a recursive object merger; arrays are union-merged (deduped by value).
- Provides `readJsoncFile()` — reads a JSONC file using `jsonc-parser`; returns `{}` on any error.
- Re-exports `DcpConfig` as a named export.

**Notably:** Config loading is entirely best-effort. Missing files or parse errors fall through silently; the default fills the gap. This keeps DCP operational even when the config file is broken or inaccessible.

---

### `src/infrastructure/debug-log.ts`

**Responsibility:** Append structured, best-effort JSONL debug events to `~/.pi/log/dcp.jsonl`.

**What it does:**

- Defines `DEBUG_LOG_PATH = ~/.pi/log/dcp.jsonl`.
- Exposes `appendDebugLog(config, event, payload)` — appends a single JSON line `{ timestamp, event, payload }` to `DEBUG_LOG_PATH`; guarded by `config.debug` (a no-op when debug is off).
- Exposes `appendDebugLogLine(filePath, event, payload)` — lower-level append to any path; used directly by `session-handler` for session-scoped logs.
- Exposes `buildSessionDebugPayload(sessionManager)` — builds a stable payload fragment `{ sessionId, cwd, sessionDir, sessionFile, leafId }` from a pi session manager.
- Provides `normalizeDebugValue()` — walks arbitrary values and converts `Error`, `Set`, `Map`, `Array`, plain objects, and non-finite numbers to JSON-safe equivalents before logging.

**Notably:** All writes are best-effort (`try/catch` swallowing all errors). Debug logging must never affect runtime behavior.

---

### `src/infrastructure/persistence.ts`

**Responsibility:** Serialize DCP runtime state to pi session entries and restore it on session resume or branch switching. Active writes use a tiny v3/v4 bootstrap; coverage metadata and aliases are reconstructed by replay on replayable branches.

**What it does:**

- **Active persisted schemas (v3/v4):**
  - **v3** — scalar bootstrap only: `{ schemaVersion: 3, savedAt, currentTurn, lastNudgeTurn, lastCompressTurn, prunedToolIds, lifetimeTokensSavedRealized }`. Written when `compressionBlocks.length === 0`.
  - **v4** — v3 scalars plus a light `PersistedCompressionBlockV4[]` and `nextBlockId`. Written once blocks exist. Light blocks carry summary/topic/savings/active/superseded ids only — no coverage anchors, span keys, activity logs, or alias snapshots.
- Exposes `serializePersistedState(state)` — picks v3 vs v4 from block count; does not consult `state.schemaVersion`.
- Exposes `restorePersistedStateScalars(data, state)` — replayable-restore entry point. Applies only scalar fields via internal `restorePersistedScalars()` (`prunedToolIds`, `lifetimeTokensSavedRealized`, turn counters). No-op on `{ unchanged: true }`. Does not load blocks.
- Exposes `restorePersistedState(data, state)` — full restore for non-replayable and legacy paths. Branches:
  - `{ unchanged: true }` — no-op (cumulative restore keeps prior branch state).
  - **v4** — scalars + light blocks into `state.compressionBlocks` (timestamps set to `Infinity`, empty coverage metadata except `supersededBlockIds`); derives `nextBlockId` and `tokensSaved` from active blocks.
  - **v3** — scalars only; blocks/aliases/tokensSaved left to replay or prior restore.
  - **v2 / v1** — legacy fat snapshots for retro vacuum and test fixtures (ignores removed `manualMode`).
- Exposes `serializeLegacyV1PersistedState(state)` and `serializeLegacyV2PersistedState(state)` — test/vacuum round-trip only; not called by live runtime.
- Provides normalization helpers (`normalizeLegacyBlock`, `normalizeV2Block`, `normalizePersistedCompressionBlockV4`, metadata/stat/log normalizers, etc.). All return `null` or sentinel values on bad input rather than throwing.

**Notably:** Persistence does not own read/write I/O — `session-handler` calls `pi.appendEntry` / reads branch entries. Restore dispatch:

- **Replayable branch** — `restorePersistedStateScalars()` per `dcp-state` entry; `replayPending = true`; block reconstruction deferred to `context-handler` replay (v4 light blocks intentionally skipped — they lack coverage anchors).
- **v4 non-replayable branch** — `restorePersistedState()` loads light blocks + scalars; `replayPending = false`.
- **Legacy fallback** — snapshot walk via `restorePersistedState()` over all branch entries.

`saveState()` in `session-handler` appends `serializePersistedState(state)` only when `state.pendingSave` is true (set by compress, prune, native-compaction commits); cleared after append.

---

## Integration

| File             | Imported by                                                                                                                                                                                                                                                                                        | How                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`      | `src/index.ts`, `src/config.ts` (re-export shim)                                                                                                                                                                                                                                                   | `loadConfig()` called once at extension init to produce the `DcpConfig` passed into all handlers.                                                                                                                                                                                                       |
| `debug-log.ts`   | `src/index.ts`, `src/debug-log.ts` (re-export shim), `src/application/context-handler.ts`, `src/application/session-handler.ts`, `src/application/provider-handler.ts`, `src/application/compress-tool/registration.ts`, `src/application/native-compaction.ts`, `tests/helpers/dcp-test-utils.ts` | `appendDebugLog()` called on lifecycle events (session start/end, context evaluation, compress success/failure, state saves) and provider-payload filtering. `buildSessionDebugPayload()` injects stable session metadata into every log line.                                                          |
| `persistence.ts` | `src/application/session-handler.ts`, `src/migration.ts` (re-export shim), `tests/unit/persistence-migration.test.ts`, `tests/unit/session-handler.test.ts`, `tests/helpers/dcp-test-utils.ts`                                                                                                     | `serializePersistedState()` writes v3 (no blocks) or v4 (light block list) on `session_shutdown` / `agent_end` when `pendingSave` is true. Replayable restore uses `restorePersistedStateScalars()` + lazy replay; v4 non-replayable uses `restorePersistedState()`; legacy branches use snapshot walk. |

### State flow

```
session_start / session_tree
  └─> session-handler.ts
        └─> restoreStateFromBranch()
              ├─> replayable: restorePersistedStateScalars() per dcp-state entry
              │     └─> replayPending = true → context-handler replayDcpState()
              ├─> v4 && !replayable: restorePersistedState() (light blocks + scalars)
              │     └─> replayPending = false
              └─> legacy: snapshot walk via restorePersistedState() over branch entries

runtime work (compression, pruning, native compaction)
  └─> mutates DcpState in-memory; sets pendingSave = true

session_shutdown / agent_end
  └─> session-handler.ts
        └─> saveState() when pendingSave
              └─> serializePersistedState() → pi.appendEntry("dcp-state", v3 or v4)
                    └─> pendingSave = false
```

### Config flow

```
pi starts
  └─> index.ts
        └─> loadConfig(projectDir)      [config.ts]
              └─> returns DcpConfig (deep-merged defaults + layered files)
                    └─> passed to all handlers, tools, commands
```
