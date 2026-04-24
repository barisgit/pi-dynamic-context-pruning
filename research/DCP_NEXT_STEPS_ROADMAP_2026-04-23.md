# DCP next-steps roadmap

Date: 2026-04-23
Scope: long-running research / implementation planning for `pi-dynamic-context-pruning`

## Executive direction

DCP should move from a hybrid timestamp/pruning system toward a deterministic context-management runtime:

> canonical transcript + active compression transactions + provider-aware request shaping -> stable outbound context

The top priority is not adding more compression modes. It is making the current core safer, less leaky, and measurable. Once correctness is locked down, the highest leverage work is cache-stable materialization and provider-native context edits.

## Priority stack, most influential first

### 1. Stop internal marker leakage

**Why it matters:** This is both a correctness issue and a model-behavior issue. The observed subagent run that repeated `<parameter name="owner">s47</parameter>` hundreds of times is live evidence that protocol-like ownership metadata can contaminate generation.

**Current flow:**
- `pruner.ts::applyPruning()` attaches non-enumerable `__dcpOwnerKey = buildSourceOwnerKey(ordinal)`.
- `pruner.ts::injectMessageIds()` renders both `<dcp-id>` and `<dcp-owner>` into ordinary message text.
- `payload-filter.ts::extractCanonicalOwnerKeyFromMessageLike()` scans message-like text for `<dcp-owner>` / `<dcp-block-id>` and treats the last marker as authoritative.

**Target:**
- `dcp-id` remains the visible range contract.
- `dcp-owner` becomes internal-only.
- Payload filtering derives ownership from canonical structures or DCP-owned metadata, not arbitrary model-visible text.

**Near-term implementation shape:**
1. Remove `<dcp-owner>` rendering from `injectMessageIds()`.
2. Store rendered-message owner metadata outside agent-visible text, or derive direct owners from canonical snapshot + materialized order.
3. Restrict `payload-filter.ts` marker extraction to DCP-owned block renderers only, not arbitrary user/model text.
4. Add a defensive scrubber for hallucinated DCP-like tags in assistant text/tool args before ownership derivation.
5. Keep `<dcp-block-id>` only where the compressed block itself needs a visible/referenceable identity; do not let block summary body quotes steal ownership.

**Acceptance tests:**
- `applyPruning()` output contains no `<dcp-owner>` tags.
- Literal user text containing `<dcp-owner>s0</dcp-owner>` is preserved and does not affect filtering.
- Repeated `<parameter name="owner">s47</parameter>` in assistant/tool text is treated as ordinary text or scrubbed, never as canonical ownership.
- `filterProviderPayloadInput()` still removes stale `reasoning`, `function_call`, and `function_call_output` for compressed owners.

---

### 2. Promote deterministic canonical materialization

**Why it matters:** Most current complexity exists because v1 mutates arrays by timestamp and repairs structural damage afterward. V2’s span model is already partially present; making it active is the clean architectural unlock.

**Current split:**
- Runtime path: `state.compressionBlocks` + timestamp boundaries + `pruner.ts::applyCompressionBlocks()`.
- Scaffolding path: `transcript.ts::buildTranscriptSnapshot()` + `CompressionBlockV2` + `materialize.ts::materializeTranscript()` stub.

**Target:**

```text
raw source messages
  -> buildTranscriptSnapshot()
  -> resolve active blocks against canonical spans
  -> materializeTranscript()
  -> inject visible IDs
  -> provider payload filtering from same canonical liveness
```

**Phases:**
1. Implement real `materializeTranscript(snapshot, blocks)` for active v2 blocks.
2. Add tests proving deterministic repeated materialization.
3. Teach `compress-tool.ts` to create v2 blocks from visible ranges resolved to `TranscriptSpan` keys.
4. Keep v1 blocks read-only for migration; stop creating new v1 blocks.
5. Remove/retire v1 splice/repair logic only after parity tests are green.

**Acceptance tests:**
- Same source + same blocks produces byte-identical materialized output across repeated passes.
- Tool-exchange spans are removed atomically without repair logic.
- Full supersession of older exact blocks works; partial ambiguous overlap rejects.
- Restart restore -> rematerialize gives same rendered transcript.

---

### 3. Fix anchor/range correctness

