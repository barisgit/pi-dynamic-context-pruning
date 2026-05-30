# Domain Layer Codemap

## Responsibility

The `domain/` layer contains pure business logic for Dynamic Context Pruning (DCP). These modules have **no imports** from `@mariozechner/pi-coding-agent`, infrastructure (config loading, debug logging, persistence), or application handlers. They receive plain data (messages, state, config) and return plain data.

This isolation ensures the core pruning/compression semantics are testable, deterministic, and portable across runtime environments.

---

## Subdirectories

### `compression/` — planning & artifact flow

1. `buildTranscriptSnapshot()` → span walk in `buildCompressionPlanningHints()` (passthrough spans extend candidates; hot-tail/covered spans flush them).
2. `validateCompressionRangeBoundaryIds()` → reject raw refs inside active `bN` spans with boundary guidance.
3. `buildCompressionArtifactsForRange()` → activity log + `coveredSourceKeys`/`coveredSpanKeys` metadata.
4. `resolveSupersededBlockIdsForRange()` → exact full-coverage supersession only; partial overlap throws.

Consumed by: `application/compress-tool/registration.ts`, `application/context-handler.ts` (nudge hints).

| File             | Responsibility                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `range.ts`       | Expand timestamp-bounded ranges to include atomic assistant/tool-result groups. Resolve indices from timestamps.                                                                                                     |
| `materialize.ts` | Inert/deferred-dead v2 scaffolding for rendering `CompressionBlockV2` into `DcpMessage`s when `state.schemaVersion === 2`; current persisted v5 runtime uses legacy `compressionBlocks`.                             |
| `metadata.ts`    | Factory for empty `CompressionBlockMetadata` (covered source keys, span keys, tool IDs, file/command stats).                                                                                                         |
| `tooling.ts`     | Core compression helpers: boundary validation (including refs inside active blocks), passthrough-span absorption in planning hints, activity-log/metadata assembly, supersession resolution, protected-tail helpers. |
| `index.ts`       | Re-exports for all submodules.                                                                                                                                                                                       |

**Key types:** `CompressionCandidateRange`, `CompressionPlanningHints` (`candidateRanges`, `totalCandidateCount`, `totalCompressibleTokens`, protected-tail IDs), `CompressionBlockRenderDetail`, `MaterializedTranscript`.

---

### `nudge/`

**Purpose:** Thin re-export of nudge decision logic from the pruning domain.

| File       | Responsibility                                     |
| ---------- | -------------------------------------------------- |
| `index.ts` | Re-exports `getNudgeType` from `pruning/index.ts`. |

---

### `provider/`

**Purpose:** Filter stale hidden artifacts from provider payloads using canonical owner keys.

| File                | Responsibility                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payload-filter.ts` | Derive owner keys from `__dcpOwnerKey` Symbol attached to assistant message objects. Build represented compress receipts. Minify the newest live represented compress exchange to a compact receipt; suppress older represented pairs. Filter `reasoning`, `function_call`, `function_call_output` items by live owner key. No rendered tag dependency. |

**Key types:** `RepresentedCompressCallReceipt`, `RepresentedCompressArtifacts`.

---

### `pruning/`

**Purpose:** Active runtime pruning path applied on every `context` event.

| File       | Responsibility                                                                                                                                                                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` | Orchestrates the full pruning pipeline: deep-clone messages → strip hallucinations → count logical turns → apply compression blocks → repair orphaned tool pairs → deduplication → error purging → explicit tool-output pruning → inject visible message IDs (`mXXXX`) and block IDs (`bN`). Exports `applyPruning`, `finalizeMaterializedMessages`, `getNudgeType`. |

**Key functions:**

- `applyCompressionBlocks` — splice in synthetic block messages, compute net token savings
- `repairOrphanedToolPairs` — safety net: remove orphaned tool results, strip orphaned tool calls
- `applyDeduplication` — bucket-gated tombstoning of duplicate tool outputs
- `applyErrorPurging` — bucket-gated tombstoning of old error outputs
- `injectMessageIds` — assign stable `mXXXX` refs to non-assistant messages only; assistant role is skipped entirely (no allocation, no snapshot, no content tag) to preserve last-turn prefix cache
- `getNudgeType` — nudge firing logic (debounced by logical turns)

