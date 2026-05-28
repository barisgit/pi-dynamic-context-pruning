# `src/domain/replay/` — codemap

## Purpose

Reconstructs a full `DcpState` from any compatible branch-entry array (full session JSONL,
or live `event.messages` wrapped as `{type:'message', message}`). Replay is the
persistence story for **dcp-replay-v3**: the on-disk `dcp-state` entry is a tiny scalar
bootstrap; the real block log, tool-call records, and lifetime savings are rebuilt by
walking and interpreting DCP-significant events embedded in the transcript.

---

## Public API

### `replayDcpState(branchEntries, config, options?): DcpState`

Top-level entry point. Walks `branchEntries` chronologically, maintains an in-flight
`messages` buffer, and reconstructs:

- `state.toolCalls` — all assistant `toolCall` blocks + `toolResult` metadata
- `state.compressionBlocks` — blocks produced by each successful `compress` invocation
- `state.lifetimeTokensSavedRealized` — savings baked by `dcp-native-compaction` entries
- `state.tokensSaved`, `state.currentTurn`, `state.prunedToolIds` — finalized by a
  trailing `applyPruning` pass

Soft-tolerant: malformed entries are skipped, not thrown.

### `ReplayDcpStateOptions`

```ts
interface ReplayDcpStateOptions {
  state?: DcpState; // pre-allocated state; caller is responsible for resetState()
}
```

---

## Algorithm Sketch

1. **Entry classification** — each entry is mapped to a `DcpMessage` or skipped:
   `message` → the inner message; `custom_message` / `branch_summary` /
   `compaction` → synthetic wrapper; everything else → skipped.

2. **Assistant messages** — `recordAssistantToolCalls` registers every
   `toolCall` block in `state.toolCalls` with `turnIndex = currentTurn`.

3. **toolResult messages** — `recordToolResult` updates the matching `ToolRecord`
   (error flag, timestamp, token estimate). Detects a successful `compress` by
   checking `toolName === "compress"` or the stored record.

4. **Compress invocation replay** — when a `compress` tool result is detected,
   `findCompressInvocation` locates the matching assistant `toolCall` block in
   the in-flight buffer and parses its args. `applyCompressInvocation` is then
   called against `messages.slice(0, -1)` (the buffer _before_ the tool result,
   matching what the live execute path observed):
   - `validateCompressionRangeBoundaryIds` — rejects malformed ranges
   - `resolveIdToTimestamp` / `resolveIdToSourceKey` — resolve `mNNNN` boundary refs
   - `expandBlockPlaceholders` — expand `(bN)` in summary text
   - `buildCompressionArtifactsForRange` — build activity log + exact canonical metadata
   - `resolveSupersededBlockIdsForRange` — exact-coverage supersession check; throws on
     partial-ambiguous overlap
   - block created, active blocks deactivated if superseded, `tokensSaved` recomputed
   - `estimateCreationSavings` computed against pre-result snapshot

5. **Native compaction** — `dcp-native-compaction` entries call `applyNativeCompaction`:
   deactivates represented `CompressionBlock`s, transfers their `savedTokenEstimate` into
   `lifetimeTokensSavedRealized`, resets `lastCompressTurn` / `lastNudgeTurn` to `-1`.

6. **Finalization** — `applyPruning(messages, state, config)` runs once after the walk
   to finalize `state.currentTurn`, dedup tombstones (`state.prunedToolIds`), and
   error-purge tombstones.

---

## Call Sites

| Caller               | Path                       | Role                                                           |
| -------------------- | -------------------------- | -------------------------------------------------------------- |
| `session-handler.ts` | `restoreStateFromBranch`   | Legacy restore path; guarded by `branchIsReplayable()`         |
| `context-handler.ts` | lazy replay (current path) | Replays on first `context` pass when persisted state is absent |

---

## Tests

`tests/unit/replay.test.ts` — unit coverage for entry classification, tool-call
bookkeeping, compress invocation replay (success, supersession, malformed ranges),
native compaction, and the final `applyPruning` finalization pass.