**Why it matters:** Incorrect anchors can corrupt where compressed blocks reappear and can make retry behavior confusing or unsafe.

**Current issue:**
- `compress-tool.ts::resolveAnchorTimestamp()` derives placement from `state.messageIdSnapshot`, which is the visible subset and can be stale/rotating.
- If the range ends at the last visible message, it invents `endTimestamp + 1`.

**Target:**
- Anchor from raw source order, stable source keys, or session entry IDs.
- Visible IDs are aliases, not the source of truth.

**Near-term implementation shape:**
1. Change anchor resolution to accept `currentMessages` and derive from raw source list.
2. Reject missing/stale IDs before any block creation.
3. Reject `bN..bN` self-compression / no-raw-message ranges.
4. Improve overlap errors to distinguish same-range retry from genuine partial overlap.

**Acceptance tests:**
- Compression ending at latest visible message uses a real placement anchor or explicit append semantics.
- Two trailing compressions do not collide on invented timestamps.
- Stale/missing IDs fail with a clear message and safe candidate ranges.
- Ranges containing only blocks are rejected.

---

### 4. Make `compress` the only durable pruning transaction

**Why it matters:** Hidden mutations outside `compress` make state hard to reason about and violate the v2 invariant that materialization is stable between compresses.

**Current drift:**
- `state.prunedToolIds` can survive decompression.
- Dedup/error purging happen opportunistically in `applyPruning()`.
- Nudges mutate live message content.

**Target:**
- Between compresses, outbound context is deterministic.
- Pruning/removal of visible text, hidden artifacts, stale reminders, and tool ballast occurs only when a compression-like transaction commits.

**Near-term implementation shape:**
1. Clear/reconcile `prunedToolIds` when blocks decompress.
2. Move dedup/error-purge from durable state mutation to either render-only annotations or explicit compress/prune transactions.
3. If adding a bounded `prune` tool, make it transactional and supersession-aware.
4. Make stats derived from active blocks/materialization, not accumulated counters.

**Acceptance tests:**
- Decompressing a block restores related tool outputs or removes stale tombstones.
- Repeated `context` passes do not change durable state.
- `tokensSaved` remains stable across repeated renders.

---

### 5. Adopt provider-native context edits where available

**Why it matters:** Replacement-style compression likely invalidates provider prompt caches from the compression point forward. Anthropic now exposes native context editing/compaction primitives that can remove tool/thinking ballast while preserving more cache structure.

**Known relevant Anthropic features to prototype:**
- `clear_tool_uses_20250919` with beta `context-management-2025-06-27`.
- `clear_thinking_20251015`.
- `compact_20260112` with beta `compact-2026-01-12`.

**Target:**
- DCP remains provider-portable, but uses provider-native edits opportunistically.
- The provider edit layer is measured by proxy captures before being promoted.

**Prototype shape:**
1. Add experimental request-shaping module, e.g. `provider-context-edits.ts`.
2. In `before_provider_request`, detect Anthropic payloads and enabled config.
3. Compute clearable tool/thinking artifacts from active blocks’ exact metadata.
4. Add beta headers/request fields only when safe.
5. Compare cache read/write behavior with and without the experiment using `llm-proxy`.

**Acceptance tests/experiments:**
- Provider edit payload is only emitted for supported provider/model shapes.
- Failed/unsupported edit path falls back to normal DCP materialization.
- Proxy metrics show cache read/write deltas around compress events.

---

### 6. Preserve prompt-cache stability in DCP-owned rendering

**Why it matters:** Even when provider-native edits are unavailable, DCP should avoid needless churn in old prompt text.

**Current issue:**
- `pruner.ts::injectNudge()` mutates the latest message content.
- Rotating `mNNN` IDs can change references after materialization shifts.

**Target:**
- No mutation of historical message bodies for nudges.
- Stable visible aliases for source messages over a session.

**Implementation shape:**
1. Render nudges as deterministic standalone advisory/suffix messages, not appended text.
2. Persist `sourceKey/sessionEntryId -> mNNNN` visible aliases in state.
3. New source messages get new aliases; old aliases survive compression/decompression.
4. Keep visible block IDs stable as `bN`.

**Acceptance tests:**
- Same source + same state gives stable message IDs across repeated context passes.
- A cited `mNNN` continues to resolve to the same source item unless that item was compressed.
- Nudge firing does not mutate prior message content.