---

### `refs/`

**Purpose:** Visible reference parsing, allocation, and DCP metadata tag handling.

| File          | Responsibility                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`    | Parse `mXXXX` message refs and `bN` block refs. Allocate sequential message refs. Serialize/deserialize `MessageAliasState`.              |
| `metadata.ts` | Strip visible DCP metadata tags (`` ` ``, `` ` ``, `` ` ``) from text. Strip generated DCP/protocol hallucination tags from model output. |

**Key types:** `ParsedVisibleRef`, `MessageAliasState`, `MessageRefSnapshotEntry`.

---

### `replay/`

**Purpose:** Offline-only reconstruction of `DcpState` from session transcript and branch entries. Runtime restore no longer calls replay; it uses direct restore from persisted coverage-bearing state in `application/session-handler.ts`.

| File       | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts` | `replayDcpState(branchEntries, config, {state}) -> DcpState`. Walks branch entries (or wrapped message buffers), reconstructs `CompressionBlock`s from assistant `compress` toolCalls + matching `toolResult`s, applies native-compaction deactivations, and runs a final `applyPruning` pass. Retained for offline scripts/tests such as `scripts/replay-equivalence.ts`, `scripts/vacuum-dcp-session.ts`, and `tests/unit/replay.test.ts`. |

---

### `tokens/`

**Purpose:** Token estimation for compression accounting.

| File          | Responsibility                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `estimate.ts` | Estimate tokens using OpenAI `o200k_base` tokenizer via `gpt-tokenizer`, with a `chars / 4` fallback. Handles message content shapes (text, thinking, input, images). |

---

### `transcript/`

**Purpose:** Canonical transcript snapshot with source items and spans, logical turn semantics, owner key derivation.

| File       | Responsibility                                                                                                                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts` | Build deterministic `TranscriptSnapshot` (source items + spans). Group assistant tool calls + matching tool results into `tool-exchange` spans. Count logical turns. Resolve block coverage via exact metadata or timestamp fallback. Build live owner key sets. Resolve protected hot-tail start timestamp. |

**Source-key ordinal scheme** (stable canonical anchors):

```text
raw:<id>                       → assistant tool-call / toolResult messages
synth:nudge:<turn>             → injected nudge messages
synth:block:b<id>              → synthetic compressed block messages
msg:<ts>:<role>[:<toolCallId>]:<ordinal>  → non-tool-call non-nudge messages
```

`buildSourceItemKey` implements this scheme. `INTERNAL_BLOCK_ID` and `INTERNAL_NUDGE_TURN` Symbol exports remain available for synthetic message keying.

**Key types:** `TranscriptSourceItem`, `TranscriptSpan`, `TranscriptSnapshot`, `TranscriptSpanKind` (`"message"` | `"tool-exchange"`).

---

## Key Patterns

### 1. Layer Separation

Domain modules receive plain serializable objects (`DcpMessage[]`, `DcpState`, `DcpConfig`) and return plain objects. No side effects (no file I/O, no debug logging, no pi API calls). Application layer handles adaptation and side effects.

### 2. Atomic Assistant/Tool-Result Groups

Compression ranges and pruning expansions always include an assistant message together with all matching `toolResult` / `bashExecution` messages. `range.ts` implements `expandCompressionIndexRange` to expand boundaries bidirectionally.

### 3. Exact Metadata Preference

Block coverage is resolved via `CompressionBlockMetadata.coveredSourceKeys` / `coveredSpanKeys` when available. Timestamp fallback (`block.startTimestamp` / `endTimestamp`) is used only for legacy blocks without exact metadata. Supersession is allowed only for exact full coverage; partial ambiguous overlap rejects conservatively.

