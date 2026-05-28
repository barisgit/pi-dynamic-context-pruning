# Persist CompressionBlock metadata across sessions

## Why

DCP v3 made on-disk dcp-state entries a tiny scalar bootstrap (<4 KiB) and relies on `replayDcpState` to reconstruct blocks from the live message buffer at session start. This works for blocks whose `compress` tool calls survive in pi's post-compaction buffer, but fails for **pre-compaction blocks** — pi collapses them into a native-compaction summary, removing their compress tool calls from `event.messages`. The runtime DcpState ends up with only post-compaction blocks; pre-compaction blocks are unreachable.

The visible failure mode: a second native compaction in a restored session can only tier-render the post-compaction subset, losing the structured pre-compaction block records (topic, summary, savedTokenEstimate) that were used to build the first compaction summary. In effect, blocks fade after restart even though the underlying compaction summary text still contains them as prose.

We need to persist enough block metadata on disk so a restored session has the same `state.compressionBlocks` array the live session had — without bloating the dcp-state payload back to the v1 fat-snapshot scale.

## What Changes

- Add a v4 persisted shape `PersistedDcpStateV4` that augments v3 with a minimal block array.
- Each persisted block carries: `id`, `topic`, `summary`, `active`, `createdAt`, `savedTokenEstimate`, `summaryTokenEstimate`, `metadata.supersededBlockIds`, `compressCallId`. Heavy fields (`coveredSourceKeys`, `coveredSpanKeys`, `coveredArtifactRefs`, `coveredToolIds`, `activityLog`, file/command stats) are dropped — they exist only for live runtime pruning decisions and reconstruction is not required after restart.
- `serializePersistedState` writes v4 when there are active or recently-deactivated blocks; otherwise writes v3 (degenerate empty case).
- `restorePersistedState` adds a v4 branch that loads scalars + `state.compressionBlocks` and sets `state.replayPending = false` (no lazy replay needed — persistence already holds the truth).
- v3 legacy sessions still go through lazy replay (`replayPending = true`).
- v1/v2 fat-snapshot paths unchanged.
- Estimated overhead: ~150-300 bytes/block; a typical session with 30 blocks costs ~5-10 KB per save — still well under the prior fat-snapshot scale, and a fixed cost rather than the per-snapshot duplication v1/v2 had.

## Impact

- Affected specs: `dcp-persistence` (new requirement: persisted block metadata across restarts)
- Affected code: `src/types/state.ts` (add `PersistedDcpStateV4`), `src/infrastructure/persistence.ts` (serialize → v4, restore v4 branch), `src/application/session-handler.ts` (clear `replayPending` after v4 restore), `tests/integration/persistence-budget.test.ts` (update budget to reflect block tail), new `tests/unit/persist-block-metadata.test.ts`.
