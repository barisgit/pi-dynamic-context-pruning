# `src/types/` — Code Map

## Responsibility

The `src/types/` directory defines every shared TypeScript type used across the DCP extension. It forms a three-layer contract:

1. **Boundary types** (`api.ts`) — events and payloads exchanged between the DCP extension and the pi host/provider.
2. **Domain types** (`message.ts`) — minimal normalized message shapes used by pure domain logic, decoupled from pi/provider heterogeneity.
3. **State types** (`state.ts`) — runtime state structure, compression block shapes and persisted state schemas (v1/v3/v4/v5).
4. **Configuration types** (`config.ts`) — all user-configurable knobs and their defaults.

## Files

### `src/types/api.ts`

**Responsibility:** Host/provider boundary types — the wire contract between the DCP extension and the pi runtime.

| Type                         | Purpose                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `DcpContextEvent`            | Fired on every context pass; carries the live message list, window size, and token count.               |
| `DcpProviderRequestPayload`  | Raw provider request structure forwarded through DCP; `input` and `messages` fields are later filtered. |
| `DcpToolCallEvent`           | Tool-call event shape from the host; normalizes `name`/`args` vs `toolName`/`arguments` aliases.        |
| `DcpToolResultEvent`         | Tool-result event shape; distinguishes `content` vs `result`, tracks `isError` and `timestamp`.         |
| `DcpSessionMetadataProvider` | Optional host hooks for accessing session identity (`getSessionId`, `getCwd`, `getSessionFile`, etc.).  |

### `src/types/message.ts`

**Responsibility:** Minimal normalized message shapes for internal DCP domain logic. Pi/provider payloads remain heterogeneous at the application boundary; this module captures only the fields DCP needs.

| Type                   | Purpose                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DcpTextPart`          | A `content` array item with a `text` field.                                                                                                         |
| `DcpThinkingPart`      | A `content` array item with a `thinking` field (model-generated reasoning).                                                                         |
| `DcpImagePart`         | A `content` array item with `type: "image"`.                                                                                                        |
| `DcpToolCallPart`      | A `content` array item representing a tool invocation; normalizes `id`, `name`, `input`, `arguments`.                                               |
| `DcpContentPart`       | Discriminated union of all content-part variants plus a catch-all record for forward compatibility.                                                 |
| `DcpMessage`           | Core normalized message shape — `role`, `content`, `timestamp`, `id`, `messageId`, `entryId`, `toolCallId`, `toolName`, `isError`, plus open index. |
| `DcpToolResultMessage` | Specialized `DcpMessage` for tool-result roles (`"toolResult"` or `"bashExecution"`); requires `toolCallId`.                                        |
| `DcpAssistantMessage`  | Specialized `DcpMessage` for assistant messages; narrows `role` to `"assistant"`.                                                                   |
| `isDcpContentPart()`   | Type guard for `DcpContentPart`.                                                                                                                    |

### `src/types/state.ts`

**Responsibility:** Runtime state structure and persisted schema versions (v1–v5). This is the single source of truth for every field in `DcpState`.

**Persisted shapes — supported on session JSONL restore:**

| Type                          | Purpose                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PersistedDcpStateV1`         | v1 persisted shape. Carries full `compressionBlocks[]`, `prunedToolIds`, `tokensSaved`, `totalPruneCount`, turn counters. Kept for legacy session restore.                                                                                                                                                                           |
| `PersistedDcpStateV3`         | **Current empty-session write shape.** Tiny scalar-only marker: `schemaVersion:3`, `savedAt`, `currentTurn`, `lastNudgeTurn`, `lastCompressTurn`, `prunedToolIds`, `lifetimeTokensSavedRealized`. Written when `compressionBlocks.length === 0`; block state is not resurrected from v3.                                             |
| `PersistedCompressionBlockV4` | Minimal legacy-block metadata carried by v4 entries: `id`, `topic`, `summary`, `active`, `createdAt`, `savedTokenEstimate`, `summaryTokenEstimate`, optional `compressCallId`, `supersededBlockIds[]`. Omits coverage anchors, activity logs, and other heavy metadata. v4 is legacy read-only back-compat and is no longer written. |
| `PersistedDcpStateV4`         | Legacy read-only shape. Extends v3 scalars with `schemaVersion:4`, `blocks: PersistedCompressionBlockV4[]`, `nextBlockId`; restored blocks are lossy because coverage anchors are absent.                                                                                                                                            |
| `PersistedCompressionBlockV5` | Current direct-restore block record (`CompressionBlock`) with full coverage anchors (`coveredSourceKeys`/`coveredSpanKeys`), source-key anchors, metadata, and finite timestamp fallback.                                                                                                                                            |
| `PersistedDcpStateV5`         | **Current block-bearing write shape and first correct persisted block shape.** Extends v3 scalars with `schemaVersion:5`, `blocks: PersistedCompressionBlockV5[]`, and `nextBlockId`; direct restore loads full block state plus scalars without runtime replay.                                                                     |
| `PersistedDcpStateUnchanged`  | No-op marker for offline maintenance; `schemaVersion: 1 \| 2 \| 3 \| 4 \| 5`, `unchanged: true`.                                                                                                                                                                                                                                     |
| `PersistedDcpState`           | Union of all persisted shapes (`V1 \| V3 \| V4 \| V5 \| Unchanged`).                                                                                                                                                                                                                                                                 |

