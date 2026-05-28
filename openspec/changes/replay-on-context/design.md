## Context

DCP runs in three places:

1. `session_start` — pi has just loaded the session from disk; we need to
   reconstruct in-memory state from the persisted dcp-state entry plus the
   transcript.
2. `context` (fires before every provider call) — pi delivers
   `event.messages`, the buffer it's about to send to the LLM. DCP applies
   pruning + compression blocks to this buffer and returns the modified
   version pi sends.
3. `before_provider_request` — final pass for provider-payload filtering.

Today's replay-on-start scheme reconstructs `state.compressionBlocks` by
walking the full session JSONL chain (`branchEntries`). That chain contains
every entry pi has ever persisted, including pre-compaction history.
Replay's `applyPruning` calls inside `applyCompressInvocation` operate on a
synthesized message buffer built from those branch entries. That buffer is
NOT the same shape pi delivers to `context` events post-restart:

- It may include pre-compaction messages pi has since collapsed into a
  compaction summary.
- Its ordinal numbering covers entries pi no longer renders.
- Its assistant/user/toolResult interleaving may differ from pi's working
  buffer (custom_message and branch_summary entries interleave differently).

Source-keys in DCP today depend on ordinal as the disambiguator-of-last-
resort (`msg:<ts>:<role>[:<toolCallId>]:<ordinal>`). So replay's buffer →
different source-keys → different `mNNNN` allocation → compress arguments
the live agent emitted from the post-compaction buffer fail to resolve.

The previous attempt to "make source-keys buffer-independent via content
hash" failed because `mNNNN` allocation ORDER also matters — even with
identical source-keys, replay walking 1467 messages while live walked 329
produces refs in a different order, so `m1547` gets bound to a different
source-key in replay than it had in live.

## Goals / Non-Goals

**Goals:**
- Make replay run against the SAME message buffer the live agent saw at
  compress time. Eliminates every class of live-vs-replay drift.
- Zero new persisted state; rely on what pi already keeps in
  `event.messages`.
- Idempotent across multiple `context` events: only the first one after
  restore needs to do reconstruction work; subsequent ones skip.
- Preserve existing pre-v3 snapshot-fallback behavior so legacy sessions
  with no replayable transcript continue restoring.

**Non-Goals:**
- Reconstructing pre-compaction blocks. After pi compacts, the pre-
  compaction messages are no longer in `event.messages`, so their compress
  invocations are unreachable. That's fine: pi's compaction summary
  represents them, and the matching `dcp-native-compaction` entry (still
  in `event.messages`) marks the corresponding blocks inactive. Their
  savings live in `lifetimeTokensSavedRealized` which is persisted.
- Removing replay from `session_start` for non-replayable sessions. Pre-v3
  fat snapshots restore fully at `session_start` via the existing snapshot
  fallback path.
- Migrating session-storage shape.

## Decisions

### Decision 1: Lazy replay triggered by the first `context` event after restore

`session_start` does scalar-only restore: turn counters, `prunedToolIds`,
`lifetimeTokensSavedRealized`. `state.replayPending = true` is set after
restore. The first `context` event sees the flag, runs replay against
`event.messages`, clears the flag.

Alternatives considered:

- **Run replay eagerly at `session_start` with `event.messages` somehow**.
  Pi doesn't expose the live buffer to `session_start`. We'd have to
  construct it ourselves from `branchEntries`, which is exactly today's
  broken path.
- **Run replay on every `context` event**. Wasteful; reconstruction is
  idempotent so we'd just rebuild the same blocks each time. The flag
  keeps it to once per restore.

### Decision 2: Reuse `replayDcpState` with a synthesized branch-entry array

`replayDcpState(branchEntries, config, options)` already accepts an array of
branch entries. We wrap each `event.messages[i]` as `{ type: "message",
message: m }` and pass them. The engine's existing logic for `compaction`
entries doesn't need to fire because pi already collapsed pre-compaction
state before this buffer was built — the buffer either contains the post-
compaction summary as a normal message OR no compaction entries at all.

Native compaction during the live session continues to be handled by the
`session_compact` hook in `native-compaction.ts`, completely separate from
replay.

Alternative considered: factor out an inner `replayFromMessages(messages,
config, state)` helper that doesn't go through the branch-entry wrapping.
Cleaner API but adds a public surface that mirrors the existing one. Not
worth it; the wrapper is three lines.

### Decision 3: Revert the workarounds added during earlier attempts

- `legacyAssistantRefs` option in `injectMessageIds`/`applyPruning` removed.
  Replay now runs in live mode, no policy divergence to compensate for.
- Source-key content-hash fallback in `buildSourceItemKey` reverted to the
  original ordinal-based scheme. Replay's buffer is identical to live's, so
  ordinal-based keys are stable by construction.
- `INTERNAL_BLOCK_ID` synthetic marker stays in `materialize.ts`. It's
  cheap, harmless, and gives block messages a stable identity that survives
  refactoring. Same for `INTERNAL_NUDGE_TURN` if any nudge path needs it
  (currently no nudge messages go through `buildSourceItemKey`).

Alternative considered: keep `legacyAssistantRefs` as a defensive knob in
case the live-vs-replay buffer ever diverges. Rejected — dead knobs rot
quickly and the constraint is enforced naturally by Decision 1 (replay's
input IS the live buffer).

### Decision 4: Pre-v3 sessions keep snapshot-fallback at `session_start`

Sessions written before dcp-replay-v3 have fat snapshot payloads with
`coveredSourceKeys` etc. Those restore fully at `session_start` via the
existing snapshot-walk path. Lazy replay only fires when the session is
deemed "replayable" AND the snapshot fallback didn't recover blocks. Same
gating logic that exists today, just moved into the context handler.

## Risks / Trade-offs

- **[Risk]** The first context event after restore takes slightly longer
  because it now also runs replay. **→ Mitigation:** replay is bounded by
  `event.messages.length` × (small constant per compress). For typical
  sessions (~hundreds of messages, ~10 compresses), this is sub-millisecond.

- **[Risk]** Between `session_start` and the first `context` event, DCP
  status displays "0 active blocks" even when blocks WILL be restored.
  **→ Mitigation:** that window is bounded by pi's startup sequence; no
  agent turn happens in it. The status display is purely informational.

- **[Risk]** If pi ever fires a `before_provider_request` BEFORE the first
  `context` event (e.g., a startup health check), provider-payload
  filtering would run with empty state. **→ Mitigation:** verify by reading
  pi's event order docs; if this is a real concern, also gate replay on
  `before_provider_request` as a backstop. Cheap.

- **[Trade-off]** Branch entries collected by pi between `session_start`
  and the first `context` event are not seen by replay. Acceptable because
  those entries represent the live agent's NEW activity after restart; they
  haven't produced any compress calls yet (the agent hasn't responded
  yet).

## Migration Plan

This is a working-tree refactor; no data migration.

1. Land the change behind no flag.
2. Existing v3 sessions: on next restart, `session_start` becomes a no-op
   for block reconstruction. First `context` event reconstructs blocks
   from the live buffer. Same blocks, same refs, no drift.
3. Pre-v3 sessions: continue restoring via snapshot fallback at
   `session_start`. No behavior change.

**Rollback**: revert this change; replay returns to `session_start`. The
underlying bug returns but doesn't crash anything.

## Open Questions

- Confirm pi's event ordering: does `before_provider_request` always come
  AFTER at least one `context` event in a fresh session? Worth checking in
  recon before implementation.
