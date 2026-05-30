# src/domain/pruning/

## Responsibility

Apply all active runtime pruning to the message array on each `context` pass: compression-block replacement, deduplication, error purging, explicit tool-output tombstoning, and visible-ref injection. Produce the final array fed to the provider.

## Design

### Roles and ID eligibility

- **`ID_ELIGIBLE_ROLES`** = `{user, toolResult, bashExecution}` — assistant is excluded.
- **`PASSTHROUGH_ROLES`** = `{compaction, branch_summary, custom_message}` — passed through unchanged.
- Skipping assistant messages preserves the provider prefix cache: mutating freshly generated model output on every turn would invalidate it.

### `ALWAYS_PROTECTED_DEDUP`

`{compress, write, edit}` — these tools are never deduplication-tombstoned regardless of fingerprint collision.

### Bucket gating

Tombstoning decisions (dedup + error purge) are bucketed against `floor(currentTurn / pruneCadenceTurns) * pruneCadenceTurns`. With default cadence `1` this is per-turn; higher values batch transitions so at most one prefix-cache break fires per N turns. The gate is pure and stateless — reloads cannot produce a spurious flush.

### Logical turns

One standalone visible message = one turn. One assistant tool-batch + matching tool results = one turn. Used for nudge debounce, error-purge age, and hot-tail protection.

## Flow

```text
applyPruning(messages, state, config)
  └─ deep-clone messages (isolate mutations across context events)
  └─ stripGeneratedDcpHallucinations()
  └─ countLogicalTurns() → state.currentTurn
  └─ applyCompressionBlocks()          ← replaces covered spans with bN blocks
  └─ finalizeMaterializedMessages(msgs, state, config, { turnMessages })
        ├─ stripGeneratedDcpHallucinations()
        ├─ countLogicalTurns()         ← may differ after block injection
        ├─ repairOrphanedToolPairs()   ← safety net: atomic assistant+result removal
        ├─ applyDeduplication()         ← mutates state.prunedToolIds (bucket-gated)
        ├─ applyErrorPurging()         ← mutates state.prunedToolIds (bucket-gated)
        ├─ applyToolOutputPruning()     ← replaces content in state.prunedToolIds matches
        └─ injectMessageIds()           ← visible refs on user/toolResult/bashExecution only
  └─ returns pruned message array
```

### injectMessageIds detail

Walks messages in ordinal order. For each `ID_ELIGIBLE_ROLES` entry:

1. Builds a stable `sourceKey` (prefers `__dcpSourceKey` internal property; falls back to `buildSourceItemKey`).
2. Allocates a dense `mNNNN` ref via `allocateMessageRef`.
3. Derives `ownerKey` from `__dcpOwnerKey` or `buildSourceOwnerKey`.
4. Injects the ref as a metadata tag appended to `msg.content`.
5. Records `{ref, sourceKey, timestamp, ownerKey}` in `messageRefSnapshot` and `messageOwnerSnapshot`.

Assistant messages receive no ref, no content mutation, no snapshot entry.

Legacy `m001`–`m999` aliases are added for transitional compatibility with tests/prompts that use padded short forms.

## Integration

| Caller                                  | Used from                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/application/session-handler.ts`    | `applyPruning`, `getNudgeType`, `exceedsMaxContextLimit`, `finalizeMaterializedMessages` |
| `src/domain/compression/`               | `resolveCompressionRangeIndices`, `estimateTokens`, `resolveCompressionRangeIndices`     |
| `src/domain/nudge/`                     | re-exports nudge helpers from this module                                                |
| `src/domain/provider/payload-filter.ts` | reads `state.messageOwnerSnapshot` + live owner map for stale artifact filtering         |
| `src/application/compress-tool/`        | reads `state.messageRefSnapshot` for visible-ref validation during block creation        |
