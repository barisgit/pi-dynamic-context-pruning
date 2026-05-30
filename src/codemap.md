# DCP Source Code Map

## Responsibility

Dynamic Context Pruning (DCP) is a pi coding-agent extension that manages the conversation context window by compressing older transcript sections into citable `bN` block summaries, pruning stale tool outputs, and filtering hidden provider-payload history. It operates as a pipeline from raw pi session events through domain-level transformations to rendered context output and persisted state.

The extension lives entirely in `src/` as TypeScript/ESM — pi loads `.ts` files directly with no build step. The runtime is Node.js inside pi; the dev/test toolchain is Bun.

---

## Design

### Layer architecture

| Layer              | Location              | Rule                                                            |
| ------------------ | --------------------- | --------------------------------------------------------------- |
| **Domain**         | `src/domain/`         | Pure logic, no pi/provider/FS imports                           |
| **Application**    | `src/application/`    | Wires pi hooks, adapts payloads, delegates to domain            |
| **Infrastructure** | `src/infrastructure/` | Side effects: config files, JSONL debug logs, state persistence |
| **Types**          | `src/types/`          | Shared contracts (state, config, message, API)                  |
| **Prompts**        | `src/prompts/`        | System-prompt additions, tool descriptions, nudge text          |

Domain modules must not import from `@mariozechner/pi-coding-agent`, filesystem utilities, config loading, or application handlers. Application modules adapt pi/provider payloads and delegate pure decisions to domain modules.

### State model

`DcpState` is the single mutable runtime object. It holds:

- `toolCalls: Map<toolCallId, ToolRecord>` — bookkeeping for dedup/error purging
- `prunedToolIds: Set<toolCallId>` — tombstones applied each context pass
- `compressionBlocks: CompressionBlock[]` — **active runtime path** (legacy timestamp-backed blocks)
- `compressionBlocksV2: CompressionBlockV2[]` — inert scaffolding/deferred-dead code; only reachable through never-written legacy schema v2
- `messageAliases` / `messageRefSnapshot` / `messageOwnerSnapshot` — stable visible-ref bookkeeping
- `currentTurn`, `tokensSaved`, `lastNudgeTurn`, `lastCompressTurn` — session metrics and debounce watermarks
- `pendingSave: boolean` — dirty flag; mutation sites (compress success, prune tombstones, native-compaction commit) set it; `saveState()` no-ops when false

On disk, `serializePersistedState()` writes **v3** (scalar-only marker) when no blocks exist, or **v5** (scalars + active blocks with full coverage anchors, finite timestamps, and `nextBlockId`) once blocks exist. v5 is the first correct direct-restore shape; v4 is legacy lossy read back-compat only and is no longer written.

### Persistence model (direct-restore + v5 coverage)

`session_start` / `session_tree` restore via one `restoreStateFromBranch()` → `directRestore()` path. `RestoreMode` is exactly `"persisted"` (the path name, not a success assertion):

1. Reset and initialize runtime state with `resetState()` + `initializeSessionState()`.
2. Latest coverage-bearing `dcp-state` entry (v1/v2/v5): `restorePersistedState()` restores full block state plus scalar continuity directly (`restoredStateEntries = 1`).
3. No coverage-bearing entry: latest `dcp-state`, if any, restores scalar continuity only via `restorePersistedStateScalars()` (`prunedToolIds`, turn watermarks, `lifetimeTokensSavedRealized`); blocks stay empty, safe for lossy legacy v4.
4. Finish with `repairOffBranchNativeCompactionState()` and `repairStaleNudgeWatermarks()`.

`replayDcpState()` is retained for offline scripts (`scripts/replay-equivalence.ts`, `scripts/vacuum-dcp-session.ts`) and `tests/unit/replay.test.ts`; it is not a live restore path.

`saveState()` appends a `dcp-state` entry only when `state.pendingSave` is true (avoids hundreds-of-MB JSONL growth from per-turn `agent_end` writes). `session_compact` deactivates represented blocks and adjusts watermarks.

### Turn model

A **logical turn** is one standalone visible message, or one assistant tool-call batch grouped with its matching `toolResult`/`bashExecution` messages. Turn counting drives hot-tail protection, nudge debouncing, and error-purge eligibility — not raw message count.

### Ownership vs. visibility

