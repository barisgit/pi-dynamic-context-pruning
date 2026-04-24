## Context

DCP currently renders model-facing message IDs and internal owner metadata into the prompt. The visible IDs are rebuilt from the rendered snapshot each context pass, while compression placement still relies on timestamp-derived anchors. Provider payload filtering then recovers ownership by scanning rendered text for owner markers.

That design has three problems:

- visible IDs are not stable enough to be durable compression boundaries;
- timestamp anchors can be invented or collide when compressing trailing ranges;
- visible owner metadata leaks an internal protocol into model output and can be hallucinated back into ownership decisions.

Upstream opencode DCP solves adjacent problems with session-stable raw-message aliases and `anchorMessageId` placement. Local pi DCP should port those reference/anchor primitives while keeping its stronger canonical transcript and provider-payload filtering architecture.

## Goals / Non-Goals

**Goals:**

- Make `m0001`-style message refs and `bN` block refs the only model-facing DCP reference protocol.
- Keep visible refs stable for the lifetime of a session by mapping refs to durable raw/source keys.
- Remove visible owner metadata from rendered transcript text.
- Track ownership internally via canonical source keys, span keys, tool-call IDs, provider artifact IDs, and block IDs.
- Place compressed blocks using durable source/span anchors instead of timestamps or visible ordinal snapshots.
- Keep provider payload filtering deterministic without parsing owner truth from arbitrary model-visible text.
- Provide migration/fallback behavior for existing timestamp-based blocks.

**Non-Goals:**

- Full v2 materialization rollout for all compression behavior.
- Provider-native context editing integration.
- A new bounded `prune` tool.
- Cross-session stats or `/dcp recompress`.
- Removing visible compression refs; the model still needs message and block refs to call `compress`.

## Decisions

### Decision 1: Stable visible refs are aliases, not source truth

Visible message refs SHALL be allocated from durable source keys and persisted in DCP state. The ref is only an agent-facing alias; the canonical source key is the source of truth.

Preferred source key order:

1. provider/pi raw message or session-entry ID if exposed;
2. canonical `TranscriptSourceItem.key`;
3. timestamp/role/ordinal fallback only for migration or malformed input.

Rationale: this ports the upstream `rawMessageId -> m0001` idea while fitting local canonical transcript scaffolding.

Alternative considered: keep rebuilding `mNNN` refs from each rendered transcript. Rejected because stale citations can point to a different message after pruning/materialization changes.

### Decision 2: Compression anchors use source keys

New compression blocks SHALL store a durable `anchorSourceKey` or equivalent canonical anchor that identifies where the rendered block is inserted. Timestamp anchors remain read-only legacy fallback data.

Rationale: source-key anchors avoid the current `endTimestamp + 1`/`+0.5` class of bugs and allow block liveness to be derived from the current source transcript.

Alternative considered: improve timestamp spacing. Rejected because timestamps are not the real identity layer and remain fragile under compaction, edits, or synthetic messages.

### Decision 3: Visible owner metadata is removed

Rendered transcript text SHALL NOT include source owner markers. Ownership must be carried in internal state/materialization results and, where needed, non-enumerable or non-text metadata that is not model-visible.

Rationale: owner markers are not needed by the agent to call `compress` and have already produced protocol-leak failure modes.

Alternative considered: keep owner markers but hide them in TUI. Rejected because model/provider payloads can still receive or imitate text unless the ownership layer is fully non-text.

### Decision 4: Provider filtering uses internal ownership maps

Provider payload filtering SHALL decide liveness from canonical owner maps produced by the same transcript/materialization pass that produced the outbound prompt. It SHALL NOT treat arbitrary visible text tags as authoritative ownership.

Implementation shape:

- source/span ownership map: `sourceKey/spanKey -> live | compressed | hidden`;
- provider artifact ownership map: `artifactId/toolCallId/providerItemId -> sourceKey/spanKey/blockId`;
- active block ownership map: `blockId -> covered source/span keys`.

Rationale: this preserves DCP’s hidden artifact pruning without leaking the ownership protocol.

### Decision 5: DCP tag hallucinations are ignored or scrubbed only in generated paths

Generated assistant/tool/subagent output should have DCP protocol tags stripped or ignored before they can influence DCP state. User-authored literal text should not be destructively modified unless it is in a known DCP-injected trailer.

Rationale: upstream strips generated `<dcp...>` tags aggressively. Local pi DCP also needs to avoid treating user text as metadata.

## Risks / Trade-offs

- Stable alias migration may break existing `m001` prompt examples → update prompts/tests atomically and consider accepting both old/new ref widths during transition.
- Some pi message objects may lack durable raw IDs → use canonical transcript keys and log fallback usage in debug mode.
- Removing visible owner tags may initially reduce provider filtering precision → build internal artifact ownership maps and regression tests before deleting fallback behavior.
- Legacy timestamp blocks may render differently after migration → support timestamp fallback until blocks are decompressed/superseded and add tests for legacy restore.
- Generated-tag stripping could remove legitimate output in rare cases → apply destructive stripping only to generated assistant/tool/subagent paths; for user text, ignore tags for metadata rather than editing content.

## Migration Plan

1. Add state fields for stable aliases and source-key anchors while preserving existing fields.
2. Allocate visible refs from durable source keys during each context pass.
3. Accept both legacy `mNNN` and new `mNNNN` IDs while the prompt contract migrates.
4. Store `anchorSourceKey`/`coveredSourceKeys` for new blocks; keep timestamp fallback for old blocks.
5. Stop rendering visible owner metadata behind a feature-compatible implementation that keeps provider filtering green.
6. Remove text-derived owner extraction once internal ownership maps cover provider artifacts.
7. Update docs/prompts/tests after behavior is proven.

Rollback: keep legacy timestamp range resolution and owner extraction behind internal fallback paths until tests prove source-key ownership is complete. If a regression appears, disable new anchoring while keeping hallucination stripping and visible-owner removal guarded separately.

## Open Questions

- Does pi expose a stable raw message/session entry ID for every message type, or should canonical transcript keys be the default from day one?
- Should the visible ID width switch immediately to `m0001`, or should parsing accept both widths while rendering remains configurable for one release?
- Can provider artifacts be tagged with non-text metadata before `before_provider_request`, or must DCP reconstruct ownership from transcript/source ordering?
- Should visible block refs remain `<dcp-id>bN</dcp-id>` or move to a renamed `<dcp-message-id>` tag for upstream parity?
