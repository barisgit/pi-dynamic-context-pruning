## 1. Add v4 persisted shape

- [x] 1.1 Add `PersistedDcpStateV4` interface to `src/types/state.ts`: extends v3 scalar shape with `blocks: PersistedCompressionBlockV4[]` and `nextBlockId: number`.
- [x] 1.2 Add `PersistedCompressionBlockV4` interface: `{ id, topic, summary, active, createdAt, savedTokenEstimate, summaryTokenEstimate, compressCallId, supersededBlockIds }`.
- [x] 1.3 Update `PersistedDcpState` union to include v4.
- [x] 1.4 Broaden `PersistedDcpStateUnchanged.schemaVersion` to `1 | 2 | 3 | 4`.

## 2. Serialize to v4

- [x] 2.1 `serializePersistedState` writes v4 when `state.compressionBlocks.length > 0`. Falls back to v3 when no blocks exist (degenerate case keeps tiny initial sessions lean).
- [x] 2.2 Map each `CompressionBlock` -> `PersistedCompressionBlockV4`, dropping heavy fields.
- [x] 2.3 Update materialKey logic in vacuum-dcp-session.ts to recognise v4 alongside v3 (same `savedAt`-excluding rule).

## 3. Restore from v4

- [x] 3.1 Add a v4 branch to `restorePersistedState` in `src/infrastructure/persistence.ts`: load scalars (same as v3), load `blocks` into `state.compressionBlocks`, reconstruct each block's `metadata` with empty heavy arrays (`coveredSourceKeys: []`, etc.) and `supersededBlockIds` from persisted shape, set `state.nextBlockId`.
- [x] 3.2 In `restoreStateFromBranch` (`src/application/session-handler.ts`), when the latest dcp-state entry is v4, set `state.replayPending = false` and return mode `"persisted"`.
- [x] 3.3 When the latest dcp-state entry is v3 only (no v4 yet — legacy), keep current behavior: `replayPending = true`, mode `"replay-pending"`.
- [x] 3.4 Add a `RestoreMode = "persisted" | "replay-pending" | "snapshot-fallback"` enum value.

## 4. Tests

- [x] 4.1 New `tests/unit/persist-block-metadata.test.ts`: round-trip a state with mixed active/inactive blocks through serialize+restore; verify all preserved fields match.
- [x] 4.2 New test: v4 entry produces `replayPending = false` and mode `"persisted"`.
- [x] 4.3 Update `tests/integration/persistence-budget.test.ts`: empty state -> tiny v3, populated state -> v4 with bounded per-block cost (~300 bytes), 100 blocks under 30 KB.
- [x] 4.4 Update `tests/integration/legacy-session-restore.test.ts` to use v4 fixtures where a v3 session had a successful compress; reuse the existing test patterns.
- [x] 4.5 Confirm `bun run ci` 100% green.

## 5. Validation

- [x] 5.1 Real session: restart, observe `restoreMode: "persisted"`, `activeCompressionBlockCount` matches pre-restart count, no `lazy_replay_completed` debug event.
- [x] 5.2 Run `bun run vacuum:verify-corpus` to confirm existing v3 sessions still verify clean.

## 6. Commit

- [x] 6.1 Single commit: `persist-block-metadata: v4 shape carries block list across restart`.
- [x] 6.2 Pre-existing unstaged files (`package-lock.json`, `src/application/native-compaction.ts`, `tests/unit/native-compaction.test.ts`) untouched.