### 4. Stable Source-Key Anchors

New blocks persist `startSourceKey`, `endSourceKey`, and `anchorSourceKey` for stable placement across session reloads. The legacy timestamp-only placement remains as a fallback.

### 5. Bucket-Gated Tombstone Transitions

`applyDeduplication` and `applyErrorPurging` use `bucketedTurn = floor(currentTurn / pruneCadenceTurns) * pruneCadenceTurns` so additions to `state.prunedToolIds` only happen at bucket boundaries. Default cadence of 1 is per-turn; higher values batch multiple transitions into one prefix-cache break.

### 6. Block Render Detail by Recency

`materialize.ts` assigns `full` / `compact` / `minimal` detail levels to blocks based on their position in the recency-sorted active block list and the configured `renderFullBlockCount` / `renderCompactBlockCount`.

### 7. Owner Key Derivation

Owner keys are derived from canonical transcript/source metadata captured in `messageOwnerSnapshot` for visible non-assistant messages and compressed blocks, plus the non-enumerable `__dcpOwnerKey` Symbol attached to assistant message objects during context materialization. Assistant messages do not receive visible refs, preserving provider prefix cache. `provider/payload-filter.ts` reads canonical owner data directly and uses rendered-tag parsing only as a legacy/non-assistant fallback — no arbitrary rendered-text ownership dependency.

### 8. Passthrough Roles

Roles `compaction`, `branch_summary`, `custom_message` are transparent in planning and native-compaction counting: excluded from visible ID injection and logical turn counting, but their timestamps still fall inside compression splice ranges. In `buildCompressionPlanningHints()`, passthrough-only spans absorb token estimates into the running safe candidate instead of fragmenting compressible stretches across reminder/compaction injections. Assistant messages are also excluded from visible ID injection while remaining part of logical turns and atomic tool-pair expansion.

---

## Integration

```text
application/ (orchestration)
  └─> domain/pruning      applyPruning()          — main runtime path
  └─> domain/compression  buildCompressionArtifacts*() — compress tool
  └─> domain/nudge        getNudgeType()          — nudge decision
  └─> domain/provider     filterProviderPayloadInput() — hidden artifact filtering
  └─> domain/replay       replayDcpState()        — offline verification/vacuum only

domain/transcript      buildTranscriptSnapshot() — canonical snapshot
  └─> domain/compression (tooling.ts) resolveCompressionBlockCoveredSourceKeys
  └─> domain/pruning    countLogicalTurns, buildLiveOwnerKeys
  └─> domain/replay     offline walk entries, reconstruct blocks

domain/refs            parseVisibleRef, allocateMessageRef, stripDcpMetadataTags
  └─> domain/compression (tooling.ts)
  └─> domain/provider   (payload-filter.ts)
  └─> domain/replay     populate snapshots at bucket boundaries

domain/tokens          estimateTokens, estimateMessageTokens
  └─> domain/compression (range.ts, tooling.ts)
  └─> domain/pruning
```

The `transcript/` snapshot is the canonical source of truth for source items and spans. It feeds `compression/tooling.ts` for exact coverage resolution, `pruning/index.ts` for logical turn counting and live owner keys, and also feeds the inert v2 materialization scaffold in `compression/materialize.ts`.

**Application layer** owns: pi hook registration, tool registration, command registration, config loading, state persistence, debug logging, and provider-payload adaptation.

**Persistence (direct-restore v5):** empty sessions persist v3 scalar markers only; sessions with blocks persist v5 scalars plus full active block state, exact `coveredSourceKeys`/`coveredSpanKeys`, finite timestamp fallbacks, and `nextBlockId`. Runtime restore directly loads the latest coverage-bearing v1/v2/v5 `dcp-state` entry, or restores scalar continuity only from the latest non-coverage entry. `replayDcpState()` is retained for offline scripts/tests, not live restore. `validateCompressionRangeBoundaryIds()` rejects raw `mNNNN` refs inside active compressed spans with actionable `bN` boundary guidance.
