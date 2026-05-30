# `src/application/` — Codemap

## Responsibility

`src/application/` contains the **orchestration layer** of the DCP extension. It wires pi event hooks, registers tools and commands, adapts host payloads, and delegates pure decisions to domain modules. No business logic lives here — only event routing, payload transformation, and delegation to `src/domain/` and `src/infrastructure/`.

## Subdirectories and Files

### `commands/dcp.ts`

Registers the `/dcp` slash command with subcommands: `context`, `stats`, `compact`, `help`.

- **`/dcp context`** — reads `ctx.getContextUsage()` and prints token/percentage breakdown plus session stats.
- **`/dcp stats`** — prints active/total compression blocks, tokens saved, and total prune count.
- **`/dcp compact`** — calls `triggerDcpNativeCompaction(ctx, state, "command")` to invoke pi-native session compaction.
- **`/dcp help`** — prints the current command surface.

### `compress-tool/`

Thin wrapper around `src/domain/compression/tooling.js`. Exports everything re-exported from `tooling.js` plus the three source files below.

- **`index.ts`** — re-exports `artifacts`, `registration`, and `validation`.
- **`registration.ts`** — calls `pi.registerTool` for the `compress` tool. Full `execute` callback: validates boundaries via domain tooling, resolves timestamps/source-keys, enforces protected-tail (with emergency override), builds `CompressionBlock` objects with coverage metadata, deactivates superseded blocks, sets `pendingSave`, updates compress/nudge watermarks, estimates creation savings, runs `decideNativeCompactionAutoTrigger()` (passthrough roles excluded from LLM message counts), and returns post-compress planning hints in the tool response.
- **`validation.ts`** — re-exports from `domain/compression/tooling.js`. Contains `validateCompressionRangeBoundaryIds` and related helpers.
- **`artifacts.ts`** — re-exports from `domain/compression/tooling.js`. Contains `buildCompressionArtifactsForRange`, `buildCompressionPlanningHints`, `expandBlockPlaceholders`, `renderCompressionPlanningHints`.

### `context-handler.ts`

Registers the `context` event hook (`pi.on("context", ...)`). The handler:

1. Calls `materializeContextMessages` to apply active block materialization and pruning.
2. Calls `ctx.getContextUsage()` and estimates rendered-message tokens locally.
3. Calls `resolveEffectiveContextSize(hostTokens, dcpEstimatedTokens, contextWindow)`, using `max(hostTokens, dcpEstimatedTokens)` so nudges resist host under-reporting after resume.
4. Calls `getNudgeType` with the effective context size to decide whether to emit a DCP reminder nudge.
5. If a nudge fires, builds `ReminderIntent` (source `"dcp"`, id `"nudge"`, ttl `"once"`) and emits it via `REMINDER_UPSERT_EVENT`.
6. Stores `state.lastRenderedMessages` and `state.lastLiveOwnerKeys` for the provider-payload filter.
7. Updates the pi status footer via `updateDcpStatus`.
8. Writes a `context_evaluated` debug log entry.

Exported helper: `materializeContextMessages` — dispatches to v2 materialization path when active V2 blocks exist, otherwise falls through to the legacy `applyPruning` path.

### `native-compaction.ts`

Integrates DCP state with pi's native session-compaction lifecycle via `session_before_compact` and `session_compact` event hooks, plus `turn_end` for auto-trigger.

**`session_before_compact` hook** — checks DCP hidden coverage ratio against `config.nativeCompaction.minHiddenCoverageRatio`. If sufficient, calls `buildDcpNativeCompactionResult` which:

- Resolves which hidden messages are covered by active DCP blocks.
- Builds a tiered summary: recent `renderFullBlockCount` blocks rendered in full `<section>` XML; older `renderCompactBlockCount` as compact snippets; oldest as an `<archived-sections>` bullet list.
- Includes uncovered hidden messages as raw excerpt text.
- Strips and token-caps any prior DCP envelope from `previousSummary` to avoid nesting.
- Returns a `CompactionResult` that pi uses as `customInstructions` for the compaction prompt.

