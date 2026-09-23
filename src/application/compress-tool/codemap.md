# src/application/compress-tool/

## Responsibility

`registration.ts` wires `compress` into Pi and coordinates validation, historical block creation, persistence and native-compaction scheduling. Pure range, artifact and planning helpers live in `src/domain/compression/tooling.ts`; there are no forwarding modules here.

## Flow

1. Read the active branch and resolve visible `mNNNN` or `bN` boundaries. Pull assistant/tool-result groups in atomically.
2. Validate source coverage, ordering and the protected logical-turn tail. Partial ambiguous overlap rejects.
3. Build metadata and identify fully covered blocks to supersede. A single `bN..bN` range is a supported rewrite.
4. Use the authored replacement summary directly. Optional explicit `(bN)` quotations insert a covered active block once; invalid, repeated or out-of-range insertions reject before commit. Historical replay retains its older tolerant expansion.
5. Retire fully covered blocks and append the new record, preserving exact source keys and canonical history. Update savings and flush state inline.
6. Evaluate the existing native-compaction trigger and return the resulting block IDs/planning hints. Compaction runs separately; consolidation does not add another model call or background summarizer.

## Integration

- Domain: `compression/tooling`, `transcript`, `pruning` context limits.
- Pi: tool registration, current branch, context usage, UI notifications.
- State: blocks, stable source-key coverage, counters and persistence through `session-handler`.
- Native compaction: existing trigger/coverage configuration remains unchanged.
