## Context

DCP source-keys are the durable identity of a transcript message. They feed:

- `state.messageAliases` → `mNNNN` visible-ref allocation
- `metadata.coveredSourceKeys` on every CompressionBlock (recorded at compress
  time, consulted on every render pass to splice the right messages out)
- `state.messageRefSnapshot` / `state.messageOwnerSnapshot` (provider-payload
  filtering)

Today `buildSourceItemKey(message, ordinal)` prefers `message.id` when present,
but most pi messages don't carry `.id` on the synthetic message object DCP
operates on — pi keeps the durable id on the **branch entry**, not on the
message payload it hands DCP. So the fallback `msg:<ts>:<role>[:<toolCallId>]:<ordinal>`
runs almost always, and `ordinal` is the message's index in whatever buffer
called us.

Two callers pass two very different buffers for the same logical message:

1. **Live (`context-handler.ts`)**: pi gives us a small post-compaction buffer.
2. **Replay (`domain/replay/index.ts`)**: we walk the full session JSONL
   branch from the beginning — thousands of entries.

→ Same message, different ordinal, different source-key, different `mNNNN`.
Compress-tool arguments the live agent emitted last week fail to resolve on
restart-replay because replay never allocates the matching refs. Measured:
11/31 ranges silently dropped, 6 active blocks → 0 after restart, context
window 89k → 206k+.

This change makes source-keys a deterministic function of the durable pi
session entry id, eliminating ordinal entirely from the steady-state path.

## Goals / Non-Goals

**Goals:**
- A given logical message produces the same source-key regardless of which
  buffer is passed to `applyPruning`.
- Replay restores identical `messageRefSnapshot` / `messageAliases` /
  `coveredSourceKeys` membership compared to what live would produce for the
  same branch.
- Live runtime keeps its existing source-key shape for messages that already
  carry `.id` (no behavior change for the common case).
- The change is a no-op for pre-v3 persisted fat snapshots — they restore via
  the snapshot fallback path which doesn't go through `buildSourceItemKey`.

**Non-Goals:**
- Re-canonicalizing source-keys for already-persisted v1/v2 sessions. Those
  go through snapshot fallback; their fat block payloads are not reprocessed.
- Removing the `legacyAssistantRefs` knob outright. It still has a narrow,
  legitimate use (replaying old sessions whose compress arguments target
  assistant turns when the live runtime today skips assistant ref allocation).
- Adding any new persisted state. Source-keys are recomputed every context
  pass and reproduced on each replay; this change does not enlarge
  `dcp-state` payloads.

## Decisions

### Decision 1: Pi messages have no durable id; use content hash instead

**Recon during design phase disproved the original premise.** Pi's
`AgentMessage` (`UserMessage`, `AssistantMessage`, `ToolResultMessage` in
`pi-ai/dist/types.d.ts`) has no `id` field. Pi entry ids only live on
`SessionEntry` (branchEntries), which DCP receives via `session_*` events
but NOT via the per-pass `ContextEvent`. So the live context handler
cannot recover a pi entry id for a given message.

The key function must therefore depend only on what every call site can
compute from the message itself.

New chain inside `buildSourceItemKey`:

1. `raw:<message.id>` short-circuit for messages that DO arrive with an id
   already set (rare: custom_message entries, future API additions, replay's
   own synthesized objects). Unchanged.
2. `synth:nudge:<turn>` for injected nudge messages (already deterministic
   via the internal nudge-turn marker).
3. `synth:block:b<id>` for materialized compression block messages (already
   deterministic via block.id).
4. `msg:<role>:<ts>:<toolCallId|->:<contentHash16>` — sha256 of
   `JSON.stringify(message.content)`, take first 16 hex. Replaces the
   ordinal entirely. Buffer-position independent.

**Why content hash and not just `<role>:<ts>:<toolCallId>`**: two messages
with identical (role, ts, toolCallId) but different content occur — most
notably when pi retries a tool call or when a debug payload duplicates a
field. Content hash collapses to the same key only when content is identical,
which is the correct semantics.

**Alternative rejected (persist a DCP-assigned message id map)**: would
require writing ~80–100 bytes per message into the persisted dcp-state
entry, blowing the dcp-replay-v3 4 KiB budget linearly with conversation
length. Also doesn't solve the determinism problem on its own — the map
still has to be keyed by something both live and replay can compute, which
brings us back to Decision 1.

**Alternative rejected (carry pi entry ids onto the synthesized message)**:
requires plumbing entry ids through `ContextEvent`, which pi doesn't emit
that event with. We'd need to maintain a side-table updated on `session_*`
events and consulted on every `context` pass. Fragile lifecycle, races on
the restart-then-context-then-tree sequence, and zero benefit over a
content hash since both callers can compute the hash directly.

### Decision 2: Don't change the persisted shape

`dcp-replay-v3` already shrank persistence to a scalar bootstrap;
`metadata.coveredSourceKeys` is never persisted any more. Source-keys for
existing pre-v3 fat snapshots remain untouched. New blocks created post-fix
record new-style source-keys, but those records are in-memory only and
replay regenerates them on every restart.

### Decision 3: Test fixtures stay representative

Existing tests that construct messages without `.id` will start exercising
the content-hash path automatically (which is what real pi messages do).
Add one explicit test that demonstrates the same source-key for the same
message in two buffers of different sizes — the regression that motivated
the change.

## Risks / Trade-offs

- **[Risk]** Content hash could collide for two messages with identical
  content but different intent. **→ Mitigation:** the key includes role,
  timestamp, and (when present) toolCallId in plain text alongside the
  16-hex content hash. Collision requires identical role AND timestamp AND
  toolCallId AND content — the message IS the same in every observable
  way; treating them as one source-key is correct.

- **[Risk]** Blocks created with the old ordinal-keys before this change
  ships will have `coveredSourceKeys` arrays whose entries can no longer be
  resolved against the snapshot once the snapshot uses the new keys.
  **→ Mitigation:** v3 doesn't persist `coveredSourceKeys`. The only path
  that re-reads stale entries is the snapshot fallback for pre-v3 sessions,
  which uses the original ordinal-based keys end-to-end and stays
  internally consistent.

- **[Trade-off]** A content hash adds a small per-message CPU cost
  (sha256 of a stringified payload). Only hit on the fallback path. Live
  steady-state runs through the `raw:<id>` short-circuit and pays nothing.

## Migration Plan

This is a working-tree refactor; no data migration is required.

1. Land the fix on `main` behind no flag.
2. New sessions start using deterministic keys from the first context pass.
3. Existing sessions: on next restart, replay regenerates source-keys with
   the new scheme. Block reconstruction succeeds because compress
   arguments targeted refs derived from the live source-keys at the time —
   and now replay produces identical source-keys → identical refs.
4. Pre-v3 fat snapshots remain restorable via snapshot fallback (their
   in-snapshot source-keys are read verbatim; we never recompute them).

**Rollback**: revert the change; behavior returns to the ordinal-fallback
path. Live continues to function. Replay regresses to the dropped-blocks
state we're fixing.

## Open Questions

None blocking.
