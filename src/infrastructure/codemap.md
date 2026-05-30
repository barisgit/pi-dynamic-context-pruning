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

**Responsibility:** Serialize DCP runtime state to pi session entries and restore it on session resume or branch switching. Active writes use a tiny v3 scalar marker when no blocks exist, or the first complete v5 coverage-bearing shape once blocks exist.

**What it does:**

- **Active persisted schemas (v3/v5):**
  - **v3** — scalar bootstrap only: `{ schemaVersion: 3, savedAt, currentTurn, lastNudgeTurn, lastCompressTurn, prunedToolIds, lifetimeTokensSavedRealized }`. Written when `compressionBlocks.length === 0`.
  - **v5** — v3 scalars plus `blocks` and `nextBlockId`. Written once blocks exist. Blocks carry full coverage anchors (`coveredSourceKeys`, `coveredSpanKeys`) plus real finite timestamp fallbacks through `persistCompressionBlockV5`.
- Exposes `serializePersistedState(state)` — picks v3 vs v5 from block count; does not consult `state.schemaVersion`.
- Exposes `restorePersistedStateScalars(data, state)` — scalar-continuity entry point for branches without coverage-bearing state. Applies only scalar fields via internal `restorePersistedScalars()` (`prunedToolIds`, `lifetimeTokensSavedRealized`, turn counters). No-op on `{ unchanged: true }`. Does not load blocks.
- Exposes `restorePersistedState(data, state)` — full restore for coverage-bearing and legacy back-compat paths. Branches:
  - `{ unchanged: true }` — no-op (cumulative restore keeps prior branch state).
  - **v5** — direct restore of scalars plus full block state with coverage anchors, span keys, finite timestamps, `nextBlockId`, and active-block token savings.
  - **v4** — legacy lossy light blocks; still understood for back-compat, but never written anymore and restored without coverage anchors.
  - **v3** — scalars only; no blocks restored.
  - **v2 / `Array.isArray(blocks)`** — legacy/deferred-dead `compressionBlocksV2` scaffolding; not a live written shape.
  - **v1** — legacy fat snapshot for back-compat, retro vacuum, and test fixtures.
- Exposes `serializeLegacyV1PersistedState(state)` and `serializeLegacyV2PersistedState(state)` — test/vacuum round-trip only; not called by live runtime.
- Provides normalization helpers (`normalizeLegacyBlock`, `normalizeV2Block`, `normalizePersistedCompressionBlockV4`, `restorePersistedCompressionBlockV5`, metadata/stat/log normalizers, etc.). All return `null` or sentinel values on bad input rather than throwing.

**Notably:** Persistence does not own read/write I/O — `session-handler` calls `pi.appendEntry` / reads branch entries. Restore dispatch is post direct-restore:

- **Coverage-bearing entry (v1/v2/v5)** — `restorePersistedState()` restores the full block state plus scalars directly.
- **No coverage-bearing entry** — `restorePersistedStateScalars()` restores scalar continuity only; blocks remain empty, which is safe for lossy legacy v4.
- **Replay domain** — `replayDcpState` remains available for offline scripts (`scripts/replay-equivalence.ts`, `scripts/vacuum-dcp-session.ts`) and tests, not live/session restore.

`saveState()` in `session-handler` appends `serializePersistedState(state)` only when `state.pendingSave` is true (set by compress, prune, native-compaction commits); cleared after append.

---

## Integration

| File             | Imported by                                                                                                                                                                                                                                                   | How                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`      | `src/index.ts`                                                                                                                                                                                                                                                | `loadConfig()` called once at extension init to produce the `DcpConfig` passed into all handlers.                                                                                                                                                                |
| `debug-log.ts`   | `src/index.ts`, `src/application/context-handler.ts`, `src/application/session-handler.ts`, `src/application/provider-handler.ts`, `src/application/compress-tool/registration.ts`, `src/application/native-compaction.ts`, `tests/helpers/dcp-test-utils.ts` | `appendDebugLog()` called on lifecycle events (session start/end, context evaluation, compress success/failure, state saves) and provider-payload filtering. `buildSessionDebugPayload()` injects stable session metadata into every log line.                   |
| `persistence.ts` | `src/application/session-handler.ts`, `tests/unit/persistence-migration.test.ts`, `tests/unit/session-handler.test.ts`, `tests/helpers/dcp-test-utils.ts`                                                                                                     | `serializePersistedState()` writes v3 (no blocks) or v5 (coverage-bearing block state) on `session_shutdown` / `agent_end` when `pendingSave` is true. Restore uses the latest coverage-bearing entry for full direct restore, otherwise scalar-only continuity. |

### State flow

```text
session_start / session_tree
  └─> session-handler.ts
        └─> restoreStateFromBranch()
              ├─> latest coverage-bearing dcp-state (v1/v2/v5)
              │     └─> restorePersistedState() (full blocks + scalars)
              └─> otherwise latest dcp-state
                    └─> restorePersistedStateScalars() (scalar continuity only)

runtime work (compression, pruning, native compaction)
  └─> mutates DcpState in-memory; sets pendingSave = true

session_shutdown / agent_end
  └─> session-handler.ts
        └─> saveState() when pendingSave
              └─> serializePersistedState() → pi.appendEntry("dcp-state", v3 or v5)
                    └─> pendingSave = false
```

### Config flow

```text
pi starts
  └─> index.ts
        └─> loadConfig(projectDir)      [config.ts]
              └─> returns DcpConfig (deep-merged defaults + layered files)
                    └─> passed to all handlers, tools, commands
```
