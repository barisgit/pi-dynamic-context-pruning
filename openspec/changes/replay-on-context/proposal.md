## Why

The existing replay engine runs at `session_start` against the full session
JSONL branch entries. The agent's compress arguments were composed against pi's
post-compaction in-memory message buffer (which `context` events deliver) — a
much smaller buffer with different ordinals, possibly different
ref-allocation policy, and missing pre-compaction history that pi has
already collapsed. Replay's environment does NOT match the environment the
live agent saw at compress time, so `mNNNN` refs in compress arguments
silently fail to resolve. Concrete impact on the active session: 7-11 of 31
compress ranges silently dropped, recent active blocks lost on every
restart, context jumping 89k → 200k+ after a reload.

Two earlier attempts (stable content-derived source-keys; legacy-assistant
ref allocation parity) both failed because they tried to make replay's full-
branch reconstruction MATCH live's smaller-buffer reconstruction. They can't
match exactly without persisting additional bookkeeping.

The real fix is to move replay INTO the live environment. Pi's `context`
event delivers `event.messages` — the same buffer the agent composed
compress args against. Running replay there guarantees identical ordinals,
identical visibility, identical ref allocation, and identical block
reconstruction with zero new persistence.

## What Changes

- Replace the eager `session_start` replay with a scalar-only restore: from
  the latest `dcp-state` entry, restore turn counters, `prunedToolIds`, and
  `lifetimeTokensSavedRealized`. No block reconstruction at start.
- Add lazy replay on the first `context` event after restore: when
  `state.compressionBlocks` is empty and `event.messages` contains compress
  toolResults, replay those compress invocations against `event.messages`.
- Keep native-compaction entry processing where it is in `event.messages` —
  pi delivers compaction summaries inline, and the existing live
  `session_compact` hook continues to deactivate represented blocks the
  moment they're baked.
- Keep snapshot-fallback path for pre-v3 sessions that have no replayable
  transcript. Those restore fully at `session_start` as before.
- **BREAKING (internal):** between `session_start` and the first `context`
  event, `state.compressionBlocks` will be empty. No agent turn happens in
  that window so nothing observable changes; the only consumer that runs in
  it is the status indicator, which will display 0 active blocks until the
  first context pass populates them.
- Remove the `legacyAssistantRefs` knob added during the previous fix
  attempt — replay now runs in live mode, no policy divergence.
- Remove the source-key content-hash fallback added during the previous fix
  attempt — replay's buffer is identical to live's, so the legacy ordinal
  fallback works correctly again. Leave the `INTERNAL_BLOCK_ID` /
  `INTERNAL_NUDGE_TURN` synthetic-key paths in place (they're independent
  improvements with no downside).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `stable-visible-references`: tighten "Reference remains stable across
  context passes" so the stability guarantee is anchored to the live
  message buffer, with replay running in the same environment.
- `source-key-anchoring`: relax the "deterministic function of message
  contents, never buffer position" requirement added in the previous
  proposal — buffer position is fine as long as replay and live share the
  same buffer. Drop that proposal entirely (it never shipped).

## Impact

- `src/application/session-handler.ts` — `restoreStateFromBranch` no longer
  calls `replayDcpState`. Becomes scalar-only restore. Snapshot fallback
  path stays. Add a `replayPending: boolean` flag to `DcpState` so the next
  `context` handler knows to run lazy replay once.
- `src/application/context-handler.ts` — at the top of the `context` event
  handler, if `state.replayPending`, run `replayDcpState` against
  `event.messages` and clear the flag. Then proceed with normal pruning.
- `src/types/state.ts` — add `replayPending: boolean` to `DcpState`.
- `src/state.ts` — initialize `replayPending: true` in `createState` so
  fresh sessions also run lazy replay on first context (cheap, idempotent).
  Reset to `false` after each lazy replay run.
- `src/domain/replay/index.ts` — `replayDcpState` already accepts an
  arbitrary entry list. We'll call it with the live `event.messages`
  wrapped as branch-entry-shaped items, OR factor out the inner walker so
  it consumes raw message arrays directly. Keep public API stable.
- `src/domain/pruning/index.ts` — revert `legacyAssistantRefs` option
  added during the previous attempt; `injectMessageIds` returns to its
  pre-fix signature.
- `src/domain/transcript/index.ts` — keep `INTERNAL_BLOCK_ID` /
  `INTERNAL_NUDGE_TURN` synthetic markers and the `node:crypto` content
  hash helper if cheap enough to keep (or revert if it's dead code after
  the rest of the revert).
- `tests/unit/replay.test.ts` — tests stay structurally the same but
  exercise the new entry point. Add a regression test that replays against
  a buffer mirroring `event.messages` and asserts active block parity.
- `tests/integration/legacy-session-restore.test.ts` — verify the snapshot-
  fallback path still works for pre-v3 sessions with no replayable
  transcript.
- `scripts/replay-equivalence.ts` — script wraps `replayDcpState` directly
  against branch entries, NOT a live message buffer. Document that the
  script measures pre-context replay behavior; it's still useful for
  verifying pre-v3 → v3 restore equivalence on the fat-snapshot path.
- No public API, agent-facing protocol, config, or persisted-state surface
  changes.
- No new dependencies.
