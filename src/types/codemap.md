# `src/types/` — Code Map

## Responsibility

The `src/types/` directory defines every shared TypeScript type used across the DCP extension. It forms a three-layer contract:

1. **Boundary types** (`api.ts`) — events and payloads exchanged between the DCP extension and the pi host/provider.
2. **Domain types** (`message.ts`) — minimal normalized message shapes used by pure domain logic, decoupled from pi/provider heterogeneity.
3. **State types** (`state.ts`) — runtime state structure, compression block shapes (v1 legacy and v2 draft), and persisted state schemas.
4. **Configuration types** (`config.ts`) — all user-configurable knobs and their defaults.

## Files

### `src/types/api.ts`

**Responsibility:** Host/provider boundary types — the wire contract between the DCP extension and the pi runtime.

Defines the following interfaces:

| Type                         | Purpose                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `DcpContextEvent`            | Fired on every context pass; carries the live message list, window size, and token count.               |
| `DcpProviderRequestPayload`  | Raw provider request structure forwarded through DCP; `input` and `messages` fields are later filtered. |
| `DcpToolCallEvent`           | Tool-call event shape from the host; normalizes `name`/`args` vs `toolName`/`arguments` aliases.        |
| `DcpToolResultEvent`         | Tool-result event shape; distinguishes `content` vs `result`, tracks `isError` and `timestamp`.         |
| `DcpSessionMetadataProvider` | Optional host hooks for accessing session identity (`getSessionId`, `getCwd`, `getSessionFile`, etc.).  |

### `src/types/message.ts`

**Responsibility:** Minimal normalized message shapes for internal DCP domain logic. Pi/provider payloads remain heterogeneous at the application boundary; this module captures only the fields DCP needs.

Defines the following interfaces and types:

