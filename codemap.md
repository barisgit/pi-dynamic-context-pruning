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

This repo is at **dcp-replay-v3**. Persistence is replay-first; the in-memory block model is still the legacy block log with source-key anchors.

### Restore model (dcp-replay-v3 + replay-on-context)

On `session_start` / `session_tree`, `restoreStateFromBranch` checks `branchIsReplayable()`:

- **Replayable branch** (contains DCP-relevant transcript evidence — successful `compress` tool results or `dcp-native-compaction` entries): performs a **scalar-only** restore (turn counters, `prunedToolIds`, `lifetimeTokensSavedRealized`) and sets `state.replayPending = true`. Block reconstruction is deferred to the first `context` event, which runs `replayDcpState` against pi's live message buffer. This guarantees `mNNNN` ref-allocation parity with the agent at compress time.
- **Non-replayable branch** (pre-v3 sessions with only persisted `dcp-state` snapshots and no transcript evidence): falls back to the legacy snapshot walk, which fully restores `compressionBlocks` from disk. `state.replayPending` is cleared so the context handler skips replay.

### Active runtime path

`state.compressionBlocks` is still the live block log. `src/domain/replay/index.ts` reconstructs it from the transcript. `compressionBlocksV2` and `src/domain/compression/materialize.ts` are scaffolding only.

### Removed in dcp-replay-v3

- `/dcp sweep`, `/dcp decompress`, `/dcp manual` subcommands — dropped
- `state.manualMode` plumbing (prompt variant, config flag, command handler) — removed; `initializeSessionState` is a no-op
- Full block-log persistence — no longer written to disk; restored lazily from transcript

---

## System Entry Points