**`session_compact` hook** — fires when pi commits a compaction. Deactivates all represented blocks, moves their `savedTokenEstimate` into `state.lifetimeTokensSavedRealized` (so the footer total never regresses), resets `lastCompressTurn`/`lastNudgeTurn` to `-1` (post-compaction turn count is smaller), saves state, and updates the footer.

**`turn_end` hook** — drains the `pendingAutoRequests` queue set by `decideNativeCompactionAutoTrigger`. If compaction completed and no user input is pending, sends a continuation prompt telling the agent to continue with the task using the compaction summary.

**`triggerDcpNativeCompaction`** — the public entry point used by `/dcp compact` and the auto-trigger path. Calls `ctx.compact()` and returns a promise.

### `provider-handler.ts`

Registers the `before_provider_request` event hook. Calls `filterProviderPayloadInput` from `src/domain/provider/payload-filter.js` to prune stale `reasoning`, `function_call`, and `function_call_output` artifacts from the provider request payload using canonical owner keys and the latest live owner map. Writes a `provider_payload_filtered` debug log entry when any items were removed.

### `session-handler.ts`

Registers session lifecycle hooks (`session_start`, `session_tree`, `session_shutdown`, `agent_end`) and exposes `saveState` / `restoreStateFromBranch`.

- **`session_start` / `session_tree`** — calls `restoreStateFromBranch()`:
  - Runs a single direct-restore path: `resetState(state)` + `initializeSessionState(state, config)`.
  - If `findLatestCoverageBearingDcpStateEntry(branchEntries)` finds v1/v5 coverage, `restorePersistedState()` restores full block state plus scalars directly (`restoredStateEntries = 1`).
  - Otherwise `findLatestDcpStateEntry(branchEntries)` + `restorePersistedStateScalars()` restores scalar continuity only (`prunedToolIds`, turn watermarks, `lifetimeTokensSavedRealized`) and never resurrects blocks.
  - Always finishes with `repairOffBranchNativeCompactionState()` and `repairStaleNudgeWatermarks()`.
- **`session_shutdown` / `agent_end`** — calls `saveState()` when `state.pendingSave` is true. Guarded by `ctx.hasUI` (skip in `-p` print mode).
- **`saveState`** — no-op when `!pendingSave`; otherwise `pi.appendEntry("dcp-state", serializePersistedState(state))` and clears the dirty flag.
- **`restoreStateFromBranch`** — returns `RestoreStateFromBranchResult` with `mode: "persisted"` plus repair metadata. The mode name identifies the single restore path; it is not a success claim.

### `status.ts`

Exposes `updateDcpStatus` (writes the pi footer status) and `buildDcpStatusText` / `computeDisplayedTokensSaved`.

- **Displayed tokens** = `max(0, state.tokensSaved + state.lifetimeTokensSavedRealized)`. `lifetimeTokensSavedRealized` accumulates savings from blocks absorbed by native compaction, so the footer never regresses after compaction.
- **Status text** format: `DCP N saved N prunes bX`.

### `system-prompt-handler.ts`

Registers the `before_agent_start` event hook. Appends `SYSTEM_PROMPT` (from `src/prompts/`) to the agent's system prompt.

### `tool-recording.ts`

Registers `tool_call` and `tool_result` event hooks. On `tool_call`, inserts a `ToolRecord` into `state.toolCalls` (input fingerprint, turn index). On `tool_result`, updates the existing record (isError, timestamp, token estimate) or creates a new orphan record. These records feed deduplication and error-purging decisions in `src/domain/pruning/`.

## Key Patterns

### Event-hook orchestration

Every handler is registered once at extension startup and receives the shared `state` and `config` closures. No handler mutates another handler's state; all shared mutations go through `DcpState` or domain functions.

### Domain delegation

Application layer never contains compression overlap logic, liveness computation, or nudge decision rules. All of those live in `src/domain/` and are called by name from the application layer.

### Two-phase state management

