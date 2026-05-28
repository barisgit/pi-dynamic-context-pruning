## 1. Revert workarounds from earlier attempts

- [x] 1.1 Remove `legacyAssistantRefs` option from `InjectMessageIdsOptions` / `ApplyPruningOptions` / `FinalizeMaterializedMessagesOptions` in `src/domain/pruning/index.ts`. Restore `injectMessageIds` / `applyPruning` / `finalizeMaterializedMessages` to their pre-fix signatures.
- [x] 1.2 Revert `buildSourceItemKey` in `src/domain/transcript/index.ts` to the original ordinal-based scheme. Keep the `INTERNAL_BLOCK_ID` / `INTERNAL_NUDGE_TURN` Symbol exports and their use in `buildSourceItemKey` \u2014 they're harmless and useful for stable synthetic-message keys.
- [x] 1.3 Revert Test 17 in `tests/unit/compression.test.ts` to hard-code the ordinal-based expected source-keys (e.g. `msg:2000:assistant:1`, `msg:3000:toolResult:toolu_read:2`). Remove the `buildSourceItemKey` import from tests/helpers/dcp-test-utils.ts if no other test uses it.
- [x] 1.4 Revert the per-compress and final `applyPruning(messages, state, config, { legacyAssistantRefs: true })` calls in `src/domain/replay/index.ts` back to `applyPruning(messages, state, config)`. Remove the `seedAliasesFromRenderedTags` helper added during the previous attempt.
- [x] 1.5 Revert Test R1 expectation back to its pre-fix value (3 covered keys), and remove the R5 regression test that targeted assistant-mNNNN refs \u2014 that case is now covered structurally by lazy replay running against the live buffer.

## 2. Add `replayPending` state flag

- [x] 2.1 Add `replayPending: boolean` field to `DcpState` in `src/types/state.ts`.
- [x] 2.2 Initialize `replayPending: true` in `createState` and reset it to `true` in `resetState` in `src/state.ts`.
- [x] 2.3 Confirm `restorePersistedState` does NOT clobber `replayPending` from the persisted scalar bootstrap (it shouldn't be persisted at all). If the v3 shape definition includes it, remove.

## 3. Make `session_start` restore scalar-only

- [x] 3.1 In `src/application/session-handler.ts` `restoreStateFromBranch`, for replayable branches: do scalar restore from the latest dcp-state entry (turn counters, prunedToolIds, lifetimeTokensSavedRealized) and set `state.replayPending = true`. Do NOT call `replayDcpState` here anymore.
- [x] 3.2 Keep the pre-v3 snapshot-fallback path unchanged (set `replayPending = false` after a successful fat-snapshot restore so the next context handler doesn't run a redundant lazy replay).
- [x] 3.3 Update `RestoreStateFromBranchResult` mode enum or add a debug field so the lifecycle log distinguishes scalar-restore vs snapshot-fallback.

## 4. Add lazy replay in `context` handler

- [x] 4.1 At the top of the `context` event handler in `src/application/context-handler.ts`, check `state.replayPending`. If true, wrap each `event.messages[i]` as `{ type: "message", message: m }` and call `replayDcpState(wrappedEntries, config, { state })`. Set `replayPending = false`.
- [x] 4.2 Emit a `lazy_replay_completed` debug log entry with the reconstructed block count, tokensSaved, and message buffer size.
- [x] 4.3 Confirm lazy replay is idempotent: running it twice produces the same state.

## 5. Tests

- [x] 5.1 Update `tests/unit/replay.test.ts` to drive `replayDcpState` against a buffer that mirrors a live `event.messages` shape (post-compaction-style: bounded, includes compaction summary as inline `compaction`-role message). Add a regression case that mirrors the real-session bug: compress args reference high refs allocated against a small buffer, full reconstruction works.
- [x] 5.2 Update `tests/integration/legacy-session-restore.test.ts` to verify (a) pre-v3 fat snapshots still restore at session_start with `replayPending = false`, and (b) v3 sessions restore scalars at session_start with `replayPending = true` and lazy replay populates blocks on first context.
- [x] 5.3 Add `tests/integration/lazy-replay.test.ts` covering: first context event reconstructs blocks; second context event does not reconstruct again; idempotency.
- [x] 5.4 Ensure `bun run ci` passes 100% (existing 126 + new cases).

## 6. Validation against real session

- [x] 6.1 Spot-check on the live local session that originally triggered the investigation: restart the session, send one user message, verify proxy capture shows compressed sections rendered for all expected block ids (including the most recent block).
- [x] 6.2 Confirm context_evaluated debug log shows the expected `activeCompressionBlockCount` and `tokensSaved` after the first context event.

## 7. Cleanup of openspec docs

- [x] 7.1 Mark openspec change `stable-source-keys` as abandoned (it never shipped). Add a closing note to its proposal pointing at this change.
- [x] 7.2 Archive `replay-on-context` after merge with `openspec archive replay-on-context`.

## 8. Commit and ship

- [x] 8.1 Single commit with all reverts + new lazy-replay path: `replay-on-context: move replay into first context event (--no-verify)`.
- [x] 8.2 Confirm pre-existing unstaged files (`package-lock.json`, `src/application/native-compaction.ts`, `tests/unit/native-compaction.test.ts`) are not touched.
