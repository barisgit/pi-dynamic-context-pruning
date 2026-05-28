## 1. Source-key builder

- [ ] 1.1 Rewrite `buildSourceItemKey` in `src/domain/transcript/index.ts` to drop the ordinal parameter. New chain: `raw:<id>` short-circuit (unchanged) → `synth:nudge:<turn>` if internal nudge marker is present → `synth:block:b<id>` if internal block marker is present → `msg:<role>:<ts|->:<toolCallId|->:<contentHash16>`.
- [ ] 1.2 Implement the content-hash helper. Use `node:crypto` sha256 of `JSON.stringify(message.content ?? null)`, take first 16 hex chars. Colocate in `src/domain/transcript/index.ts`.
- [ ] 1.3 Confirm internal nudge/block markers already exist on synthesized messages. Search `src/domain/pruning/index.ts` and `src/domain/compression/materialize.ts` for the markers used today (likely `INTERNAL_NUDGE_TURN`, `INTERNAL_BLOCK_ID`). If only one exists, decide whether to add the missing one or just let those flow through the `msg:...` content-hash path (which is also stable since synthetic content is deterministic).
- [ ] 1.4 Update the JSDoc on `buildSourceItemKey` to reflect the new contract: deterministic function of message contents; never depends on caller-supplied buffer position.

## 2. Callers of `buildSourceItemKey`

- [ ] 2.1 Update `src/domain/pruning/index.ts:injectMessageIds` to call the new signature (drop ordinal arg from the call). Keep the surrounding `for (let ordinal = 0; ...)` loop — it's still needed for owner-key allocation and the assistant tool-call insert-position logic.
- [ ] 2.2 Audit `grep -n 'buildSourceItemKey' src` and update every caller; if any unit test was constructing the key by hand using the old shape, update it too.

## 3. Replay alignment

- [ ] 3.1 No code changes in `src/domain/replay/index.ts` should be required: once the key function is deterministic, replay's `applyPruning` calls allocate the same refs live did. Verify by running the existing replay tests after task 1+2 land.
- [ ] 3.2 If R5 still fails because of the assistant-id inclusion case, that's task 8 territory — don't shoehorn fixes here.

## 4. Live wiring

- [ ] 4.1 No code changes in `src/application/context-handler.ts` should be required: pi's `ContextEvent.messages` is the only input we consume, and `buildSourceItemKey` now works entirely off `message` contents.

## 5. (Reserved, unused after recon)

- [ ] 5.1 (skip)
- [ ] 5.2 (skip)

## 6. Tests — unit

- [ ] 6.1 Add `tests/unit/transcript.test.ts` cases: same source-key for a message in a 5-item buffer vs the same message in a 500-item buffer (different positions, same `id` → same key); content-hash fallback produces a stable key when only `(role, ts, content)` are known.
- [ ] 6.2 Update existing `tests/unit/transcript.test.ts` fixtures to add `.id` to messages so they exercise the primary `raw:<id>` path (not the fallback).
- [ ] 6.3 Add `tests/unit/replay.test.ts` regression case: build a branch where the live agent's compress arguments target `mNNNN` refs allocated from a 500-message buffer; replay the full branch and assert the same refs resolve.

## 7. Tests — integration

- [ ] 7.1 In `tests/integration/legacy-session-restore.test.ts`, add a case that captures the real-session failure shape: 10+ compress calls plus a native compaction entry; assert `replayDcpState` produces the same set of active blocks as a live applyPruning replay over a synthesized-but-equivalent message buffer.
- [ ] 7.2 Run the full corpus equivalence check (`bun run replay:equivalence`) and confirm no NEW in-contract mismatches appear; record the pre-fix vs post-fix delta on the local session corpus.

## 8. Cleanup of `legacyAssistantRefs`

- [ ] 8.1 Re-examine whether `legacyAssistantRefs: true` in `src/domain/replay/index.ts` is still required after the source-key fix lands. Run `tests/unit/replay.test.ts` R5 with the flag set to false; if all assertions still hold, default it to false in replay and update the option JSDoc to call it a strict-compatibility knob.
- [ ] 8.2 If R5 still requires the flag, leave it on but add a comment pointing at this change documenting why the source-key fix alone isn't enough.

## 9. Validation gate

- [ ] 9.1 `bun run check-types` clean
- [ ] 9.2 `bun run lint` clean
- [ ] 9.3 `bun run test` 100% green (existing 126 + any new cases from 6/7)
- [ ] 9.4 `bun run ci` clean
- [ ] 9.5 Spot-check on the real local session that triggered this investigation: `bun run /tmp/debug-replay.ts` should show `active=6` (was 5 post-fix, was 0 pre-fix; 6 matches what the live agent had before restart)

## 10. Commit + record

- [ ] 10.1 Commit as `stable-source-keys: switch source-key builder to pi entry id` with the proposal/design/specs/tasks referenced
- [ ] 10.2 `openspec archive stable-source-keys` after merge
