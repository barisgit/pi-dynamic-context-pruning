# src/domain/compression/

## Responsibility

Pure compression logic: render active blocks into synthetic transcript messages, resolve timestamp/source-key ranges, build compress artifacts and planning hints, and enforce boundary/overlap rules. Consumed by pruning (materialization), the compress tool, context-handler nudges, and replay validation.

## Design

| File             | Responsibility                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `materialize.ts` | Render v2 blocks into `DcpMessage`s (`full` / `compact` / `minimal`). Stamps `INTERNAL_BLOCK_ID` so `buildSourceItemKey` emits stable `synth:block:b<id>` keys.                                                     |
| `range.ts`       | Expand timestamp-bounded ranges to include atomic assistant/tool-result groups. Resolve indices from timestamps; token estimates. Imported directly by pruning and compress-tool (not re-exported from `index.ts`). |
| `metadata.ts`    | Factory for empty `CompressionBlockMetadata` (`coveredSourceKeys`, `coveredSpanKeys`, tool IDs, file/command stats).                                                                                                |
| `tooling.ts`     | Boundary validation, planning hints, activity-log/metadata assembly, supersession resolution, ID/timestamp/source-key resolution, `(bN)` placeholder expansion.                                                     |
| `index.ts`       | Re-exports `materialize`, `metadata`, `tooling` only.                                                                                                                                                               |

### `tooling.ts` — planning hints

- **`buildCompressionPlanningHints(messages, state, protectRecentTurns, candidateLimit?)`** walks `buildTranscriptSnapshot().spans` and accumulates safe compressible stretches between flush points.
- **Flush points:** hot-tail boundary (`resolveProtectedTailStartTimestamp` → visible `protectedTailStartId`) and spans already inside active compression blocks (`collectCoveredSourceKeys`).
- **Passthrough spans** (`compaction`, `branch_summary`, `custom_message`): no visible `mNNNN` ref, but removed by the compression splice when in-range. Planning treats them as transparent — absorb token estimates into the running candidate instead of fragmenting across reminder/compaction injections.
- **Returns `CompressionPlanningHints`:** `protectedTailStartId`, deduped `protectedMessageIds` / `protectedBlockIds`, top-N `candidateRanges` (sorted by token estimate desc), plus `totalCandidateCount` and `totalCompressibleTokens` before truncation.

### `tooling.ts` — hidden-ID diagnostics (render)

- **`renderCompressionPlanningHints(hints, options?)`** formats agent-facing guidance.
- Protected ID lists truncate at 8 messages / 6 blocks via `summarizeIdList` → `"m0001, m0002 (+3 more)"`.
- Candidate section reports total compressible tokens and stretch count; when truncated, appends `"showing top N by size"`.
- **`includeProtectedIdList: true`** (compress-tool hot-tail guard) emits `"Do not use these as endId right now: messages …; blocks …"`.

### `tooling.ts` — overlap & unavailable-ref diagnostics

- **`validateCompressionRangeBoundaryIds(startId, endId, state)`** rejects malformed refs and raw `mNNNN` inside active `bN` spans. Missing message refs resolve via `buildUnavailableMessageRefError` + `formatUnavailableBlockRefHint` (usable boundary is `bN`; original raw span when alias table still has it).
- **`resolveSupersededBlockIdsForRange(...)`** allows supersession only when the new range fully covers an existing block's `coveredSourceKeys`. Partial overlap throws `buildOverlapError` with `formatExistingBlockBoundaryHint` (visible `startRef..endRef` or timestamp-only fallback).
- Same-block-only ranges (`bN..bN`) are rejected explicitly.

## Flow

### Materialization (pruning path)

1. `applyPruning` selects active blocks → `materializeTranscriptWithBlocks`.
2. `renderCompressedBlockMessage` creates a synthetic `user` message stamped with `INTERNAL_BLOCK_ID`.
3. `buildSourceItemKey` emits `synth:block:b<id>`; downstream snapshot, owner derivation, provider-payload filtering, and replay use these keys.

### Compress tool / nudge path

1. `buildCompressionPlanningHints` → `renderCompressionPlanningHints` (context nudge or pre/post-compress tool hints).
2. `validateCompressionRangeBoundaryIds` → reject refs inside compressed spans or invalid boundaries.
3. `resolveIdToTimestamp` / `resolveIdToSourceKey` → `buildCompressionArtifactsForRange` (activity log + exact `coveredSourceKeys` / `coveredSpanKeys`).
4. `resolveSupersededBlockIdsForRange` → mark fully covered blocks inactive; partial overlap aborts with boundary guidance.
5. `expandBlockPlaceholders` expands `(bN)` in summaries before block creation.

## Integration

- **pruning** — `materializeTranscriptWithBlocks`, `range.ts` expansion helpers
- **application/compress-tool** — planning hints, boundary validation, artifacts, supersession (via thin `artifacts.ts` / `validation.ts` barrels)
- **application/context-handler** — nudge planning hints
- **replay** — `validateCompressionRangeBoundaryIds` during range replay
- **transcript** — snapshot spans, logical-turn tail, `INTERNAL_BLOCK_ID` / source-key derivation
