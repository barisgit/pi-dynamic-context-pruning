# `src/application/` — Codemap

## Responsibility

`src/application/` contains the **orchestration layer** of the DCP extension. It wires pi event hooks, registers tools and commands, adapts host payloads, and delegates pure decisions to domain modules. No business logic lives here — only event routing, payload transformation, and delegation to `src/domain/` and `src/infrastructure/`.

## Subdirectories and Files

### `commands/dcp.ts`

Registers the `/dcp` slash command with subcommands: `context`, `stats`, `sweep`, `manual`, `decompress`, `compress`, `compact`, `help`.

- **`/dcp context`** — reads `ctx.getContextUsage()` and prints token/percentage breakdown plus session stats.
- **`/dcp stats`** — prints active/total compression blocks, tokens saved, total prune count, manual mode state.
- **`/dcp sweep [N]`** — walks the branch entries collecting `toolResult` IDs; adds the last N (or all since last user message) to `state.prunedToolIds`, respecting protected tool names (`compress`, `write`, `edit` + config).
- **`/dcp manual [on|off]`** — flips `state.manualMode` and updates the pi status footer.
- **`/dcp decompress [N]`** — lists active blocks or deactivates block `N`, recomputing `state.tokensSaved`.
- **`/dcp compress`** — calls `pi.sendMessage(triggerTurn=true)` to prompt the LLM to invoke the `compress` tool on the next turn.
- **`/dcp compact`** — calls `triggerDcpNativeCompaction(ctx, state, "command")` to invoke pi-native session compaction.

### `compress-tool/`

Thin wrapper around `src/domain/compression/tooling.js`. Exports everything re-exported from `tooling.js` plus the three source files below.

- **`index.ts`** — re-exports `artifacts`, `registration`, and `validation`.
- **`registration.ts`** — calls `pi.registerTool` for the `compress` tool. Contains the full `execute` callback: validates range boundaries, resolves timestamps/source-keys, checks protected-tail safety, builds `CompressionBlock` objects, deactivates superseded blocks, fires `state.lastCompressTurn`/`lastNudgeTurn`, computes token savings, decides native-compaction auto-trigger, and returns a structured response with `blockIds`, topics, and post-compress planning hints.
- **`validation.ts`** — re-exports from `domain/compression/tooling.js`. Contains `validateCompressionRangeBoundaryIds` and related helpers.
- **`artifacts.ts`** — re-exports from `domain/compression/tooling.js`. Contains `buildCompressionArtifactsForRange`, `buildCompressionPlanningHints`, `expandBlockPlaceholders`, `renderCompressionPlanningHints`.

### `context-handler.ts`

Registers the `context` event hook (`pi.on("context", ...)`). The handler:

1. Calls `materializeContextMessages` to apply pruning (v1 legacy blocks or v2 span-key materialization).
2. Calls `ctx.getContextUsage()` to get context percent/tokens.
3. Calls `getNudgeType` to decide whether to emit a DCP reminder nudge.
4. If a nudge fires, builds `ReminderIntent` (source `"dcp"`, id `"nudge"`, ttl `"once"`) and emits it via `REMINDER_UPSERT_EVENT`.
5. Stores `state.lastRenderedMessages` and `state.lastLiveOwnerKeys` for the provider-payload filter.
6. Updates the pi status footer via `updateDcpStatus`.
7. Writes a `context_evaluated` debug log entry.

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

- **`session_start` / `session_tree`** — calls `restoreStateFromBranch` to deserialize DCP state from the active branch's `"dcp-state"` session entries. Runs `repairStaleNudgeWatermarks` (if the branch contains DCP-native compaction entries, resets turn watermarks to `-1` to prevent debounce lockout) and `repairOffBranchNativeCompactionState` (reactivates blocks that were active on a different branch but not the current one).
- **`session_shutdown` / `agent_end`** — calls `saveState` to append a `"dcp-state"` custom session entry with serialized `DcpState`. Guarded by `ctx.hasUI` to avoid I/O in `-p` print mode.
- **`saveState`** — appends a `"dcp-state"` session entry via `pi.appendEntry`.
- **`restoreStateFromBranch`** — iterates branch entries, finds `"dcp-state"` entries, calls `restorePersistedState`, returns repair metadata.

### `status.ts`

Exposes `updateDcpStatus` (writes the pi footer status) and `buildDcpStatusText` / `computeDisplayedTokensSaved`.

