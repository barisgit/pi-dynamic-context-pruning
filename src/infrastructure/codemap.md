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

**Responsibility:** Serialize DCP runtime state to pi session entries and restore it on session resume or branch switching. Uses a tiny scalar bootstrap (<4 KiB); the real block state is reconstructed by replay.

**What it does:**

- Defines `PersistedDcpStateV3` as the active persisted schema — a tiny scalar bootstrap containing only:
  `{ schemaVersion: 3, savedAt, currentTurn, lastNudgeTurn, lastCompressTurn, prunedToolIds, lifetimeTokensSavedRealized }`.
  No `compressionBlocks`, `messageAliases`, `tokensSaved`, `nextBlockId` — those are reconstructed by replay from the session transcript + `compress` tool calls/results + `dcp-native-compaction` entries.
- Exposes `serializePersistedState(state: DcpState): PersistedDcpState` — converts the live runtime state to the appropriate persisted schema based on `state.schemaVersion`.
- Exposes `restorePersistedState(data, state)` — deserializes a persisted entry into the runtime `DcpState`. Has three branches: v1 (ignores `manualMode`, reconstructs `compressionBlocks` + `tokensSaved` from `compressionBlocks` array), v2 (ignores `manualMode`, reconstructs `compressionBlocks` from legacy `blocks` array), and v3 (scalar bootstrap only; full state from replay). v1/v2 branches exist for retro vacuum and test fixtures; new writes always produce v3.
- Exposes `serializeLegacyV1PersistedState(state)` and `serializeLegacyV2PersistedState(state)` — kept for test fixtures and `vacuum-dcp-session.ts` retro-vacuum path. These produce the legacy shapes and must not be called by the active runtime path.
- Provides normalization helpers for each persisted data shape (`normalizeLegacyBlock`, `normalizeV2Block`, `normalizeCompressionBlockMetadata`, `normalizeFileReadStat`, `normalizeFileWriteStat`, `normalizeCommandStat`, `normalizeCompressionLogEntry`, etc.). All return `null` or sentinel values on bad input rather than throwing.

**Notably:** Persistence does not own the read/write I/O — that belongs to `session-handler` which calls `pi.appendEntry` / reads from branch entries. This module only defines the serialization contract and the restore/serialize functions. Replay lives in `src/domain/replay/`; `restorePersistedState` v3 delegates to it after populating the scalar fields.

---

## Integration

| File             | Imported by                                                                                                                                                                                                                                                                                        | How                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`      | `src/index.ts`, `src/config.ts` (re-export shim)                                                                                                                                                                                                                                                   | `loadConfig()` called once at extension init to produce the `DcpConfig` passed into all handlers.                                                                                                                                                                                                                                                                                                                    |
| `debug-log.ts`   | `src/index.ts`, `src/debug-log.ts` (re-export shim), `src/application/context-handler.ts`, `src/application/session-handler.ts`, `src/application/provider-handler.ts`, `src/application/compress-tool/registration.ts`, `src/application/native-compaction.ts`, `tests/helpers/dcp-test-utils.ts` | `appendDebugLog()` called on lifecycle events (session start/end, context evaluation, compress success/failure, state saves) and provider-payload filtering. `buildSessionDebugPayload()` injects stable session metadata into every log line.                                                                                                                                                                       |
| `persistence.ts` | `src/application/session-handler.ts`, `src/migration.ts` (re-export shim), `tests/unit/persistence-migration.test.ts`, `tests/unit/session-handler.test.ts`, `tests/helpers/dcp-test-utils.ts`                                                                                                     | `serializePersistedState()` always writes v3 (scalar bootstrap) on `session_shutdown` / `agent_end`. `restorePersistedState()` delegates to `src/domain/replay/` for v3 data; v1/v2 branches are exercised only by retro vacuum and legacy-session-restore tests. |

### State flow

```
session_start / session_tree
  └─> session-handler.ts
        └─> restorePersistedState()       [persistence.ts]
              ├─> v3: populates scalar fields → delegates to replay/
              ├─> v2: ignores manualMode, reconstructs from legacy blocks array
              └─> v1: ignores manualMode, reconstructs from compressionBlocks array

runtime work (compression, pruning)
  └─> mutates DcpState in-memory

session_shutdown / agent_end
  └─> session-handler.ts
        └─> serializePersistedState()    [persistence.ts]
              └─> pi.appendEntry("dcp-state", v3 bootstrap)
```

### Config flow

```
pi starts
  └─> index.ts
        └─> loadConfig(projectDir)      [config.ts]
              └─> returns DcpConfig (deep-merged defaults + layered files)
                    └─> passed to all handlers, tools, commands
```
