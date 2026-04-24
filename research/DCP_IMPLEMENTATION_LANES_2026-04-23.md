# DCP implementation lanes

Date: 2026-04-23
Purpose: break the roadmap into parallelizable work lanes with concrete files, symbols, risks, and exit criteria.

## Lane A — Owner leakage and provider payload filtering

### Goal

Stop exposing internal source owner keys to the model while preserving deterministic hidden/provider artifact pruning.

### Files / symbols

- `pruner.ts`
  - `INTERNAL_OWNER_KEY`
  - `injectMessageIds(messages, state)`
  - `applyPruning(messages, state, config)`
- `payload-filter.ts`
  - `extractMessageLikeText(message)`
  - `extractCanonicalOwnerKeyFromMessageLike(message)`
  - `findLastCanonicalOwnerMarker(text)`
  - `filterProviderPayloadInput(input, liveOwnerKeys, compressionBlocks)`
- `transcript.ts`
  - `buildSourceOwnerKey(ordinal)`
  - `buildBlockOwnerKey(blockId)`
  - `buildLiveOwnerKeys(messages, compressionBlocks)`
- `index.ts`
  - `context` hook live-owner computation
  - `before_provider_request` hook
- `pruner.test.ts`
  - owner extraction and provider payload filtering tests around ~1500+
- `ISSUE_dcp-owner-agent-visibility.md`

### Current failure modes

1. `dcp-owner` is rendered into ordinary model-visible text.
2. Payload filtering scans all message-like text for owner tags, so quoted/hallucinated tags can become authoritative.
3. Live owner keys are computed before materialization and then cached for a later provider request.
4. The model can learn the protocol and leak/amplify it into tool args or text, as seen in the repeated owner-parameter incident.

### Near-term patch sequence

1. Add a test that asserts agent-facing output from `applyPruning()` does not contain `<dcp-owner>` once the new behavior is enabled.
2. Add a test with user/assistant content containing:
   - `<dcp-owner>s0</dcp-owner>`
   - `<parameter name="owner">s47</parameter>` repeated many times
   - quoted compressed-block summaries containing stale owner tags
3. Split ownership extraction into two paths:
   - block ownership from DCP-rendered compressed-block metadata only
   - source ownership from canonical liveness, not message text
4. Remove owner tag rendering from `injectMessageIds()`.
5. Recompute/carry live owners from the materialization result used for the actual outbound prompt.
6. Add defensive DCP-tag hallucination scrub/ignore logic for provider metadata extraction; do not destructively edit legitimate user text unless the context is known to be DCP-injected metadata.

### Exit criteria

- No `dcp-owner` appears in normal model-visible transcript content.
- Stale provider artifacts still disappear when their canonical source/block owner is compressed.
- User-authored literal tags do not cause owner misattribution.
- The repeated-owner incident is represented as a regression fixture.

### Open design choice

Whether to keep any block owner marker visible. The likely answer is: keep `bN`/`dcp-block-id` only as an agent-facing compressed-block reference, but never use arbitrary text extraction from summaries as the source of truth.

---

## Lane B — Canonical v2 materialization

### Goal

Make the active runtime path match the v2 invariant:

```text
canonical transcript + active blocks -> deterministic rendered transcript
```

### Files / symbols

- `transcript.ts`
  - `TranscriptSnapshot`
  - `TranscriptSourceItem`
  - `TranscriptSpan`
  - `buildTranscriptSnapshot(messages)`
  - `buildSourceItemKey(message, ordinal)`
  - `countLogicalTurns(messages)`
- `materialize.ts`
  - `renderCompressedBlockMessage(block, options?)`
  - `materializeTranscript(snapshot, blocks)`
- `state.ts`
  - `CompressionBlock`
  - `CompressionBlockV2`
  - `CompressionBlockMetadata`
  - `DcpState.compressionBlocksV2`
- `compress-tool.ts`
  - range resolution
  - exact metadata creation
  - supersession planning
- `pruner.ts`
  - legacy `applyCompressionBlocks()` and repair logic
- `migration.ts`
  - `mapLegacyBlockToSpanRange()`
  - `restorePersistedState()`

### Current failure modes

1. V2 scaffolding exists but is not active.
2. Runtime still uses timestamp ranges and array splice/repair.
3. `compressionBlocksV2` is persisted/restored but not populated by new compress calls.
4. Hidden artifact liveness partly depends on rendered owner markers rather than canonical materialization output.

### Proposed phases

#### Phase B1 — materializer behind a flag

Implement `materializeTranscript()` so it can render active v2 blocks against spans without replacing the current runtime path by default.

Expected return shape:

```ts
type MaterializedTranscript = {
  messages: any[]
  renderedBlockIds: number[]
  liveOwnerKeys: Set<string>
  coveredSourceKeys: Set<string>
}
```

Keep this internal at first; exact type can evolve.

#### Phase B2 — parity tests

Create fixtures where v1 blocks and equivalent v2 blocks produce the same visible transcript. Include:
- standalone message range
- assistant tool-call + tool results
- compressed block supersession
- partial overlap rejection
- protected tail

#### Phase B3 — write new blocks as v2

Teach `compress-tool.ts` to resolve visible range -> canonical span closure -> `CompressionBlockV2`. Keep v1 reads/migration.

#### Phase B4 — route context through materializer

Change `index.ts` context hook to use canonical materialization for enabled sessions. The result should feed both outbound messages and `state.lastLiveOwnerKeys`.

#### Phase B5 — retire v1 splice path

After parity and migration tests pass, remove or quarantine:
- `applyCompressionBlocks()`
- timestamp anchor reinsertion
- orphan repair safety net that becomes unnecessary with span closure

### Exit criteria