- **Runtime state** lives in `DcpState` (in-memory, mutated per event).
- **Dirty-flag persistence** — mutation sites set `pendingSave = true`; `saveState()` serializes only when dirty (v3 scalar marker when block-less, v5 coverage-bearing block state otherwise).
- **Direct restore** — `restoreStateFromBranch()` always uses the single direct-restore path: latest coverage-bearing v1/v5 entry restores full blocks plus scalars; otherwise the latest `dcp-state` entry restores scalars only.

### Direct restore on session lifecycle

`session_start` and `session_tree` restore from persisted entries before any context pass. The `context` hook never triggers replay. `replayDcpState` remains in `src/domain/replay/` for offline scripts and tests only, not as a live runtime persistence path.

### Materialization dispatch

`materializeContextMessages` is the single dispatch point for current legacy block materialization and always uses the v1 pruning path.

### Native compaction as a bridge

`native-compaction.ts` is the only place that reads `event.branchEntries` directly and calls `ctx.compact()`. It translates DCP block state into a pi `CompactionResult`, then reacts to the compaction commitment to update `DcpState` accordingly.

### Provider payload filtering is decoupled from transcript rendering

`provider-handler.ts` runs after `context-handler.ts` has stored `state.lastLiveOwnerKeys`. It operates only on the provider request payload, not the transcript. This ensures hidden/provider artifact pruning does not interfere with rendered message IDs.

### Auto-trigger with queue draining

Native compaction auto-trigger queues a request via `queueDcpAutoNativeCompaction`. The `turn_end` hook consumes the queue atomically (delete before `await`) to prevent cancel/retry loops.

## Hook Map

| Hook                      | Handler module             | Key responsibilities                                              |
| ------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `session_start`           | `session-handler.ts`       | `restoreStateFromBranch()` — single direct-restore path           |
| `session_tree`            | `session-handler.ts`       | same direct-restore path as `session_start`                       |
| `session_shutdown`        | `session-handler.ts`       | `saveState()` when `pendingSave` (v3/v5 persisted state)          |
| `agent_end`               | `session-handler.ts`       | `saveState()` when `pendingSave` (v3/v5 persisted state)          |
| `context`                 | `context-handler.ts`       | materialize, resolve effective context size, nudge, footer update |
| `before_agent_start`      | `system-prompt-handler.ts` | append DCP system prompt                                          |
| `before_provider_request` | `provider-handler.ts`      | filter stale provider artifacts                                   |
| `session_before_compact`  | `native-compaction.ts`     | build compaction result from active blocks                        |
| `session_compact`         | `native-compaction.ts`     | deactivate represented blocks, bake savings, reset watermarks     |
| `turn_end`                | `native-compaction.ts`     | drain `pendingAutoRequests`, continue after auto-compaction       |
| `tool_call`               | `tool-recording.ts`        | insert `ToolRecord` into `state.toolCalls`                        |
| `tool_result`             | `tool-recording.ts`        | update/create `ToolRecord`                                        |

## Integration Points

