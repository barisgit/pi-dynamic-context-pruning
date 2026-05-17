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

**Responsibility:** Serialize DCP runtime state to pi session entries and restore it on session resume or branch switching, including cross-branch block repair and legacy-to-v2 migration scaffolding.

**What it does:**

- Defines two persisted schemas:
  - `PersistedDcpStateV1` — timestamp-backed blocks (`compressionBlocks`, `prunedToolIds`, `tokensSaved`, etc.), the current active runtime format.
  - `PersistedDcpStateV2` — span-key-backed blocks (`blocks`, `nextBlockId`, `messageAliases`, etc.), scaffolded for future v2 materialization.
- Exposes `serializePersistedState(state: DcpState): PersistedDcpState` — converts the live runtime state to the appropriate persisted schema based on `state.schemaVersion`.
- Exposes `restorePersistedState(data, state)` — deserializes a persisted entry into the runtime `DcpState`. Handles both V1 and V2 schemas; for V2 data, populates `state.compressionBlocksV2` while leaving `state.compressionBlocks` empty (v2 materialization is not yet active).
- Exposes `mapLegacyBlockToSpanRange(block, snapshot)` — maps a legacy timestamp-backed block onto the current `TranscriptSnapshot` span model by finding the containing `tool-exchange` span for each timestamp boundary.
- Exposes `migrateLegacyCompressionBlocksToV2(blocks, snapshot)` — converts a list of legacy blocks to `CompressionBlockV2` entries using the span mapping; unresolved blocks are skipped conservatively.
- Provides a full suite of normalization helpers for each persisted data shape (`normalizeLegacyBlock`, `normalizeV2Block`, `normalizeCompressionBlockMetadata`, `normalizeFileReadStat`, `normalizeFileWriteStat`, `normalizeCommandStat`, `normalizeCompressionLogEntry`, etc.). All return `null` or sentinel values on bad input rather than throwing, keeping restoration best-effort.

**Notably:** Persistence does not own the read/write I/O — that belongs to `session-handler` which calls `pi.appendEntry` / reads from branch entries. This module only defines the serialization contract and the restore/serialize functions. The v2 migration helpers are scaffolding; they are not yet called by the runtime.

---

## Integration

| File             | Imported by                                                                                                                                                                                                                                                                                        | How                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`      | `src/index.ts`, `src/config.ts` (re-export shim)                                                                                                                                                                                                                                                   | `loadConfig()` called once at extension init to produce the `DcpConfig` passed into all handlers.                                                                                                                                                                                                                                                                                                                    |
| `debug-log.ts`   | `src/index.ts`, `src/debug-log.ts` (re-export shim), `src/application/context-handler.ts`, `src/application/session-handler.ts`, `src/application/provider-handler.ts`, `src/application/compress-tool/registration.ts`, `src/application/native-compaction.ts`, `tests/helpers/dcp-test-utils.ts` | `appendDebugLog()` called on lifecycle events (session start/end, context evaluation, compress success/failure, state saves) and provider-payload filtering. `buildSessionDebugPayload()` injects stable session metadata into every log line.                                                                                                                                                                       |
| `persistence.ts` | `src/application/session-handler.ts`, `src/migration.ts` (re-export shim), `tests/unit/persistence-migration.test.ts`, `tests/unit/session-handler.test.ts`, `tests/helpers/dcp-test-utils.ts`                                                                                                     | `serializePersistedState()` called on every `session_shutdown` and `agent_end` event to write state into the pi session entry log. `restorePersistedState()` called on `session_start` and `session_tree` events to rehydrate state from the active branch's DCP entries. Cross-branch repair logic in `session-handler` also uses the normalization helpers to reconstruct block state from off-branch DCP entries. |

### State flow

```
session_start / session_tree
  └─> session-handler.ts
        └─> restorePersistedState()      [persistence.ts]
              └─> populates DcpState fields

runtime work (compression, pruning)
  └─> mutates DcpState in-memory

session_shutdown / agent_end / native_compaction
  └─> session-handler.ts
        └─> serializePersistedState()   [persistence.ts]
              └─> pi.appendEntry("dcp-state", ...)
```

### Config flow

```
pi starts
  └─> index.ts
        └─> loadConfig(projectDir)      [config.ts]
              └─> returns DcpConfig (deep-merged defaults + layered files)
                    └─> passed to all handlers, tools, commands
```