- Repeated context passes with no new source messages and no new compressions are byte-stable.
- Tool exchanges are atomic by construction.
- Active block stats are derived from materialization/blocks.
- V1 state loads safely, but new transactions use v2.

---

## Lane C — Range anchoring, validation, persistence, clone safety

### Goal

Close the blocking correctness bugs before broad architecture work.

### Files / symbols

- `compress-tool.ts`
  - `resolveIdToTimestamp(id, state)`
  - `resolveAnchorTimestamp(endTimestamp, state)`
  - `buildCompressionPlanningHints(...)`
  - overlap validation in execute path
- `index.ts`
  - `cloneRenderedMessages(messages)`
  - `session_start` restore loop
  - `saveState(ctx, state)`
- `migration.ts`
  - `serializePersistedState(state)`
  - `restorePersistedState(data)`
- `state.ts`
  - `tokensSaved`
  - `totalPruneCount`
  - `prunedToolIds`
- `pruner.test.ts`

### Patch sequence

1. Replace `cloneRenderedMessages()` with `structuredClone` fallback helper, or remove it if materializer already returns a safe clone.
2. Fix restore loop to select the semantically correct persisted `dcp-state` entry once.
3. Change anchor resolution to use raw current messages/source keys, not `messageIdSnapshot`.
4. Reject stale/missing IDs before range math.
5. Reject ranges containing no raw source messages.
6. Add explicit same-range retry message.
7. Clear/reconcile `prunedToolIds` on decompression.

### Tests

- Multiple `dcp-state` entries: restore result is deterministic and counters do not drift.
- Nested content mutation after `state.lastRenderedMessages` assignment does not mutate cached state.
- End-at-tail compression does not invent colliding timestamps.
- `bN..bN` self-compress rejects.
- Same-range retry gives retry-specific error.
- `serializePersistedState()` / `restorePersistedState()` preserves Set/array semantics.

### Exit criteria

- The three blocking findings B-1/B-2/B-3 are closed with tests.
- Compression validation errors include actionable safe ranges.

---

## Lane D — Provider-native edits and proxy/eval harness

### Goal

Measure DCP’s real token/cache behavior and prototype provider-native context editing where it helps.

### Files / external artifacts

- `index.ts`
  - `before_provider_request` hook
- `payload-filter.ts`
  - request item filtering
- `debug-log.ts`
  - JSONL diagnostics
- `state.ts`
  - compression metadata / metrics shape
- `/Users/blaz/Programming_local/Projects/sessionloom/scripts/llm-proxy.ts`
  - capture proxy
- `/tmp/pi-llm-proxy-help.txt`

### Measurement first

Before changing provider payload semantics, build a small correlation script:

```text
DCP debug event timestamps + proxy usage captures -> CSV/Markdown report
```

Minimum report columns:
- request timestamp
- provider/model
- input tokens
- output tokens
- cache read tokens
- cache write tokens
- DCP active block count
- estimated saved tokens
- compress event within +/- N seconds
- provider payload items removed

### Provider-native edit prototype

Anthropic experiment gates:
- config flag disabled by default
- provider/model detection
- beta headers only when enabled
- safe fallback to current behavior

Candidate edits:
- clear stale tool uses/results covered by active blocks
- clear stale thinking/reasoning artifacts
- optionally use server-side compaction only for known-safe thresholds

### Proxy experiments

1. Baseline normal coding session with DCP enabled.
2. Same with owner marker rendering disabled.
3. Same with nudge mutation disabled/standalone.
4. Same with provider-native edit prototype.
5. Compare token/cache metrics.

### Exit criteria

- A repeatable command produces a report from proxy captures.
- Provider edit prototype demonstrates measurable cache-write reduction or is rejected with evidence.
- Eval captures include marker-leakage checks.

---

## Lane E — Large tool output and dedup before context pollution

### Goal

Prevent avoidable token mass from entering durable session history.

### Files / symbols

- `index.ts`
  - `tool_result` hook if mutation is supported by Pi API
  - `tool_call` / `tool_call.input` hooks if blocking/mutation is supported
- `config.ts`
  - new thresholds and artifact directory config
- `compress-tool.ts`
  - activity logs should point to artifact previews/hashes
- `README.md`
  - user-facing behavior
- `pruner.test.ts`
  - unit fixtures for offload/truncation helpers

### Implementation shape

1. Add pure helper for middle truncation:
   - preserve head + tail
   - include omitted byte/char count
   - stable output for same input
2. Add pure helper for artifact path generation:
   - safe base dir
   - session/block/tool-call scoped names
   - hash in filename or metadata
3. Rewrite oversized tool results before storage:
   - full content to disk
   - bounded preview in transcript
   - path/hash in result
4. Add semantic/normalized tool-call dedup later:
   - exact args first
   - canonical path normalization
   - command equivalence only after enough captures

### Exit criteria

- Huge tool output no longer persists in full transcript by default.
- Users can locate the full artifact.
- Compression summaries include enough artifact provenance to recover context.

---

## Suggested sequencing

### Wave 0 — immediate safety

- Lane A: hide owner leakage + tests.
- Lane C: B-1/B-2/B-3 fixes + tests.

### Wave 1 — measurement rail

- Lane D: proxy correlation report.
- Add debug-log fields needed for correlation.

### Wave 2 — cache-stable runtime

- Lane B: materializer behind flag + parity tests.
- Lane F: standalone nudges and stable visible aliases.

### Wave 3 — cost reduction

- Lane D: provider-native edit prototype.
- Lane E: tool output offload.

### Wave 4 — contract simplification

- Remove `(bN)` placeholder burden.
- Retire or fully migrate v1 blocks.
- Update prompts/docs.