| Type                   | Purpose                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DcpTextPart`          | A `content` array item with a `text` field.                                                                                                                                           |
| `DcpThinkingPart`      | A `content` array item with a `thinking` field (model-generated reasoning).                                                                                                           |
| `DcpImagePart`         | A `content` array item with `type: "image"`.                                                                                                                                          |
| `DcpToolCallPart`      | A `content` array item representing a tool invocation; normalizes `id`, `name`, `input`, `arguments`.                                                                                 |
| `DcpContentPart`       | Discriminated union of all content-part variants plus a catch-all record for forward compatibility.                                                                                   |
| `DcpMessage`           | Core normalized message shape used by domain logic — `role`, `content`, `timestamp`, `id`, `messageId`, `entryId`, `toolCallId`, `toolName`, `isError`, plus an open index signature. |
| `DcpToolResultMessage` | Specialized `DcpMessage` for tool-result roles (`"toolResult"` or `"bashExecution"`); requires `toolCallId`.                                                                          |
| `DcpAssistantMessage`  | Specialized `DcpMessage` for assistant messages; narrows `role` to `"assistant"` and types `content` as `DcpMessageContent`.                                                          |
| `isDcpContentPart()`   | Type guard for `DcpContentPart`.                                                                                                                                                      |

### `src/types/state.ts`

**Responsibility:** Runtime state structure and both persisted schema versions (v1 and v2). This is the single source of truth for every field in `DcpState`.

Defines the following interfaces and types:

| Type                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ---------------- |
| `ToolRecord`               | Per-call tracking entry keyed by `toolCallId` in `DcpState.toolCalls`. Records `toolName`, `inputArgs`, `inputFingerprint`, `isError`, `turnIndex`, `timestamp`, and `tokenEstimate`.                                                                                                                                                                                                                                                      |
| `CompressionBlock`         | Legacy v1 compression block. Timestamp-bounded range with `startTimestamp`/`endTimestamp`/`anchorTimestamp`. Also carries optional exact `startSourceKey`/`endSourceKey`/`anchorSourceKey` anchors and `metadata` for full v2 coverage. `activityLog` renders a deterministic chronological log inside the block.                                                                                                                          |
| `CompressionBlockV2`       | Draft v2 compression block. Uses canonical `startSpanKey`/`endSpanKey` instead of timestamps; carries explicit `metadata` with exact `coveredSourceKeys`, `coveredSpanKeys`, `coveredArtifactRefs`, `coveredToolIds`, `supersededBlockIds`, plus file-read/write stats and command stats. Status is `"active"                                                                                                                              | "superseded" | "decompressed"`. |
| `CompressionBlockStatus`   | Union type for v2 block lifecycle.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CompressionLogEntry`      | Single entry in `activityLog`; `kind` discriminates `user_excerpt`, `assistant_excerpt`, `read`, `edit`, `write`, `command`, `test`, `commit`, `tool`.                                                                                                                                                                                                                                                                                     |
| `CompressionFileReadStat`  | Per-file read stats attached to a v2 block: `path`, `count`, `lineSpans[]`.                                                                                                                                                                                                                                                                                                                                                                |
| `CompressionFileWriteStat` | Per-file write stats attached to a v2 block: `path`, `editCount`, `addedLines`, `removedLines`.                                                                                                                                                                                                                                                                                                                                            |
| `CompressionCommandStat`   | Per-command stats attached to a v2 block: `command`, `status`.                                                                                                                                                                                                                                                                                                                                                                             |
| `CompressionBlockMetadata` | Hidden deterministic metadata attached to both v1 and v2 blocks. Exact coverage (`coveredSourceKeys`, `coveredSpanKeys`, `coveredArtifactRefs`, `coveredToolIds`, `supersededBlockIds`) plus aggregate stats.                                                                                                                                                                                                                              |
| `PersistedDcpStateV1`      | Persisted schema version 1 — flat list of `compressionBlocks`, `nextBlockId`, `messageAliases`, `prunedToolIds`, `tokensSaved`, `totalPruneCount`, `manualMode`, turn counters.                                                                                                                                                                                                                                                            |
| `PersistedDcpStateV2`      | Persisted schema version 2 — replaces `compressionBlocks` with `blocks: CompressionBlockV2[]`; removes `prunedToolIds` and `tokensSaved` (computed at runtime).                                                                                                                                                                                                                                                                            |
| `PersistedDcpState`        | Union of v1 and v2 persisted shapes for migration compatibility.                                                                                                                                                                                                                                                                                                                                                                           |
| `DcpState`                 | Full in-memory runtime state. Fields: `toolCalls` (Map), `prunedToolIds` (Set), `schemaVersion`, `compressionBlocks` (v1), `compressionBlocksV2` (v2), `nextBlockId`, `lastRenderedMessages`, `lastLiveOwnerKeys`, `messageAliases`, `messageRefSnapshot`, `messageIdSnapshot`, `messageOwnerSnapshot`, `currentTurn`, `tokensSaved`, `lifetimeTokensSavedRealized`, `totalPruneCount`, `manualMode`, `lastNudgeTurn`, `lastCompressTurn`. |

### `src/types/config.ts`

**Responsibility:** All user-configurable DCP options with typed defaults and documentation comments.

Defines:

| Field group        | Key fields                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Top-level          | `enabled`, `debug`, `manualMode` (with `automaticStrategies` sub-flag)                                                                                                                                                                                                                                             |
| `compress`         | `maxContextPercent` / `minContextPercent` (0–1 nudge gates), `maxContextTokens` / `minContextTokens` (absolute-token overrides), `nudgeDebounceTurns`, `iterationNudgeThreshold`, `protectRecentTurns`, `renderFullBlockCount`, `renderCompactBlockCount`, `nudgeForce`, `protectedTools[]`, `protectUserMessages` |
| `nativeCompaction` | `enabled`, `autoTriggerMessageCount`, `minActiveBlockCount`, `minHiddenCoverageRatio` (DCP override gate for pi's LLM compactor), `maxPreviousSummaryTokens`, `maxSummaryTokens`                                                                                                                                   |
| `strategies`       | `pruneCadenceTurns` (bucket boundary for tombstone additions), `deduplication` (`enabled`, `protectedTools`), `purgeErrors` (`enabled`, `turns`, `protectedTools`)                                                                                                                                                 |
| Top-level          | `protectedFilePatterns[]`, `pruneNotification` (`"off" \| "minimal" \| "detailed"`)                                                                                                                                                                                                                                |
