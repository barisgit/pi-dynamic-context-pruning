# src/application/compress-tool/

## Responsibility

Wires the `compress` tool into pi, adapts pi session/provider payloads, and delegates pure decisions to domain modules. Owns tool registration, execution orchestration, planning hints, native-compaction scheduling, and debug logging.

## Design

- **registration.ts** — `registerCompressTool(pi, state, config)`. Registers the `compress` tool via `pi.registerTool`. Schema uses `startId`/`endId` as visible boundaries (non-assistant messages `mNNNN` or prior `bN` blocks); assistant turns are pulled in via atomic-pair expansion — they are not directly addressable. The execute handler validates boundaries, resolves timestamps and source keys, builds compression artifacts, updates state, notifies the UI, schedules native compaction, and returns hints for further safe ranges.
  - **Native-compaction auto-trigger** uses `estimateDcpCoverageRatio(compactableSourceItems, state)`: coverage = covered ÷ compactable source items. Blocks with exact `metadata.coveredSourceKeys` use those keys; **legacy blocks with empty `coveredSourceKeys` fall back to timestamp-range matching** so the ratio mirrors `resolveBlockCoveredSourceKeys` in `application/native-compaction.ts` (otherwise legacy restored sessions undercount coverage and defer a compaction `session_before_compact` would approve).
- **artifacts.ts** — Thin barrel re-exporting `buildCompressionArtifactsForRange`, `buildCompressionPlanningHints`, `expandBlockPlaceholders`, `renderCompressionPlanningHints` from `domain/compression/tooling`.
- **validation.ts** — Thin barrel re-exporting boundary validation helpers (`validateCompressionRangeBoundaryIds`, `resolveIdToTimestamp`, `resolveIdToSourceKey`, etc.) from `domain/compression/tooling`.
- **index.ts** — Barrel re-export of the above three modules.

## Flow

1. `registerCompressTool` called at extension init.
2. User/agent calls `compress` with `ranges[{ startId, endId, summary, topic? }]`.
3. Execute handler: fetches current branch messages → resolves protected tail → validates boundary IDs and order → checks hot-tail guard (throws if violated outside emergency) → expands `(bN)` placeholders in summary → delegates `buildCompressionArtifactsForRange` → marks superseded blocks → appends new `CompressionBlock`s to `state.compressionBlocks` → updates `state.tokensSaved`, `state.nextBlockId` → notifies UI → decides native-compaction auto-trigger → recomputes post-compress planning hints → returns result with block IDs and safe-range hints.
4. Native compaction, if queued, runs as a separate deferred task.

## Integration

- **Upstream domain**: `domain/compression/tooling` (range logic, artifacts, planning hints); `domain/transcript` (logical turn tail, snapshot); `domain/pruning` (exceedsMaxContextLimit).
- **Pi host**: `pi.registerTool`, `ctx.getContextUsage()`, `ctx.ui.notify`, `ctx.sessionManager`.
- **State**: mutates `state.compressionBlocks`, `state.tokensSaved`, `state.nextBlockId`, `state.lastCompressTurn`, `state.lastNudgeTurn`, `state.pendingSave`.
- **Debug**: writes to `~/.pi/log/dcp.jsonl` via `appendDebugLog`.