| File                                      | Purpose                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/index.ts`                            | Extension entry point; wires config, state, tools, commands, and hook handlers                       |
| `src/application/session-handler.ts`      | Session lifecycle hooks (start/tree/shutdown/agent_end); scalar restore, `saveState`                 |
| `src/application/context-handler.ts`       | `context` event hook — lazy replay trigger, materialize, nudge, footer                               |
| `src/application/compress-tool/registration.ts` | `compress` tool registration and execution                                      |
| `src/infrastructure/config.ts`             | JSONC config loading with 4-layer deep-merge                                                          |
| `src/domain/replay/index.ts`              | `replayDcpState` — reconstructs block log from session transcript                                    |

---

## Repository Directory Map

| Directory                          | Responsibility Summary                                                                               | Detailed Map                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `src/`                            | Extension root: entry point and backward-compat shim re-exports                                      | [View Map](src/codemap.md)                       |
| `src/application/`                | Orchestration layer: event hook wiring, tool/command registration, host payload adaptation, domain delegation | [View Map](src/application/codemap.md) |
| `src/application/commands/`       | `/dcp` slash command: `context`, `stats`, `compress`, `compact`, `help`                             | [View Map](src/application/commands/codemap.md)  |
| `src/application/compress-tool/`  | `compress` tool: registration, range validation, block construction, planning hints                  | [View Map](src/application/compress-tool/codemap.md) |
| `src/domain/`                     | Pure business logic: zero pi/provider/FS imports                                                    | [View Map](src/domain/codemap.md)                |
| `src/domain/compression/`         | Block construction, range resolution, exact metadata, supersession, v2 materialization scaffold        | [View Map](src/domain/compression/codemap.md)    |
| `src/domain/pruning/`             | Active runtime pruning: block application, atomic repair, dedup, error purge, ID injection           | [View Map](src/domain/pruning/codemap.md)        |
| `src/domain/transcript/`          | Canonical snapshot builder: source items, spans, logical turns, live owner keys                     | [View Map](src/domain/transcript/codemap.md)     |
| `src/domain/provider/`            | Provider-payload stale artifact filtering via canonical owner keys                                   | [View Map](src/domain/provider/codemap.md)       |
| `src/domain/refs/`                | Visible ref parsing/formatting (`mNNNN`, `bN`) and DCP metadata stripping                          | [View Map](src/domain/refs/codemap.md)           |
| `src/domain/tokens/`              | Token estimation (gpt-tokenizer + chars/4 fallback)                                                  | [View Map](src/domain/tokens/codemap.md)         |
| `src/domain/nudge/`               | Nudge type decision helpers (thin re-export from pruning)                                           | [View Map](src/domain/nudge/codemap.md)         |
| `src/domain/replay/`              | `replayDcpState` — reconstructs block log, supersession, savedTokenEstimate, prunedToolIds from transcript | [View Map](src/domain/replay/codemap.md) |
| `src/infrastructure/`             | Side effects: JSONC config loading, JSONL debug logging, persisted-state contract                   | [View Map](src/infrastructure/codemap.md)       |
| `src/prompts/`                    | System prompt additions, compress tool contract text, nudge text                                     | [View Map](src/prompts/codemap.md)               |
| `src/types/`                      | Config, state, message, and API boundary types                                                      | [View Map](src/types/codemap.md)                |
| `scripts/`                        | Capture-only HTTP proxy for LLM traffic debugging                                                   | [View Map](scripts/codemap.md)                  |

---

## Architecture

### Layer Rules

- **Domain** (`src/domain/`) — pure business logic. Must not import `@mariozechner/pi-coding-agent`, filesystem utilities, config loading, debug logging, or application handlers.
- **Application** (`src/application/`) — adapts pi/provider payloads, wires hooks, delegates pure decisions to domain.
- **Infrastructure** (`src/infrastructure/`) — owns side effects: config files, persisted-state, JSONL debug logging.
- **Compatibility shims** (`src/*.ts`) — thin re-exports for older import paths; new code uses layered paths.

### Event Processing Pipeline

```
session_start / session_tree
    ├─ branchIsReplayable() → true?
    │   ├─ SCALAR-ONLY restore (turn counters, prunedToolIds, lifetimeTokensSavedRealized)
    │   └─ state.replayPending = true
    └─ false? (pre-v3)
        └─ snapshot fallback: full block restore from disk, state.replayPending = false

before_agent_start
    └─ inject SYSTEM_PROMPT

tool_call / tool_result
    └─ populate state.toolCalls (toolCallId → ToolRecord)

context ← main transform
    ├─ state.replayPending?
    │   └─ TRUE: replayDcpState against live message buffer → state.replayPending = false
    ├─ buildTranscriptSnapshot() + buildLiveOwnerKeys()
    ├─ materializeContextMessages()
    │   └─ applyPruning()
    │       ├─ countLogicalTurns() → update state.currentTurn
    │       ├─ applyCompressionBlocks() — splice ranges, insert bN summaries
    │       ├─ repairOrphanedToolPairs() — atomic assistant+tool-result safety net
    │       ├─ applyDeduplication() — bucket-gated fingerprint dedup
    │       ├─ applyErrorPurging() — bucket-gated error aging
    │       ├─ applyToolOutputPruning() — replace pruned content with tombstone
    │       └─ injectMessageIds() — inject mNNNN + bN visible IDs
    ├─ nudgeType = getNudgeType() — decide if nudge should fire
    ├─ injectNudge() if warranted
    └─ updateDcpStatus footer

before_provider_request
    └─ filterProviderPayloadInput() — prune stale reasoning/function_call/function_call_output
                                      using canonical owner keys + live owner map

session_before_compact / session_compact / turn_end
    └─ native compaction bridge (see src/application/native-compaction.ts)

agent_end / session_shutdown
    └─ saveState() → append "dcp-state" custom session entry (scalar-only in v3)
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

| Pattern                          | Usage                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| Hook-based pipeline              | pi extension hooks chain together; shared state via closures                              |
| Canonical transcript             | `buildTranscriptSnapshot` builds immutable snapshot for liveness derivation               |
| Exact metadata over timestamps    | `coveredSourceKeys`/`coveredSpanKeys` preferred; timestamps for legacy fallback only     |
| Deterministic activity log       | `CompressionLogEntry[]` in block summaries — reproducible across renders                |
| Fingerprint dedup                | `createInputFingerprint()` — `toolName::JSON(sortedArgs)` for stable dedup               |
| Bucket-gated tombstones          | `prunedToolIds` additions gated by `floor(currentTurn / pruneCadenceTurns) * N`          |
| Two-phase provider filtering     | newest represented compress → receipt; older represented pairs suppressed                |
| Auto-trigger with queue drain    | `pendingAutoRequests` queue drained atomically at `turn_end` to prevent cancel loops      |
| Lifetime realized savings        | `lifetimeTokensSavedRealized` accumulates savings from native-compaction-absorbed blocks  |
| Replay-first persistence         | block log reconstructed from transcript on first context event; scalar-only on-disk state |
| Lazy replay on context           | `state.replayPending` defers `replayDcpState` until live message buffer is available     |

---

## Integration

- **Consumed by**: pi coding agent (via ExtensionAPI)
- **Depends on**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`, `jsonc-parser`, `gpt-tokenizer`
- **Exports**: Default extension function from `src/index.ts`