Visible IDs (`m0001`, `bN`) are agent-facing boundaries only. Canonical owner keys (`s0`, `block:b1`) are internal runtime bookkeeping. `src/domain/provider/payload-filter.ts` uses owner keys — never rendered text patterns — to decide what hidden provider-payload history to suppress.

### Nudge strategy

Nudges fire from the `context` hook when context usage exceeds `minContextPercent` (or `minContextTokens`), at least `nudgeDebounceTurns` logical turns have passed since the last nudge, not in the same turn as a compress, and not immediately post-compress. Nudge types: `context-strong` (hard emergency), `context-soft` (soft emergency), `iteration` (long tool run), `turn` (periodic). Planning hints surface safe candidate ranges, protected tail start, and protected IDs.

### Native compaction bridge

On `session_before_compact`, DCP computes DCP-hidden coverage ratio; if above `minHiddenCoverageRatio`, it renders tiered block summaries into an envelope and returns a `CompactionResult`. On `session_compact`, it deactivates represented blocks and resets nudge debounce watermarks.

---

## Directory Structure

```text
src/
├── index.ts                     # Extension entry point — wires all registrations
├── state.ts                     # DcpState factory, reset, input fingerprint
├── types/
│   ├── state.ts                 # DcpState, CompressionBlock (v1), CompressionBlockV2 (scaffold),
│   │                              ToolRecord, PersistedDcpStateV3/V5, pendingSave
│   ├── config.ts                # DcpConfig shape
│   ├── message.ts               # DcpMessage, DcpContentPart normalized shapes
│   └── api.ts                   # Host/provider boundary types (DcpMessageEvent, etc.)
├── domain/
│   ├── pruning/
│   │   └── index.ts             # applyPruning, applyCompressionBlocks, deduplication,
│   │                              error purging, tool-output pruning, message ID injection,
│   │                              nudge type decision, hot-tail helpers
│   ├── compression/
│   │   ├── index.ts             # Re-exports
│   │   ├── materialize.ts       # renderCompressedBlockText/Message (shared v1/v2),
│   │   │                          materializeTranscript (v2 scaffolding)
│   │   ├── range.ts            # expandCompressionIndexRange, resolveCompressionRangeIndices
│   │   ├── tooling.ts          # buildCompressionPlanningHints, resolveIdToTimestamp,
│   │   │                          resolveSupersededBlockIdsForRange, expandBlockPlaceholders,
│   │   │                          buildCompressionArtifactsForRange, protected-tail helpers
│   │   └── metadata.ts          # createEmptyCompressionBlockMetadata
│   ├── transcript/
│   │   └── index.ts             # TranscriptSnapshot, TranscriptSpan, TranscriptSourceItem;
│   │                              buildTranscriptSnapshot, buildLiveOwnerKeys,
│   │                              countLogicalTurns, resolveLogicalTurnTailStartTimestamp,
│   │                              resolveCompressionBlockCoveredSourceKeys,
│   │                              buildSourceItemKey / buildSourceOwnerKey / buildBlockOwnerKey
│   ├── refs/
│   │   ├── index.ts             # parseVisibleRef, formatMessageRef, formatBlockRef,
│   │   │                          allocateMessageRef, MessageAliasState, normalize/serialize
│   │   └── metadata.ts          # stripDcpMetadataTags, stripDcpHallucinationsFromString
│   ├── provider/
│   │   └── payload-filter.ts   # filterProviderPayloadInput — stale artifact suppression
│   │                              using canonical owner keys; compress receipt minification
│   ├── nudge/
│   │   └── index.ts             # Re-exports getNudgeType from pruning
│   ├── replay/
│   │   └── index.ts             # replayDcpState — offline-only reconstruction for
│   │                              replay-equivalence/vacuum scripts and tests
│   └── tokens/
│       └── estimate.ts          # estimateTokens, estimateMessageTokens via gpt-tokenizer
├── application/
│   ├── context-handler.ts       # registerContextHandler — context hook, nudge emission,
│   │                              materializeContextMessages dispatch (v1/v2)
│   ├── session-handler.ts       # registerSessionHandlers, restoreStateFromBranch,
│   │                              saveState — direct restore; dirty-flag persistence
│   ├── provider-handler.ts       # registerProviderHandler — before_provider_request hook,
│   │                              calls payload-filter
│   ├── compress-tool/
│   │   ├── index.ts             # Re-exports
│   │   ├── registration.ts      # registerCompressTool — execute, post-compress hints,
│   │   │                          passthrough-aware native-compaction auto-trigger
│   │   ├── validation.ts       # resolveAnchorSourceKey, resolveIdToTimestamp, etc.
│   │   └── artifacts.ts         # buildCompressionPlanningHints, expandBlockPlaceholders,
│   │                              buildCompressionArtifactsForRange, supersession helpers
│   ├── commands/
│   │   └── dcp.ts               # registerCommands — /dcp help|context|stats|compact
│   ├── native-compaction.ts     # registerDcpNativeCompactionBridge — session_before_compact,
│   │                              session_compact, turn_end hooks; buildDcpNativeCompactionResult,
│   │                              triggerDcpNativeCompaction, queueDcpAutoNativeCompaction
│   ├── system-prompt-handler.ts # registerSystemPromptHandler — before_agent_start hook,
│   │                              appends SYSTEM_PROMPT
│   ├── tool-recording.ts        # registerToolRecordingHandlers — tool_call / tool_result hooks,
│   │                              populates state.toolCalls
│   └── status.ts                # updateDcpStatus, buildDcpStatusText, computeDisplayedTokensSaved
├── infrastructure/
│   ├── config.ts                # loadConfig — merges defaults, global ~/.pi/agent/dcp.jsonc,
│   │                              $PI_CONFIG_DIR/dcp.jsonc, project .pi/dcp.jsonc
│   ├── debug-log.ts             # appendDebugLog, buildSessionDebugPayload, DEBUG_LOG_PATH
│   └── persistence.ts           # serializePersistedState, restorePersistedState,
│                                  restorePersistedStateScalars, legacy serializers
├── prompts/
│   ├── index.ts                 # SYSTEM_PROMPT, COMPRESS_RANGE_DESCRIPTION
│   ├── system.ts                # Re-exports SYSTEM_PROMPT
│   └── compress-tool.ts         # Re-exports COMPRESS_RANGE_DESCRIPTION
```