**Runtime-only types:**

| Type                       | Purpose                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolRecord`               | Per-call entry keyed by `toolCallId` in `DcpState.toolCalls`. Records `toolName`, `inputArgs`, `inputFingerprint`, `isError`, `turnIndex`, `timestamp`, `tokenEstimate`.            |
| `CompressionBlock`         | Legacy v1 compression block. Timestamp-bounded range with optional exact `startSourceKey`/`endSourceKey`/`anchorSourceKey` anchors and `metadata` for exact coverage.               |
| `CompressionLogEntry`      | Single entry in `activityLog`; `kind` discriminates `user_excerpt`, `assistant_excerpt`, `read`, `edit`, `write`, `command`, `test`, `commit`, `tool`.                              |
| `CompressionFileReadStat`  | Per-file read stats attached to a compressed block: `path`, `count`, `lineSpans[]`.                                                                                                 |
| `CompressionFileWriteStat` | Per-file write stats: `path`, `editCount`, `addedLines`, `removedLines`.                                                                                                            |
| `CompressionCommandStat`   | Per-command stats: `command`, `status`.                                                                                                                                             |
| `CompressionBlockMetadata` | Hidden exact coverage metadata for compression blocks: `coveredSourceKeys`, `coveredSpanKeys`, `coveredArtifactRefs`, `coveredToolIds`, `supersededBlockIds`, plus aggregate stats. |

**Runtime state (`DcpState`):**

| Field group   | Key fields                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool tracking | `toolCalls: Map<toolCallId, ToolRecord>`, `prunedToolIds: Set<string>`                                                                                                                                                                                                                                                                      |
| Compression   | `schemaVersion: 1`, `compressionBlocks: CompressionBlock[]` (active runtime path), `nextBlockId`                                                                                                                                                                                                                                            |
| Message IDs   | `messageAliases`, `messageRefSnapshot`, `messageIdSnapshot`, `messageOwnerSnapshot`, `lastRenderedMessages`, `lastLiveOwnerKeys`                                                                                                                                                                                                            |
| Turn tracking | `currentTurn` (logical turns; standalone visible = 1 turn, assistant tool batch = 1 turn)                                                                                                                                                                                                                                                   |
| Statistics    | `tokensSaved` (current net from **active** blocks; drops after native compaction deactivates them), `lifetimeTokensSavedRealized` (monotonic accumulator — each deactivated block's `savedTokenEstimate` is added here so displayed savings never regress), `totalPruneCount`. Display total = `tokensSaved + lifetimeTokensSavedRealized`. |
| Persistence   | `pendingSave: boolean` — dirty flag since last `saveState`; mutation sites set true; `saveState` no-ops while false; cleared after a successful `dcp-state` append. Not persisted.                                                                                                                                                          |
| Nudge state   | `lastNudgeTurn`, `lastCompressTurn` — persisted in v3/v5 scalars and restored from legacy shapes when present; debounce nudges/compress cadence by logical turn.                                                                                                                                                                            |

### `src/types/config.ts`

**Responsibility:** All user-configurable DCP options with typed defaults and documentation comments. **`manualMode` was removed** (the field is no longer present in `DcpConfig`).

| Field group        | Key fields                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level          | `enabled`, `debug`                                                                                                                                                                                                                                                                                                                            |
| `compress`         | `maxContextPercent` / `minContextPercent` (0–1 nudge gates), `maxContextTokens` / `minContextTokens` (absolute-token overrides), `nudgeDebounceTurns`, `nudgeFrequency` (legacy), `iterationNudgeThreshold`, `protectRecentTurns`, `renderFullBlockCount`, `renderCompactBlockCount`, `nudgeForce`, `protectedTools[]`, `protectUserMessages` |
| `nativeCompaction` | `enabled`, `autoTriggerMessageCount`, `autoTriggerForceMessageCount?`, `minActiveBlockCount`, `minHiddenCoverageRatio`, `maxPreviousSummaryTokens`, `maxSummaryTokens`                                                                                                                                                                        |
| `strategies`       | `pruneCadenceTurns` (bucket boundary for tombstone additions; `1` = per-turn), `deduplication` (`enabled`, `protectedTools`), `purgeErrors` (`enabled`, `turns`, `protectedTools`)                                                                                                                                                            |
| Top-level          | `protectedFilePatterns[]`, `pruneNotification` (`"off" \| "minimal" \| "detailed"`)                                                                                                                                                                                                                                                           |
