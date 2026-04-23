# pi-dynamic-context-pruning / Repository Atlas

## Project Responsibility

A **pi coding agent extension** implementing Dynamic Context Pruning (DCP). DCP manages context window pressure through:

1. **Compression blocks** — Replace older conversation ranges with LLM-generated summaries
2. **Deduplication** — Remove redundant tool outputs with identical inputs
3. **Error purging** — Remove stale error outputs after N logical turns
4. **Nudge injection** — Prompt the agent to compress when context fills up

Runtime: Bun, ESM, TypeScript (no build step — pi loads `.ts` directly).

## System Entry Points

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point; registers all 8 hooks (numbered 1–12) and wires pruning/filtering/nudge logic |
| `config.ts` | JSONC config loading with 4-layer merge: defaults → global → PI_CONFIG_DIR → project-local |
| `pruner.ts` | Active runtime pruning path: compression block application, dedup, error purge, tool output replacement, message ID injection |
| `compress-tool.ts` | `compress` tool registration, range validation, exact metadata generation, supersession planning |

## Architecture

### Event Processing Pipeline

```
session_start
    ├─ resetState()
    └─ restorePersistedState() ← walks branch for dcp-state entries

before_agent_start
    └─ inject SYSTEM_PROMPT or MANUAL_MODE_SYSTEM_PROMPT

tool_call / tool_result
    └─ populate state.toolCalls Map (toolCallId → ToolRecord)

context ← main transform
    ├─ buildLiveOwnerKeys() from transcript.ts
    ├─ applyPruning()
    │   ├─ countLogicalTurns() → update state.currentTurn
    │   ├─ applyCompressionBlocks() — splice ranges, insert summaries
    │   ├─ repairOrphanedToolPairs() — safety net for atomic assistant+results removal
    │   ├─ applyDeduplication() — mark redundant tool outputs
    │   ├─ applyErrorPurging() — mark old error outputs
    │   ├─ applyToolOutputPruning() — replace pruned content
    │   └─ injectMessageIds() — inject mNNN + owner tags
    ├─ nudgeType = getNudgeType() — determine if nudge should fire
    └─ injectNudge() if warranted

before_provider_request
    └─ filterProviderPayloadInput() — prune stale reasoning/function_call from provider payload and suppress redundant successful compress artifacts already represented by live blocks

agent_end / session_shutdown
    └─ saveState() — serializePersistedState() → custom session entry
```

### State Types

| Type | Location | Purpose |
|------|----------|---------|
| `DcpState` | `state.ts` | Runtime state: toolCalls Map, compressionBlocks[], currentTurn, tokensSaved, etc. |
| `CompressionBlock` | `state.ts` | Legacy v1 block: timestamp-bounded range + summary, plus optional `compressCallId` for represented compress artifacts |
| `CompressionBlockV2` | `state.ts` | Draft v2 block: span-key bounded, exact metadata |
| `TranscriptSnapshot` | `transcript.ts` | Phase 1 scaffold: sourceItems[] + spans[] (message/tool-exchange) |

### Ownership Model

- **Visible IDs** (`mNNN`, `bN`) are agent-facing boundaries only
- **Canonical owner keys** (`s0`, `s1`, `block:b1`) are internal bookkeeping
- `dcp-owner` tag associates hidden provider artifacts with canonical source entities
- `payload-filter.ts` uses live owner keys from transcript + active blocks to prune stale `reasoning`, `function_call`, `function_call_output`

### Logical Turns

Definition:
- 1 standalone visible message = 1 turn
- 1 assistant tool-call message + matching tool results = 1 turn

Used by:
- `state.currentTurn` — monotonic counter
- Nudge debounce (`nudgeDebounceTurns`)
- Error-purge age (`ToolRecord.turnIndex`)
- Hot-tail protection (`protectRecentTurns`)

### Compression Block Lifecycle

1. **Creation** (`compress-tool.ts`): LLM calls `compress` tool with topic + ranges
2. **Validation**: Resolve IDs → timestamps, check for protected tail overlap, compute planning hints, check supersession
3. **Supersession**: Exact-full-coverage of older exact blocks → absorbed; partial overlap → rejected
4. **Persistence**: Block added to `state.compressionBlocks`, serialized to session entry, and now records the originating `compressCallId` when available
5. **Application** (`pruner.ts`): Each `context` pass resolves range indices, splices messages, inserts summary
6. **Restoration**: `/dcp decompress N` sets `block.active = false`

### Config Layers (loadConfig)

```
DEFAULT_CONFIG
  ↓ deepMerge
~/.config/pi/dcp.jsonc
  ↓ deepMerge
$PI_CONFIG_DIR/dcp.jsonc
  ↓ deepMerge
<project>/.pi/dcp.jsonc
```

### Key Invariants

1. Assistant + tool-result pairs removed **atomically** (pruner.ts has repair safety net)
2. Prefer exact coverage metadata (`coveredSourceKeys`/`coveredSpanKeys`) over timestamp fallback
3. Visible IDs (`mNNN`) and internal ownership are separate layers
4. Supersession only for exact full coverage — partial ambiguous overlap rejects
5. Hot-tail protection counts **logical turns**, not raw message count
6. Saved-token accounting stable across repeated renders (no double-counting)

## Design Patterns

| Pattern | Usage |
|---------|-------|
| **Hook-based pipeline** | pi extension hooks (`context`, `before_agent_start`, etc.) chain together |
| **Canonical transcript** | `transcript.ts` builds immutable snapshot used for liveness derivation |
| **Deterministic activity log** | `CompressionLogEntry[]` rendered in compressed blocks — reproducible across renders |
| **Fingerprint dedup** | `createInputFingerprint()` — `toolName::JSON(sortedArgs)` for stable dedup |
| **Deep merge config** | Arrays union-merged, objects recursively merged |

## Integration

- **Consumed by**: pi coding agent (via ExtensionAPI)
- **Depends on**: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox`, `jsonc-parser`
- **Exports**: Default extension function from `index.ts`

## Files (source only, excluding tests)

| File | Lines | Responsibility |
|------|-------|----------------|
| `index.ts` | ~300 | Extension entry, hook registration, state save/restore |
| `state.ts` | ~280 | Types, factory functions, fingerprinting |
| `pruner.ts` | ~400 | Active pruning pipeline, message ID injection, nudge logic |
| `transcript.ts` | ~220 | Canonical transcript snapshot, logical turns, live owner keys |
| `compress-tool.ts` | ~600 | Tool registration, range validation, metadata generation, supersession |
| `config.ts` | ~200 | JSONC loading, deep merge, config walk |
| `payload-filter.ts` | ~120 | Provider payload stale artifact filtering |
| `migration.ts` | ~200 | Persisted state normalization, v1↔v2 migration |
| `materialize.ts` | ~120 | Block rendering, v2 materialization scaffold |
| `commands.ts` | ~220 | `/dcp` slash commands (context, stats, sweep, manual, decompress, compress) |
| `prompts.ts` | ~150 | System prompt additions, compress tool description, nudge text |
| `debug-log.ts` | ~80 | Best-effort JSONL debug logging |