---

## Key Files

### Entry point

| File           | Role                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | Wires all `register*` calls. Loads config, creates state, registers tools/commands/session hooks/provider handler/context handler. |

### State and config

| File                                | Role                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/state.ts`                      | `createState()`, `resetState()` (includes `pendingSave`), `createInputFingerprint()`. Exported types re-exported from `types/state.ts`.                                           |
| `src/types/state.ts`                | `DcpState`, `CompressionBlock` (v1), inert `CompressionBlockV2` scaffold, `ToolRecord`, `PersistedDcpStateV3/V5`.                                                                 |
| `src/types/config.ts`               | `DcpConfig` — all knobs: thresholds, cadence, rendering, native-compaction, strategies.                                                                                           |
| `src/types/message.ts`              | `DcpMessage` normalized shape; `DcpContentPart` union.                                                                                                                            |
| `src/infrastructure/config.ts`      | `loadConfig()` — layered merge of defaults + global + env + project configs.                                                                                                      |
| `src/infrastructure/persistence.ts` | `serializePersistedState()` (v3 empty / v5 with coverage-bearing blocks), `restorePersistedState()`, `restorePersistedStateScalars()`, legacy v1/v2 serializers for tests/vacuum. |

### Core domain

| File                                    | Role                                                                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/pruning/index.ts`           | `applyPruning()` — the main transform. Calls `applyCompressionBlocks`, `repairOrphanedToolPairs`, `applyDeduplication`, `applyErrorPurging`, `applyToolOutputPruning`, `injectMessageIds`. Also exports `getNudgeType()`, `exceedsMaxContextLimit()`. |
| `src/domain/compression/range.ts`       | `expandCompressionIndexRange()`, `resolveCompressionRangeIndices()`. Atomic assistant+tool-result expansion rules.                                                                                                                                    |
| `src/domain/compression/materialize.ts` | `renderCompressedBlockText()`, `renderCompressedBlockMessage()` (shared v1/v2). `materializeTranscript()` — v2 span-key materialization scaffold.                                                                                                     |
| `src/domain/compression/tooling.ts`     | Planning hints with passthrough-span absorption; boundary validation for refs inside compressed blocks; `resolveSupersededBlockIdsForRange()`, `buildCompressionArtifactsForRange()`, protected-tail helpers.                                         |
| `src/domain/transcript/index.ts`        | `buildTranscriptSnapshot()` — source items + tool-exchange spans. `buildLiveOwnerKeys()`, `countLogicalTurns()`, `resolveLogicalTurnTailStartTimestamp()`. `buildSourceItemKey()`, `buildSourceOwnerKey()`, `buildBlockOwnerKey()`.                   |
| `src/domain/refs/index.ts`              | `parseVisibleRef()`, `formatMessageRef()`, `formatBlockRef()`, `allocateMessageRef()`. `MessageAliasState`, `MessageRefSnapshotEntry`.                                                                                                                |
| `src/domain/provider/payload-filter.ts` | `filterProviderPayloadInput()` — canonical owner-key-based stale artifact suppression in provider payload. Minifies represented compress success artifacts.                                                                                           |
| `src/domain/replay/index.ts`            | `replayDcpState()` — offline-only reconstruction for replay-equivalence/vacuum tooling and replay tests. Walks entries, rebuilds compress blocks, deactivates compacted blocks, finalizes via `applyPruning()`.                                       |
| `src/domain/tokens/estimate.ts`         | `estimateTokens()`, `estimateMessageTokens()` via gpt-tokenizer with chars/4 fallback.                                                                                                                                                                |

