# Domain Layer Codemap

## Responsibility

The `domain/` layer contains pure business logic for Dynamic Context Pruning (DCP). These modules have **no imports** from `@mariozechner/pi-coding-agent`, infrastructure (config loading, debug logging, persistence), or application handlers. They receive plain data (messages, state, config) and return plain data.

This isolation ensures the core pruning/compression semantics are testable, deterministic, and portable across runtime environments.

---

## Subdirectories

### `compression/`

**Purpose:** Compression block construction, range resolution, planning hints, and v2 materialization scaffolding.

| File             | Responsibility                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `range.ts`       | Expand timestamp-bounded ranges to include atomic assistant/tool-result groups. Resolve indices from timestamps.                                                              |
| `materialize.ts` | Render v2 compression blocks into `DcpMessage`s with three detail levels: `full` (summary + activity log), `compact` (truncated summary), `minimal` (one-line).               |
| `metadata.ts`    | Factory for empty `CompressionBlockMetadata` (covered source keys, span keys, tool IDs, file/command stats).                                                                  |
| `tooling.ts`     | Core compression helpers: validate boundaries, build activity logs, resolve superseded blocks, collect file read/write stats, build `CompressionPlanningHints` for the agent. |
| `index.ts`       | Re-exports for all submodules.                                                                                                                                                |

**Key types:** `CompressionCandidateRange`, `CompressionPlanningHints`, `CompressionBlockRenderDetail`, `MaterializedTranscript`.

---

### `nudge/`

**Purpose:** Thin re-export of nudge decision logic from the pruning domain.

| File       | Responsibility                                     |
| ---------- | -------------------------------------------------- |
| `index.ts` | Re-exports `getNudgeType` from `pruning/index.ts`. |

---

### `provider/`

**Purpose:** Filter stale hidden artifacts from provider payloads using canonical owner keys.

| File                | Responsibility                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payload-filter.ts` | Extract owner keys from rendered transcript text (`mXXXX</dcp-id>`, `bN</dcp-block-id>` tags). Build represented compress receipts. Minify the newest live represented compress exchange to a compact receipt; suppress older represented pairs. Filter `reasoning`, `function_call`, `function_call_output` items by live owner key. |

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
- `injectMessageIds` — assign stable `mXXXX` refs, update snapshots
- `getNudgeType` — nudge firing logic (debounced by logical turns)

---

### `refs/`

**Purpose:** Visible reference parsing, allocation, and DCP metadata tag handling.

| File          | Responsibility                                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`    | Parse `mXXXX` message refs and `bN` block refs. Allocate sequential message refs. Serialize/deserialize `MessageAliasState`.                                |
| `metadata.ts` | Strip visible DCP metadata tags (`<dcp-id>`, `<dcp-owner>`, `<dcp-block-id>`) from text. Strip generated DCP/protocol hallucination tags from model output. |

**Key types:** `ParsedVisibleRef`, `MessageAliasState`, `MessageRefSnapshotEntry`.

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

Owner keys are derived from rendered transcript metadata tags (`<dcp-block-id>`, `<dcp-id>`), not from arbitrary text. `provider/payload-filter.ts` uses these keys to filter stale artifacts.

### 8. Passthrough Roles

Roles `compaction`, `branch_summary`, `custom_message` are treated as transparent: they are excluded from visible ID injection and logical turn counting, but their timestamps still fall inside compression ranges for splicing.

---

## Integration

```
application/ (orchestration)
  └─> domain/pruning      applyPruning()          — main runtime path
  └─> domain/compression  buildCompressionArtifacts*() — compress tool
  └─> domain/nudge        getNudgeType()          — nudge decision
  └─> domain/provider     filterProviderPayloadInput() — hidden artifact filtering

domain/transcript      buildTranscriptSnapshot() — canonical snapshot
  └─> domain/compression (tooling.ts) resolveCompressionBlockCoveredSourceKeys
  └─> domain/pruning    countLogicalTurns, buildLiveOwnerKeys

domain/refs            parseVisibleRef, allocateMessageRef, stripDcpMetadataTags
  └─> domain/compression (tooling.ts)
  └─> domain/provider   (payload-filter.ts)

domain/tokens          estimateTokens, estimateMessageTokens
  └─> domain/compression (range.ts, tooling.ts)
  └─> domain/pruning
```

The `transcript/` snapshot is the canonical source of truth for source items and spans. It feeds `compression/tooling.ts` for exact coverage resolution, `pruning/index.ts` for logical turn counting and live owner keys, and will eventually drive the v2 materialization path in `compression/materialize.ts`.

**Application layer** owns: pi hook registration, tool registration, command registration, config loading, state persistence, debug logging, and provider-payload adaptation.
