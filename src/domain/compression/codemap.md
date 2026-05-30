# src/domain/compression/

## Responsibility

Pure compression logic: render active legacy blocks into synthetic transcript messages, resolve timestamp/source-key ranges, build compress artifacts and planning hints, and enforce boundary/overlap rules. Consumed by pruning (runtime materialization), the compress tool, context-handler nudges, and offline replay validation.

## Design

| File             | Responsibility                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `materialize.ts` | Inert/deferred-dead v2 scaffold: renders `CompressionBlockV2` into `DcpMessage`s (`full` / `compact` / `minimal`) only for the never-written `schemaVersion === 2` path. Stamps `INTERNAL_BLOCK_ID` so `buildSourceItemKey` emits stable `synth:block:b<id>` keys. |
| `range.ts`       | Expand timestamp-bounded ranges to include atomic assistant/tool-result groups. Resolve indices from timestamps; token estimates. Imported directly by pruning and compress-tool (not re-exported from `index.ts`).                                                |
| `metadata.ts`    | Factory for empty `CompressionBlockMetadata` (`coveredSourceKeys`, `coveredSpanKeys`, tool IDs, file/command stats).                                                                                                                                               |
| `tooling.ts`     | Boundary validation, planning hints, activity-log/metadata assembly, supersession resolution, ID/timestamp/source-key resolution, `(bN)` placeholder expansion.                                                                                                    |
| `index.ts`       | Re-exports `materialize`, `metadata`, `tooling` only.                                                                                                                                                                                                              |

### `tooling.ts` — planning hints

- **`buildCompressionPlanningHints(messages, state, protectRecentTurns, candidateLimit?)`** walks `buildTranscriptSnapshot().spans` and accumulates safe compressible stretches between flush points.
- **Flush points:** hot-tail boundary (`resolveProtectedTailStartTimestamp`) and spans already inside active compression blocks (`collectCoveredSourceKeys`).
- **Span boundary refs come from resolvable items, not `timestamps[0]`.** A `tool-exchange` span starts with an assistant tool-call message, which never gets a visible `mNNNN` ref (see `injectMessageIds`). Each span maps its source items to resolvable refs, drops nulls, and uses `resolvableIds[0]..resolvableIds.at(-1)` as `startId..endId` (the trailing `toolResult`/`bashExecution` carries the ref; the assistant is pulled in by atomic-pair expansion). Resolving from `timestamps[0]` previously returned null for every tool batch and fragmented each into its own tiny range.
- **Transparent spans** (passthrough roles `compaction`/`branch_summary`/`custom_message`, AND zero-resolvable-ref spans like standalone assistant output): no visible ref, but removed by the splice when in-range. Their tokens are **buffered in `pendingTransparentTokens`**, not added directly. They are committed to the candidate only when a later resolvable span extends `endId` past them (making them interior); buffered tokens trailing after the last resolvable boundary are dropped on flush (`pushActiveCandidate` resets the buffer) so the estimate never counts tokens a `startId..endId` splice would not remove.
- **`protectedTailStartId`** = `resolveVisibleIdForTimestamp(tailStart)` with a fallback to `protectedMessageIds[0]`. The tail boundary is the START of the Nth-from-last logical turn; for a `tool-exchange` turn that start is the unaddressable assistant, so the fallback surfaces the turn's first visible protected id instead of dropping the "Protected hot tail starts at …" nudge line. `protectedMessageIds` is computed before `protectedTailStartId` to enable this.
- **Returns `CompressionPlanningHints`:** `protectedTailStartId`, deduped `protectedMessageIds` / `protectedBlockIds`, top-N `candidateRanges` (sorted by token estimate desc), plus `totalCandidateCount` and `totalCompressibleTokens` before truncation.

### `tooling.ts` — hidden-ID diagnostics (render)

- **`renderCompressionPlanningHints(hints, options?)`** formats agent-facing guidance.
- Protected ID lists truncate at 8 messages / 6 blocks via `summarizeIdList` → `"m0001, m0002 (+3 more)"`.
- Candidate section reports total compressible tokens and stretch count; when truncated, appends `"showing top N by size"`.
- **`includeProtectedIdList: true`** (compress-tool hot-tail guard) emits `"Do not use these as endId right now: messages …; blocks …"`.

### `tooling.ts` — overlap & unavailable-ref diagnostics

- **`validateCompressionRangeBoundaryIds(startId, endId, state)`** rejects malformed refs and raw `mNNNN` inside active `bN` spans. Missing message refs resolve via `buildUnavailableMessageRefError` + `formatUnavailableBlockRefHint` (usable boundary is `bN`; original raw span when alias table still has it).
- **`resolveSupersededBlockIdsForRange(...)`** allows supersession only when the new range fully covers an existing block's `coveredSourceKeys`. Partial overlap throws `buildOverlapError(startId, endId, existing, state)` — **`state` is forwarded at both throw sites** so the hint can resolve refs (omitting it forced the degraded "refs unavailable" message regardless of available refs).
- **`resolveExistingBlockBoundaryRefs`** resolves a block's boundary refs by source key, then timestamp, then `resolveBoundaryRefWithinSpan` (scan `messageIdSnapshot` for the first/last ref whose timestamp lies within `[startTimestamp, endTimestamp]`). The within-span fallback recovers an addressable ref for `tool-exchange` blocks whose first covered item is the ref-less assistant; only when no visible ref exists anywhere in the span does the hint fall back to timestamp-only text.
- Same-block-only ranges (`bN..bN`) are rejected explicitly.

## Flow

### Materialization (pruning path)

1. Runtime pruning selects active legacy `state.compressionBlocks` and replaces covered spans with synthetic block messages.
2. Synthetic block messages are stamped with `INTERNAL_BLOCK_ID`.
3. `buildSourceItemKey` emits `synth:block:b<id>`; downstream snapshot, owner derivation, and provider-payload filtering use these keys.
4. `materializeTranscript` / `CompressionBlockV2` remain inert scaffolding, reachable only through the never-written `schemaVersion === 2` state path.

### Compress tool / nudge path

1. `buildCompressionPlanningHints` → `renderCompressionPlanningHints` (context nudge or pre/post-compress tool hints).
2. `validateCompressionRangeBoundaryIds` → reject refs inside compressed spans or invalid boundaries.
3. `resolveIdToTimestamp` / `resolveIdToSourceKey` → `buildCompressionArtifactsForRange` (activity log + exact `coveredSourceKeys` / `coveredSpanKeys`).
4. `resolveSupersededBlockIdsForRange` → mark fully covered blocks inactive; partial overlap aborts with boundary guidance.
5. `expandBlockPlaceholders` expands `(bN)` in summaries before block creation.

## Integration

- **pruning** — active legacy `state.compressionBlocks` replacement via `renderCompressedBlockMessage`, plus `range.ts` expansion helpers
- **application/compress-tool** — planning hints, boundary validation, artifacts, supersession (via thin `artifacts.ts` / `validation.ts` barrels)
- **application/context-handler** — nudge planning hints
- **replay** — offline `validateCompressionRangeBoundaryIds` during range replay
- **transcript** — snapshot spans, logical-turn tail, `INTERNAL_BLOCK_ID` / source-key derivation