### Application orchestration

| File                                            | Role                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/application/context-handler.ts`            | `registerContextHandler()`. The `context` event handler — calls `materializeContextMessages`, applies pruning, emits nudges via `REMINDER_UPSERT_EVENT`.                  |
| `src/application/session-handler.ts`            | `registerSessionHandlers()`, `restoreStateFromBranch()`, `saveState()`. Single direct-restore path (`mode: "persisted"`); dirty-flag persistence.                         |
| `src/application/compress-tool/registration.ts` | `registerCompressTool()`. Tool schema, `execute()` body, passthrough-aware native-compaction auto-trigger, post-compress planning hints, sets `pendingSave`.              |
| `src/application/native-compaction.ts`          | `registerDcpNativeCompactionBridge()`. `session_before_compact`, `session_compact`, `turn_end` hooks. `buildDcpNativeCompactionResult()`, `triggerDcpNativeCompaction()`. |
| `src/application/commands/dcp.ts`               | `registerCommands()`. `/dcp help`, `/dcp context`, `/dcp stats`, `/dcp compact`.                                                                                          |
| `src/application/provider-handler.ts`           | `registerProviderHandler()`. `before_provider_request` hook — calls `filterProviderPayloadInput()`.                                                                       |
| `src/application/tool-recording.ts`             | `registerToolRecordingHandlers()`. `tool_call` / `tool_result` hooks — populates `state.toolCalls`.                                                                       |
| `src/application/system-prompt-handler.ts`      | `registerSystemPromptHandler()`. `before_agent_start` hook — appends system prompt addition.                                                                              |
| `src/application/status.ts`                     | `updateDcpStatus()`, `buildDcpStatusText()`, `computeDisplayedTokensSaved()`. Pi footer status integration.                                                               |

### Prompts

| File                   | Role                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `src/prompts/index.ts` | `SYSTEM_PROMPT`, `COMPRESS_RANGE_DESCRIPTION`. All prompt text in one place. |

### Infrastructure

| File                              | Role                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/infrastructure/debug-log.ts` | `appendDebugLog()`, `buildSessionDebugPayload()`, `DEBUG_LOG_PATH`. Best-effort JSONL to `~/.pi/log/dcp.jsonl`. |

---

## Integration

### Pi extension lifecycle

```text
pi loads src/index.ts
  → loadConfig(cwd)
  → createState()
  → initializeSessionState(state, config)
  → registerCompressTool(pi, state, config)
  → registerCommands(pi, state, config)
  → registerSessionHandlers(pi, state, config)
  → registerDcpNativeCompactionBridge(pi, state, config)
  → registerSystemPromptHandler(pi, state)
  → registerToolRecordingHandlers(pi, state)
  → registerContextHandler(pi, state, config)
  → registerProviderHandler(pi, state, config)
```

### Event hooks