- **Displayed tokens** = `max(0, state.tokensSaved + state.lifetimeTokensSavedRealized)`. `lifetimeTokensSavedRealized` accumulates savings from blocks absorbed by native compaction, so the footer never regresses after compaction.
- **Status text** format: `DCP [manual]` or `DCP N saved N prunes bX`.

### `system-prompt-handler.ts`

Registers the `before_agent_start` event hook. Appends either `SYSTEM_PROMPT` or `MANUAL_MODE_SYSTEM_PROMPT` (from `src/prompts/`) to the agent's system prompt depending on `state.manualMode`.

### `tool-recording.ts`

Registers `tool_call` and `tool_result` event hooks. On `tool_call`, inserts a `ToolRecord` into `state.toolCalls` (input fingerprint, turn index). On `tool_result`, updates the existing record (isError, timestamp, token estimate) or creates a new orphan record. These records feed deduplication and error-purging decisions in `src/domain/pruning/`.

## Key Patterns

### Event-hook orchestration

Every handler is registered once at extension startup and receives the shared `state` and `config` closures. No handler mutates another handler's state; all shared mutations go through `DcpState` or domain functions.

### Domain delegation

Application layer never contains compression overlap logic, liveness computation, or nudge decision rules. All of those live in `src/domain/` and are called by name from the application layer.

### Two-phase state management

- **Runtime state** lives in `DcpState` (in-memory, mutated per event).
- **Persisted state** is serialized on `session_shutdown` / `agent_end` via `serializePersistedState` and restored on `session_start` / `session_tree` via `restorePersistedState`.

### Materialization dispatch

`materializeContextMessages` is the single dispatch point between the v1 legacy block path and the v2 span-key materialization path. The v2 path is only entered when `state.schemaVersion === 2` and active v2 blocks exist.

### Native compaction as a bridge

`native-compaction.ts` is the only place that reads `event.branchEntries` directly and calls `ctx.compact()`. It translates DCP block state into a pi `CompactionResult`, then reacts to the compaction commitment to update `DcpState` accordingly.

### Provider payload filtering is decoupled from transcript rendering

`provider-handler.ts` runs after `context-handler.ts` has stored `state.lastLiveOwnerKeys`. It operates only on the provider request payload, not the transcript. This ensures hidden/provider artifact pruning does not interfere with rendered message IDs.

### Auto-trigger with queue draining

Native compaction auto-trigger queues a request via `queueDcpAutoNativeCompaction`. The `turn_end` hook consumes the queue atomically (delete before `await`) to prevent cancel/retry loops.

## Integration Points

| Source                                          | Target                                  | Direction | Purpose                                                                                  |
| ----------------------------------------------- | --------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `src/application/context-handler.ts`            | `src/domain/pruning/`                   | calls     | `applyPruning`, `exceedsMaxContextLimit`, `getNudgeType`, `finalizeMaterializedMessages` |
| `src/application/context-handler.ts`            | `src/domain/compression/materialize.ts` | calls     | `materializeTranscript`                                                                  |
| `src/application/context-handler.ts`            | `src/domain/compression/tooling.ts`     | calls     | `buildCompressionPlanningHints`, `renderCompressionPlanningHints`                        |
| `src/application/context-handler.ts`            | `src/domain/transcript/`                | calls     | `buildTranscriptSnapshot`, `buildLiveOwnerKeys`                                          |
| `src/application/context-handler.ts`            | `src/infrastructure/debug-log.js`       | calls     | `appendDebugLog`, `buildSessionDebugPayload`                                             |
| `src/application/context-handler.ts`            | `src/application/status.ts`             | calls     | `updateDcpStatus`                                                                        |
| `src/application/provider-handler.ts`           | `src/domain/provider/payload-filter.ts` | calls     | `filterProviderPayloadInput`                                                             |
| `src/application/session-handler.ts`            | `src/state.ts`                          | calls     | `createState`, `resetState`                                                              |
| `src/application/session-handler.ts`            | `src/infrastructure/persistence.ts`     | calls     | `serializePersistedState`, `restorePersistedState`                                       |
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
| `src/application/system-prompt-handler.ts`      | `src/prompts/system.js`                 | imports   | `SYSTEM_PROMPT`, `MANUAL_MODE_SYSTEM_PROMPT`                                             |
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
| `src/application/commands/dcp.ts`               | `@mariozechner/pi-coding-agent`         | pi API    | calls `pi.registerCommand()`, `pi.sendMessage()`                                         |
| `src/application/tool-recording.ts`             | `@mariozechner/pi-coding-agent`         | pi API    | registers `tool_call/tool_result` hooks                                                  |
