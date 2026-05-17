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

## System Entry Points

| File                                            | Purpose                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/index.ts`                                  | Extension entry point; wires config, state, tools, commands, and hook handlers |
| `src/application/session-handler.ts`            | Session lifecycle hooks (start/tree/shutdown/agent_end), save/restore state    |
| `src/application/context-handler.ts`            | `context` event hook — main transform: materialize, nudge, footer              |
| `src/application/compress-tool/registration.ts` | `compress` tool registration and execution                                     |
| `src/infrastructure/config.ts`                  | JSONC config loading with 4-layer deep-merge                                   |
| `src/infrastructure/persistence.ts`             | V1/V2 serialization contract and normalization helpers                         |

## Directory Map (Aggregated)

| Directory                        | Responsibility Summary                                                                                        | Detailed Map                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `src/`                           | Extension root: entry point and backward-compat shim re-exports                                               | [View Map](src/codemap.md)                           |
| `src/application/`               | Orchestration layer: event hook wiring, tool/command registration, host payload adaptation, domain delegation | [View Map](src/application/codemap.md)               |
| `src/application/commands/`      | `/dcp` slash command: context, stats, sweep, manual, decompress, compress, compact                            | [View Map](src/application/commands/codemap.md)      |
| `src/application/compress-tool/` | `compress` tool: registration, range validation, block construction, planning hints                           | [View Map](src/application/compress-tool/codemap.md) |
| `src/domain/`                    | Pure business logic: zero pi/provider/FS imports                                                              | [View Map](src/domain/codemap.md)                    |
| `src/domain/compression/`        | Block construction, range resolution, exact metadata, supersession, v2 materialization scaffold               | [View Map](src/domain/compression/codemap.md)        |
| `src/domain/pruning/`            | Active runtime pruning: block application, atomic repair, dedup, error purge, ID injection                    | [View Map](src/domain/pruning/codemap.md)            |
| `src/domain/transcript/`         | Canonical snapshot builder: source items, spans, logical turns, live owner keys                               | [View Map](src/domain/transcript/codemap.md)         |
| `src/domain/provider/`           | Provider-payload stale artifact filtering via canonical owner keys                                            | [View Map](src/domain/provider/codemap.md)           |
| `src/domain/refs/`               | Visible ref parsing/formatting (`mNNNN`, `bN`) and DCP metadata stripping                                     | [View Map](src/domain/refs/codemap.md)               |
| `src/domain/tokens/`             | Token estimation (gpt-tokenizer + chars/4 fallback)                                                           | [View Map](src/domain/tokens/codemap.md)             |
| `src/domain/nudge/`              | Nudge type decision helpers (thin re-export from pruning)                                                     | [View Map](src/domain/nudge/codemap.md)              |
| `src/infrastructure/`            | Side effects: JSONC config loading, JSONL debug logging, persisted-state contract                             | [View Map](src/infrastructure/codemap.md)            |
| `src/prompts/`                   | System prompt additions, compress tool contract text, nudge text                                              | [View Map](src/prompts/codemap.md)                   |
| `src/types/`                     | Config, state, message, and API boundary types                                                                | [View Map](src/types/codemap.md)                     |
| `scripts/`                       | Capture-only HTTP proxy for LLM traffic debugging                                                             | [View Map](scripts/codemap.md)                       |

## Architecture

### Layer Rules

- **Domain** (`src/domain/`) — pure business logic. Must not import `@mariozechner/pi-coding-agent`, filesystem utilities, config loading, debug logging, or application handlers.
- **Application** (`src/application/`) — adapts pi/provider payloads, wires hooks, delegates pure decisions to domain.
- **Infrastructure** (`src/infrastructure/`) — owns side effects: config files, persisted-state, JSONL debug logging.
- **Compatibility shims** (`src/*.ts`) — thin re-exports for older import paths; new code uses layered paths.

### Event Processing Pipeline

```
session_start / session_tree
    └─ restoreStateFromBranch() → deserialize persisted dcp-state

before_agent_start
    └─ inject SYSTEM_PROMPT or MANUAL_MODE_SYSTEM_PROMPT

tool_call / tool_result
    └─ populate state.toolCalls (toolCallId → ToolRecord)

context ← main transform
    ├─ buildTranscriptSnapshot() + buildLiveOwnerKeys()
    ├─ materializeContextMessages() — v2 span-key or v1 legacy dispatch
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
    └─ saveState() → append "dcp-state" custom session entry
```

## Key Invariants

1. Assistant + tool-result pairs removed **atomically** (`expandCompressionIndexRange` + repair safety net)
2. Prefer exact coverage metadata (`coveredSourceKeys`/`coveredSpanKeys`) over timestamp fallback; timestamp fallback for legacy blocks only
3. Visible IDs (`mNNNN`, `bN`) and internal canonical owner keys are separate layers — owner tags must not be rendered into model-visible content
4. Supersession allowed only for exact full coverage — partial ambiguous overlap conservatively rejects
5. Hot-tail protection counts **logical turns**, not raw message count
6. Saved-token accounting must be stable across repeated renders — `state.tokensSaved` is current net savings, not lifetime total
7. Bucket-gated dedup/purge: additions to `prunedToolIds` happen only at turn-bucket boundaries (`floor(currentTurn/N)*N`)

## Design Patterns

| Pattern                        | Usage                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| Hook-based pipeline            | pi extension hooks chain together; shared state via closures                             |
| Canonical transcript           | `buildTranscriptSnapshot` builds immutable snapshot for liveness derivation              |
| Exact metadata over timestamps | `coveredSourceKeys`/`coveredSpanKeys` preferred; timestamps for legacy fallback only     |
| Deterministic activity log     | `CompressionLogEntry[]` in block summaries — reproducible across renders                 |
| Fingerprint dedup              | `createInputFingerprint()` — `toolName::JSON(sortedArgs)` for stable dedup               |
| Bucket-gated tombstones        | `prunedToolIds` additions gated by `floor(currentTurn / pruneCadenceTurns) * N`          |
| Two-phase provider filtering   | newest represented compress → receipt; older represented pairs suppressed                |
| Auto-trigger with queue drain  | `pendingAutoRequests` queue drained atomically at `turn_end` to prevent cancel loops     |
| Lifetime realized savings      | `lifetimeTokensSavedRealized` accumulates savings from native-compaction-absorbed blocks |

## Integration

- **Consumed by**: pi coding agent (via ExtensionAPI)
- **Depends on**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`, `jsonc-parser`, `gpt-tokenizer`
- **Exports**: Default extension function from `src/index.ts`
