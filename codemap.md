# pi-dynamic-context-pruning / Repository Atlas

## Project Responsibility

A **pi coding agent extension** implementing Dynamic Context Pruning (DCP). DCP manages context window pressure through:

1. **Compression blocks** — Replace older conversation ranges with citable `bN` summaries authored by the LLM
2. **Deduplication** — Remove redundant tool outputs with identical inputs (bucket-gated)
3. **Error purging** — Mark stale errored tool outputs after N logical turns
4. **Nudge injection** — Prompt the agent to compress when context fills up
5. **Provider-payload filtering** — Prune stale hidden artifacts from provider requests using canonical owner keys
6. **Native compaction bridge** — Translate DCP block state into pi's session compaction lifecycle

Host runtime: Node.js inside pi. Dev/test toolchain: Bun. ESM TypeScript, no build step — pi loads `.ts` directly.

---

## Current Architecture Status

This repo is **post direct-restore**. Persistence restores coverage-bearing block state directly; the in-memory block model is still the legacy block log with source-key anchors.

### Restore model (direct-restore)

On `session_start` / `session_tree`, `restoreStateFromBranch()` uses the single `directRestore()` path. `RestoreMode` is literally `"persisted"` (the path name, not a success claim):

- `resetState()` + `initializeSessionState()` prepare an empty runtime state.
- Latest coverage-bearing `dcp-state` entry (v1/v5) → `restorePersistedState()` restores full block state plus scalar continuity directly (`restoredStateEntries = 1`).
- No coverage-bearing entry → latest `dcp-state` entry, if any, restores scalar continuity only via `restorePersistedStateScalars()` (`prunedToolIds`, turn watermarks, `lifetimeTokensSavedRealized`); blocks stay empty, which is safe for lossy legacy v4.
- Then `repairOffBranchNativeCompactionState()` and `repairStaleNudgeWatermarks()` run. The context handler has no replay trigger.

### Active runtime path

`state.compressionBlocks` is the live block log used by runtime pruning. `src/domain/replay/index.ts` is retained for offline scripts/tests only. `src/domain/compression/materialize.ts` now contains only shared compressed-block rendering helpers.

### Removed legacy runtime paths

- `/dcp sweep`, `/dcp decompress`, `/dcp manual` subcommands — dropped
- Manual-mode plumbing (prompt variant, config flag, command handler) — removed; `initializeSessionState` is a no-op
- Replay-on-resume runtime plumbing — removed. Persistence now writes v3 scalar-only markers for empty sessions and v5 coverage-bearing snapshots once blocks exist; v4 is legacy read back-compat only and is not written.

---

## System Entry Points

| File                                            | Purpose                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/index.ts`                                  | Extension entry point; wires config, state, tools, commands, and hook handlers       |
| `src/application/session-handler.ts`            | Session lifecycle hooks (start/tree/shutdown/agent_end); direct restore, `saveState` |
| `src/application/context-handler.ts`            | `context` event hook — materialize, prune, nudge, footer                             |
| `src/application/compress-tool/registration.ts` | `compress` tool registration and execution                                           |
| `src/infrastructure/config.ts`                  | JSONC config loading with 4-layer deep-merge                                         |
| `src/domain/replay/index.ts`                    | `replayDcpState` — offline-only replay for equivalence/vacuum tooling                |

---

## Repository Directory Map

| Directory                        | Responsibility Summary                                                                                        | Detailed Map                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `src/`                           | Extension root: extension entry point and DcpState factory                                                    | [View Map](src/codemap.md)                           |
| `src/application/`               | Orchestration layer: event hook wiring, tool/command registration, host payload adaptation, domain delegation | [View Map](src/application/codemap.md)               |
| `src/application/commands/`      | `/dcp` slash command: `context`, `stats`, `compact`, `help`                                                   | [View Map](src/application/commands/codemap.md)      |
| `src/application/compress-tool/` | `compress` tool: registration, range validation, block construction, planning hints                           | [View Map](src/application/compress-tool/codemap.md) |
| `src/domain/`                    | Pure business logic: zero pi/provider/FS imports                                                              | [View Map](src/domain/codemap.md)                    |
| `src/domain/compression/`        | Block construction, range resolution, exact metadata, supersession, v2 materialization scaffold               | [View Map](src/domain/compression/codemap.md)        |
| `src/domain/pruning/`            | Active runtime pruning: block application, atomic repair, dedup, error purge, ID injection                    | [View Map](src/domain/pruning/codemap.md)            |
| `src/domain/transcript/`         | Canonical snapshot builder: source items, spans, logical turns, live owner keys                               | [View Map](src/domain/transcript/codemap.md)         |
| `src/domain/provider/`           | Provider-payload stale artifact filtering via canonical owner keys                                            | [View Map](src/domain/provider/codemap.md)           |
| `src/domain/refs/`               | Visible ref parsing/formatting (`mNNNN`, `bN`) and DCP metadata stripping                                     | [View Map](src/domain/refs/codemap.md)               |
| `src/domain/tokens/`             | Token estimation (gpt-tokenizer + chars/4 fallback)                                                           | [View Map](src/domain/tokens/codemap.md)             |
| `src/domain/nudge/`              | Nudge type decision helpers (thin re-export from pruning)                                                     | [View Map](src/domain/nudge/codemap.md)              |
| `src/domain/replay/`             | `replayDcpState` — offline-only reconstruction for replay-equivalence/vacuum tooling and tests                | [View Map](src/domain/replay/codemap.md)             |
| `src/infrastructure/`            | Side effects: JSONC config loading, JSONL debug logging, persisted-state contract                             | [View Map](src/infrastructure/codemap.md)            |
| `src/prompts/`                   | System prompt additions, compress tool contract text, nudge text                                              | [View Map](src/prompts/codemap.md)                   |
| `src/types/`                     | Config, state, message, and API boundary types                                                                | [View Map](src/types/codemap.md)                     |
| `scripts/`                       | Standalone bun dev/debug tools: capture-only LLM proxy plus offline replay-equivalence and vacuum tooling     | [View Map](scripts/codemap.md)                       |

---

## Architecture

### Layer Rules

- **Domain** (`src/domain/`) — pure business logic. Must not import `@mariozechner/pi-coding-agent`, filesystem utilities, config loading, debug logging, or application handlers.
- **Application** (`src/application/`) — adapts pi/provider payloads, wires hooks, delegates pure decisions to domain.
- **Infrastructure** (`src/infrastructure/`) — owns side effects: config files, persisted-state, JSONL debug logging.

### Event Processing Pipeline

```text
session_start / session_tree
    └─ restoreStateFromBranch() → directRestore() (mode: "persisted")
        ├─ resetState() + initializeSessionState()
        ├─ latest coverage-bearing dcp-state (v1/v5)?
        │   └─ restorePersistedState() — full block state + scalars
        ├─ else latest dcp-state?
        │   └─ restorePersistedStateScalars() — scalar continuity only; blocks stay empty
        ├─ repairOffBranchNativeCompactionState()
        └─ repairStaleNudgeWatermarks()