| Hook                      | Handler                    | Effect                                                                    |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `tool_call`               | `tool-recording.ts`        | Populates `state.toolCalls` for dedup/fingerprint                         |
| `tool_result`             | `tool-recording.ts`        | Updates `ToolRecord.isError`, `timestamp`, `tokenEstimate`                |
| `session_start`           | `session-handler.ts`       | Direct restore from latest coverage-bearing state, else scalar continuity |
| `session_tree`            | `session-handler.ts`       | Same direct restore path as `session_start`; branch switch                |
| `before_agent_start`      | `system-prompt-handler.ts` | Appends `SYSTEM_PROMPT`                                                   |
| `context`                 | `context-handler.ts`       | Materializes transcript, applies pruning, emits nudge reminders           |
| `before_provider_request` | `provider-handler.ts`      | Filters stale hidden artifacts from provider payload                      |
| `session_before_compact`  | `native-compaction.ts`     | Returns DCP `CompactionResult` if coverage threshold met                  |
| `session_compact`         | `native-compaction.ts`     | Deactivates represented blocks, adjusts watermarks, saves state           |
| `turn_end`                | `native-compaction.ts`     | Triggers queued auto-compaction, sends continuation prompt                |
| `session_shutdown`        | `session-handler.ts`       | Persists v3 marker or v5 block state when `pendingSave` is set            |
| `agent_end`               | `session-handler.ts`       | Persists v3 marker or v5 block state when `pendingSave` is set            |

### Data flow (active v1 runtime)

```text
session event messages
  → tool_recording (tool_call/tool_result)
  → context_handler
      → buildTranscriptSnapshot (canonical source items + tool-exchange spans)
      → buildLiveOwnerKeys (live owner set from active blocks + uncovered messages)
      → applyPruning (pruning/index.ts)
          → countLogicalTurns → state.currentTurn
          → applyCompressionBlocks (splice ranges, insert bN messages)
          → repairOrphanedToolPairs (safety net)
          → applyDeduplication (add to state.prunedToolIds)
          → applyErrorPurging (add to state.prunedToolIds)
          → applyToolOutputPruning (replace content of pruned tools)
          → injectMessageIds (dcp-id/dcp-owner tags, update snapshots)
      → getNudgeType (decide if reminder should fire)
      → emit REMINDER_UPSERT_EVENT (planning hints + nudge text)
  → before_provider_request
      → filterProviderPayloadInput (canonical owner-key filtering,
        compress receipt minification)
  → return { messages: prunedMessages }
```

### Restore / persistence flow

```text
session_start / session_tree → restoreStateFromBranch() → directRestore()
  → resetState() + initializeSessionState()
  → latest coverage-bearing dcp-state (v1/v2/v5)?
      YES → restorePersistedState() (full block state + scalars)
      NO  → latest dcp-state?
              YES → restorePersistedStateScalars() (scalar continuity only)
              NO  → keep initialized empty state
  → repairOffBranchNativeCompactionState() + repairStaleNudgeWatermarks()

compress success / prune / native_compaction → pendingSave = true
agent_end / session_shutdown → saveState() if pendingSave
  → no blocks: write v3 scalar marker
  → blocks exist: write v5 scalars + coverage-bearing blocks
```

### Key design patterns

1. **Direct-restore persistence** — coverage-bearing entries restore block state immediately; empty sessions write v3 scalar markers and block sessions write v5 coverage-bearing state.
2. **Canonical owner keys over visibility heuristics** — ownership is derived from exact source-key metadata, not rendered text patterns.
3. **Exact coverage metadata over timestamps** — new blocks persist `coveredSourceKeys`/`coveredSpanKeys`; timestamp fallback is for legacy blocks only.
4. **Atomic assistant+tool-result removal** — `expandCompressionIndexRange` expands ranges to always include the full tool batch before splicing.
5. **Bucket-based pruning cadence** — `prunedToolIds` additions are gated on `floor(currentTurn / N) * N`, so the rendered prefix is cache-stable between bucket boundaries.
6. **Supersession only for exact full coverage** — partial ambiguous overlap conservatively rejects; exact containment absorbs.
7. **Two-phase provider-payload filtering** — `filterProviderPayloadInput` keeps the newest live represented compress receipt and suppresses older pairs; unrepresented failed attempts stay visible.
8. **Turn-based debounce** — nudges debounce on logical turns, not raw `context` event frequency.