---

### 7. Handle large tool output before it enters long-term context

**Why it matters:** Compressing huge tool outputs after they have already polluted many turns is late. Pi hooks can rewrite tool results before storage.

**Target:**
- Oversized tool outputs become disk artifact + preview + path at ingestion time.
- CLI output truncation keeps head and tail, not suffix only.

**Implementation shape:**
1. Add config: `toolOutputOffloadThresholdBytes`, `toolOutputPreviewChars`, `toolOutputArtifactDir`.
2. Use the `tool_result` hook where Pi supports mutation.
3. Persist raw output to a safe project/session-local artifact path.
4. Replace stored result content with summary/preview/path/hash.
5. Include artifact path and hash in compression block activity logs.

**Acceptance tests:**
- Oversized result is written once and represented by bounded preview.
- Small result remains inline.
- Preview contains head + tail.
- Artifact path is safe and does not leak outside configured directory.

---

### 8. Fix persistence/state restoration and clone safety

**Why it matters:** These are release-blocking correctness bugs that can cause divergence after restart or mutation leakage between hooks.

**Fixes:**
1. `index.ts` session restore should restore the semantically correct/latest state entry only, not replay every `dcp-state` entry.
2. `cloneRenderedMessages()` should use `structuredClone` or be replaced with a guaranteed deep clone from materialization.
3. Stats should be derived where possible.
4. `serializePersistedState()` / `restorePersistedState()` should have equality tests for Sets/Maps/arrays.

**Acceptance tests:**
- Multiple persisted `dcp-state` entries restore deterministically.
- Mutating nested content after snapshot storage does not mutate `state.lastRenderedMessages`.
- Set/array round trip for `prunedToolIds` remains correct until that state is retired.

---

### 9. Tighten compression UX and validation

**Why it matters:** The agent should get clear, bounded failure modes. Ambiguous overlap and stale ID behavior should not require reading internals.

**Target:**
- Errors are action-guiding and include safe alternatives.
- The agent contract is simple: pick a closed visible range, summarize it, call `compress`.

**Implementation shape:**
1. Keep protected-tail planning hints but make them concise.
2. Reject stale IDs and list currently visible safe ranges.
3. Reject no-op/self-compression explicitly.
4. Remove `(bN)` placeholder burden from the long-term agent contract once v2 supersession handles lineage.

**Acceptance tests:**
- Protected-tail rejection includes hot-tail start and safe candidates.
- Same-range retry gets a retry-specific error.
- Partial ambiguous overlap gets a different error.

---

### 10. Build proxy-backed eval/regression harness

**Why it matters:** DCP needs measurement: token savings, cache hit-rate, provider payload filtering effect, marker leakage, and prompt churn.

**Inputs available today:**
- `~/.pi/log/dcp.jsonl` from `debug-log.ts`.
- Proxy captures from `/Users/blaz/Programming_local/Projects/sessionloom/scripts/llm-proxy.ts`.
- Proxy usage files with input/output/cache tokens.

**Artifacts to build:**
1. `scripts/dcp-proxy-report.ts`: correlate DCP debug events with proxy `.usage.json` files; emit CSV/Markdown.
2. `scripts/replay-proxy-capture.ts`: replay captured request shapes through DCP materialization/filtering and assert invariants.
3. `research/eval-captures/README.md`: define capture naming, redaction, and comparison protocol.

**Metrics:**
- input tokens before/after compress
- cache read tokens before/after compress
- cache write tokens after compress
- provider payload items removed by `filterProviderPayloadInput`
- bytes/tokens spent on DCP metadata
- nudge overhead
- block summary overhead
- marker leakage incidents

**Acceptance experiments:**
- Baseline a realistic coding session with DCP enabled.
- Repeat with owner markers hidden.
- Repeat with provider-native context edits enabled.
- Compare cache stability and token deltas.

## Recommended first implementation wave

Do these before large architecture migration:

1. Hide owner markers and harden marker extraction.
2. Fix B-1/B-2/B-3 anchor/restore/clone bugs.
3. Add exact regression tests for the observed owner-loop failure.
4. Add proxy metrics correlation script to measure cache impact.
5. Start v2 materialization behind a feature/config flag.

This order reduces active risk while creating measurement and migration rails for the bigger rewrite.