| Source                                          | Target                                  | Direction | Purpose                                                                                  |
| ----------------------------------------------- | --------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `src/application/context-handler.ts`            | `src/domain/pruning/`                   | calls     | `applyPruning`, `exceedsMaxContextLimit`, `getNudgeType`, `finalizeMaterializedMessages` |
| `src/application/context-handler.ts`            | `src/domain/compression/tooling.ts`     | calls     | `buildCompressionPlanningHints`, `renderCompressionPlanningHints`                        |
| `src/application/context-handler.ts`            | `src/domain/transcript/`                | calls     | `buildTranscriptSnapshot`, `buildLiveOwnerKeys`                                          |
| `src/application/context-handler.ts`            | `src/infrastructure/debug-log.js`       | calls     | `appendDebugLog`, `buildSessionDebugPayload`                                             |
| `src/application/context-handler.ts`            | `src/application/status.ts`             | calls     | `updateDcpStatus`                                                                        |
| `src/application/provider-handler.ts`           | `src/domain/provider/payload-filter.ts` | calls     | `filterProviderPayloadInput`                                                             |
| `src/application/session-handler.ts`            | `src/state.ts`                          | calls     | `createState`, `resetState`                                                              |
| `src/application/session-handler.ts`            | `src/infrastructure/persistence.ts`     | calls     | `serializePersistedState`, `restorePersistedState`, `restorePersistedStateScalars`       |
| `src/application/session-handler.ts`            | `src/application/status.ts`             | calls     | `updateDcpStatus`                                                                        |
| `src/application/session-handler.ts`            | `src/infrastructure/debug-log.js`       | calls     | `appendDebugLog`, `buildSessionDebugPayload`                                             |
| `src/application/native-compaction.ts`          | `src/domain/compression/materialize.ts` | calls     | `renderCompressedBlockText`                                                              |
| `src/application/native-compaction.ts`          | `src/domain/transcript/`                | calls     | `buildTranscriptSnapshot`                                                                |
| `src/application/native-compaction.ts`          | `src/application/session-handler.ts`    | calls     | `saveState`                                                                              |
| `src/application/native-compaction.ts`          | `src/application/status.ts`             | calls     | `updateDcpStatus`                                                                        |
| `src/application/compress-tool/registration.ts` | `src/domain/compression/tooling.ts`     | calls     | all tooling helpers, validation, artifacts, planning hints                               |
| `src/application/compress-tool/registration.ts` | `src/domain/compression/materialize.ts` | calls     | `renderCompressedBlockMessage`                                                           |
| `src/application/compress-tool/registration.ts` | `src/domain/pruning/`                   | calls     | `exceedsMaxContextLimit`                                                                 |
| `src/application/compress-tool/registration.ts` | `src/domain/transcript/`                | calls     | `buildTranscriptSnapshot`, `resolveLogicalTurnTailStartTimestamp`                        |
| `src/application/compress-tool/registration.ts` | `src/application/status.ts`             | calls     | `updateDcpStatus`                                                                        |
| `src/application/compress-tool/registration.ts` | `src/application/native-compaction.ts`  | calls     | `queueDcpAutoNativeCompaction`                                                           |
| `src/application/commands/dcp.ts`               | `src/application/status.ts`             | calls     | `computeDisplayedTokensSaved`, `updateDcpStatus`                                         |
| `src/application/commands/dcp.ts`               | `src/application/native-compaction.ts`  | calls     | `triggerDcpNativeCompaction`                                                             |
| `src/application/system-prompt-handler.ts`      | `src/prompts/system.js`                 | imports   | `SYSTEM_PROMPT`                                                                          |
| `src/application/tool-recording.ts`             | `src/state.ts`                          | calls     | `createInputFingerprint`                                                                 |
| `src/application/tool-recording.ts`             | `src/domain/tokens/estimate.ts`         | calls     | `estimateTokens`                                                                         |
| `src/application/status.ts`                     | `src/types/state.ts`                    | imports   | `DcpState` type                                                                          |
| `src/application/context-handler.ts`            | `@mariozechner/pi-coding-agent`         | pi API    | registers `context` hook, emits `REMINDER_UPSERT_EVENT`                                  |
| `src/application/provider-handler.ts`           | `@mariozechner/pi-coding-agent`         | pi API    | registers `before_provider_request` hook                                                 |
| `src/application/session-handler.ts`            | `@mariozechner/pi-coding-agent`         | pi API    | registers `session_start/tree/shutdown/agent_end` hooks                                  |
| `src/application/system-prompt-handler.ts`      | `@mariozechner/pi-coding-agent`         | pi API    | registers `before_agent_start` hook                                                      |
| `src/application/native-compaction.ts`          | `@mariozechner/pi-coding-agent`         | pi API    | registers `session_before_compact/session_compact/turn_end` hooks                        |
| `src/application/native-compaction.ts`          | `ExtensionContext`                      | pi API    | calls `ctx.compact()`                                                                    |
| `src/application/compress-tool/registration.ts` | `@mariozechner/pi-coding-agent`         | pi API    | calls `pi.registerTool()`                                                                |
| `src/application/commands/dcp.ts`               | `@mariozechner/pi-coding-agent`         | pi API    | calls `pi.registerCommand()`                                                             |
| `src/application/tool-recording.ts`             | `@mariozechner/pi-coding-agent`         | pi API    | registers `tool_call/tool_result` hooks                                                  |