before_agent_start
    └─ inject SYSTEM_PROMPT

tool_call / tool_result
    └─ populate state.toolCalls (toolCallId → ToolRecord)

context ← main transform
    ├─ materializeContextMessages()
    │   ├─ buildTranscriptSnapshot() + buildLiveOwnerKeys()
    │   └─ applyPruning()
    │       ├─ countLogicalTurns() → update state.currentTurn
    │       ├─ applyCompressionBlocks() — splice ranges, insert bN summaries
    │       ├─ repairOrphanedToolPairs() — atomic assistant+tool-result safety net
    │       ├─ applyDeduplication() — bucket-gated fingerprint dedup
    │       ├─ applyErrorPurging() — bucket-gated error aging
    │       ├─ applyToolOutputPruning() — replace pruned content with tombstone
    │       └─ injectMessageIds() — inject mNNNN + bN visible IDs
    ├─ resolveEffectiveContextSize() — max(host tokens, DCP estimate)
    ├─ nudgeType = getNudgeType() — decide if nudge should fire
    ├─ injectNudge() if warranted
    └─ updateDcpStatus footer

before_provider_request
    └─ filterProviderPayloadInput() — prune stale reasoning/function_call/function_call_output
                                      using canonical owner keys + live owner map

session_before_compact / session_compact / turn_end
    └─ native compaction bridge (see src/application/native-compaction.ts)

agent_end / session_shutdown
    └─ saveState() → if state.pendingSave, append "dcp-state"
        ├─ v3 scalar marker when no blocks exist
        └─ v5 full coverage-bearing state when blocks exist
```

---

## Key Invariants

1. Assistant + tool-result pairs removed **atomically** (`expandCompressionIndexRange` + repair safety net)
2. Prefer exact coverage metadata (`coveredSourceKeys`/`coveredSpanKeys`) over timestamp fallback; timestamp fallback for legacy blocks only
3. Visible IDs (`mNNNN`, `bN`) and internal canonical owner keys are separate layers — owner tags must not be rendered into model-visible content
4. Supersession allowed only for exact full coverage — partial ambiguous overlap conservatively rejects
5. Hot-tail protection counts **logical turns**, not raw message count
6. Saved-token accounting must be stable across repeated renders — `state.tokensSaved` is current net savings, not lifetime total
7. Bucket-gated dedup/purge: additions to `prunedToolIds` happen only at turn-bucket boundaries (`floor(currentTurn/N)*N`)

---

## Design Patterns

| Pattern                        | Usage                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hook-based pipeline            | pi extension hooks chain together; shared state via closures                                                                                           |
| Canonical transcript           | `buildTranscriptSnapshot` builds immutable snapshot for liveness derivation                                                                            |
| Exact metadata over timestamps | `coveredSourceKeys`/`coveredSpanKeys` preferred; timestamps for legacy fallback only                                                                   |
| Deterministic activity log     | `CompressionLogEntry[]` in block summaries — reproducible across renders                                                                               |
| Fingerprint dedup              | `createInputFingerprint()` — `toolName::JSON(sortedArgs)` for stable dedup                                                                             |
| Bucket-gated tombstones        | `prunedToolIds` additions gated by `floor(currentTurn / pruneCadenceTurns) * N`                                                                        |
| Two-phase provider filtering   | newest represented compress → receipt; older represented pairs suppressed                                                                              |
| Auto-trigger with queue drain  | `pendingAutoRequests` queue drained atomically at `turn_end` to prevent cancel loops                                                                   |
| Lifetime realized savings      | `lifetimeTokensSavedRealized` accumulates savings from native-compaction-absorbed blocks                                                               |
| Direct-restore persistence     | coverage-bearing persisted entries restore block state immediately; empty sessions write v3 scalars and block sessions write v5 coverage-bearing state |
| Offline replay tooling         | `replayDcpState` is retained for replay-equivalence/vacuum scripts and tests, not as a live restore path                                               |

---

## Integration

- **Consumed by**: pi coding agent (via ExtensionAPI)
- **Depends on**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`, `jsonc-parser`, `gpt-tokenizer`
- **Exports**: Default extension function from `src/index.ts`
