# DCP Deep Review — 2026-04-23

Consolidated findings from a four-track review: upstream opencode DCP diff, frontier context-management landscape, codebase correctness audit, and pi-vs-opencode platform capability gap.

## Headline verdict

- **Correctness gate: FAIL.** 3 blocking, 6 high, 8 medium. Nothing catastrophic, but anchor-timestamp logic, session-restore loop, and the shallow clone in `index.ts` need fixing before the next release.
- **Design posture:** Ahead of the field on correctness and controllability (exact-coverage metadata, decompressible blocks, canonical transcript + span model, payload filter for hidden provider artifacts, logical-turn semantics). Behind on cost/latency/drift-prevention (no prefix-cache awareness, no disk offload, no subagent delegation, no background notes, no anchor reinjection, exact-args-only dedup).
- **vs upstream opencode DCP:** They are broader (two compression modes, nested supersession, per-model thresholds, prompt-override dir, cross-session stats, timing, recompress, hallucinated-tag stripping). We are deeper (canonical spans, payload filter, exact coverage, planning hints, hot-tail by logical turns, v1 to v2 scaffolding). They already merged a bounded `prune` tool (PR #501) solving the monotonic-summary-growth problem we will hit.
- **vs pi platform:** 7 of 28 available hooks used. `session_before_compact`, `message_update`, `turn_start/end`, `tool_call.input` mutation, `model_select`, `ctx.ui.setWidget`, `pi.registerShortcut`, `appendCustomMessageEntry` are all unused and each unlocks something upstream opencode physically cannot do.

---

## Blocking bugs

### B-1 · `resolveAnchorTimestamp` can return a non-existent timestamp
`compress-tool.ts:101-108`. Anchor is derived from `messageIdSnapshot` (a subset), not the raw source stream. When the range ends at the last visible message it silently invents `endTimestamp + 1`. Two compressions against the same trailing region then collide.
**Fix direction:** derive anchor from `currentMessages` (raw source list passed to the tool), not from the snapshot. Consider adopting upstream's `anchorMessageId` (stable raw id) instead of `anchorTimestamp ± 0.5`.

### B-2 · Session-restore loop replays every `dcp-state` entry
`index.ts:127-143`. Last-wins works for `compressionBlocks` and `prunedToolIds` but `tokensSaved` / `totalPruneCount` from stale entries can diverge from the reconstructed blocks.
**Fix direction:** break on the first entry (semantically correct intent) and document it in the restore path.

### B-3 · `cloneRenderedMessages` is one-level shallow
`index.ts:60-70`, `:292`. Nested content objects share references. `payload-filter.ts` reads `state.lastRenderedMessages` on the next provider request; any mutation upstream silently corrupts the stored snapshot.
**Fix direction:** delete `cloneRenderedMessages` and reuse the deep clone already produced inside `applyPruning`; or switch to `structuredClone`.

---

## High severity

- **H-1 · Owner-key derivation lag.** `index.ts:224`. `buildLiveOwnerKeys` runs on pre-prune messages, then cached for the next provider request. Payload filter runs one request behind. Compute after `applyPruning`.
- **H-2 · O(n²) backward-expansion scan.** `pruner.ts:67-93`. Pre-compute `toolCallId → index` map once per pass.
- **H-3 · `<dcp-owner>` extraction is not scoped to DCP-appended content.** `payload-filter.ts:20-31`. User/LLM messages containing the literal tag text become authoritative owners. **Confirmed live**: model has already been observed echoing back `m135` / `s987` as bare prose inside tool args. Restrict extraction to the DCP-injected tail part, and strip hallucinated tags (port upstream's `stripHallucinations`) before any owner derivation.
- **H-4 · `applyCompressionBlocks` mutates + sorts per block.** `pruner.ts:156-207`. Collect splice ops, apply in reverse index order, sort once.
- **H-5 · Retry error message misleading.** `compress-tool.ts:854-876`. Same-range retry produces "Overlapping compression ranges are not supported". Distinguish retry from genuine ambiguity.
- **H-6 · `bN..bN` self-referential compress.** Creates a zero-gain block and supersedes the old one. Validate ranges span at least one non-block message.

### Dead config keys
- `nudgeFrequency` (`config.ts:23`) — declared, merged, never read.
- `protectUserMessages` (`config.ts:29`) — declared, never read.
- `protectedFilePatterns` — documented in README but not wired through runtime.

Either implement or delete. Currently misleading to users.

---

## Architectural drift

1. **Dual v1/v2 block model.** `compressionBlocksV2` never populated at runtime. Scaffolding drifts with every refactor. Decide: promote or delete.
2. **`injectNudge` mutates the last message's content.** Invalidates Anthropic prompt cache on the tail every nudge. `DCP_V2_DESIGN.md` already flagged this. Emit nudges as standalone system-suffix messages instead.
3. **Owner-key ordinal alignment is an implicit invariant.** Two call sites must see raw message order identical. No assertion guards it.
4. **`state.prunedToolIds` never clears on decompress.** Tombstones survive forever even after the block is restored.
5. **Message-ID (`mNNN`) rotation.** Rebuilt fresh every `context` pass. If the LLM cites `m0042` in a later turn, it may now point elsewhere. Upstream persists `rawId → mNNNN` aliases for a session-stable mapping — adopt that.

---

## Port from upstream opencode (high ROI)

1. **`stripHallucinations`** for `<dcp-id>` / `<dcp-owner>` — applied to assistant text and tool-arg text. Directly addresses the observed `m135` / `s987` leak.
2. **`filterMessagesInPlace`** malformed-message skipping. We don't validate message shape; missing `parts` will crash `applyPruning`.
3. **Stale-provider-metadata stripping** on model/provider switch mid-session (fixes cross-provider prefill error).
4. **Bounded `prune` tool (PR #501)** as a complement to `compress`, deactivating nested blocks to avoid monotonic summary growth over long sessions.
5. **Per-model `modelMaxLimits` / `modelMinLimits`.** Low effort, large real-world benefit.
6. **Compaction-detection + DCP state reset.** If pi native compaction fires, our blocks become lies. Subscribe to `session_compact`.
7. **Stable `anchorMessageId`.** Replaces our `anchorTimestamp ± 0.5` — robust to reordering/re-timestamping and directly addresses B-1.
8. **`pruneMessageParts` in-place.** Preserves callID / images / block metadata. We currently nuke the whole content array.
9. **Per-block compression timing + cross-session aggregated stats + `/dcp recompress`** — UX parity.

---

## Frontier ideas (ranked by leverage)

1. **Adopt Anthropic server-side cache edits** (`clear_tool_uses_20250919`, `clear_thinking_20251015`, beta headers `context-management-2025-06-27` / `compact-2026-01-12`). Our block replacement almost certainly invalidates the prompt-cache prefix from the compression point forward — a 10-60% cost/latency tax. Highest single ROI change.
2. **Disk offload for oversized tool outputs** (Claude Code microcompaction: >50KB → disk + 2KB preview + path). Implement in `tool_result` hook; rewrite before storage. Cheaper than ever compressing later.
3. **Background session-memory notes.** Write a structured markdown scratch file during idle turns so compaction can reuse free notes instead of a paid LLM call.
4. **Subagent delegation** for exploration-heavy sequences (Windsurf SWE-grep pattern). Pre-empt pollution instead of cleaning it up.
5. **Semantic / normalized-args dedup** (`rg x` vs `grep -r x`, path canonicalization, flag equivalence). Research cites ~31% of agent tool calls are semantically redundant.
6. **Anchor / focus-chain reinjection** (Cline). Restate goals in the tail every N turns to counter lost-in-the-middle. Cheap, high-signal.
7. **Line-level pruning inside large tool outputs** (SWE-Pruner). Most of a 4000-line grep is noise; small skimmer scoring lines against query achieves ~10x compression.
8. **Middle-truncation for CLI output.** Signal concentrates at head + tail. Suffix-only truncation is worst-case.
9. **Attention-sink awareness.** Never reorder or evict content near position 0 (StreamingLLM). System prompt is fine today; just don't change that.

---

## Pi-only capabilities we're not using

Subscription rate: 7 / 28 hooks.

| Capability | Unlocks | Effort |
|---|---|---|
| `session_before_compact` | Replace pi native compaction with DCP block materialization. Ends the "DCP compressed, then pi compacted the same region" double work. | Med |
| `tool_call.input` mutation / `{block:true}` | Arg-level dedup — cancel the execution, not just tombstone the output. | Low |
| `tool_result` content rewrite | Truncate oversized outputs *before storage*. Saves tokens every future turn. | Low |
| `message_update` streaming | Runaway-generation kill switch via `ctx.abort()`. Impossible in opencode. | Low |
| `turn_start.turnIndex` / `turn_end` | Replace hand-rolled `currentTurn` counter. Removes state and fixes `agent_end` drift. | Low |
| `model_select` + `ctx.model.contextWindow` | Model-aware thresholds. | Low |
| `ctx.ui.setWidget` | Live DCP HUD above the editor. | Med |
| `pi.registerShortcut` | One-chord compress. | Trivial |
| `sessionManager.appendCustomMessageEntry` | Make compressed regions visible to the model (so it knows what it already tried). | Med |
| `ctx.fork(entryId)` + `navigateTree` | Non-destructive `/dcp preview-compress` in a throwaway branch. | Med |

---

## Test coverage gaps

Missing regression coverage:

1. Multiple overlapping blocks applied in one `applyPruning` call (O(n²) scan path untested).
2. `protectRecentTurns >= totalTurns` (entire session protected — candidates go empty).
3. `/dcp sweep` racing with an in-flight tool call.
4. `restorePersistedState` called multiple times (B-2 path).
5. Three-part split assistant messages in `buildDirectOwnerKeys`.
6. User/assistant content containing literal `<dcp-owner>s0</dcp-owner>` (H-3 path).
7. `serializePersistedState` → `restorePersistedState` round-trip field equality (Set ↔ array for `prunedToolIds`).
8. `getNudgeType` when `minContextPercent === maxContextPercent`.
9. `expandBlockPlaceholders` for a block being simultaneously superseded.
10. `before_provider_request` with zero items after filtering (empty `input` may break providers).

---

## Suggested priority order

### Tier 0 — correctness (do now)
- B-1, B-2, B-3
- H-1, H-3, H-4
- Port `stripHallucinations` and malformed-message skipping
- Clear `state.prunedToolIds` entries when their block decompresses
- Add H-3 hallucination test case
- Harden `compress` tool to reject `mNNN` / `bN` IDs not present in the live snapshot

### Tier 1 — cost and latency
- Adopt Anthropic cache-edits for pruning instead of block replacement
- Stable `rawId → mNNNN` aliasing (session-persistent)
- Disk-offload tier via `tool_result` rewrite
- Arg-level dedup via `tool_call.input` mutation

### Tier 2 — capability expansion
- `session_before_compact` hijack
- `turn_start/end` adoption
- Background notes file written during idle turns
- Per-model `modelMaxLimits` / `modelMinLimits`
- `ctx.ui.setWidget` HUD
- Anchor / focus-chain reinjection

### Tier 3 — platform depth
- Subagent delegation for exploration-heavy sequences
- Line-level pruning inside large tool outputs
- `/dcp preview-compress` via fork + navigate

### Tier 4 — cleanup
- Retire the dormant v2 block model OR finish migration
- Delete the three dead config keys (or implement them)
- Update the `compress` prompt once `(bN)` placeholder mechanism is retired

---

## Observed hallucination evidence (H-3)

Model output from a live session leaking DCP IDs into tool args:

```
write src/workflows/definitions/search-query/index.ts

export * from "./definition.js";
export * from "./queue.js";
export * from "./run.js";


m135
s987


write src/workflows/definitions/embedding/definition.ts
...
```

The bare `m135` and `s987` appeared as prose inside file content. Two distinct failure modes visible here:

1. **Owner-tag leak risk:** if the model had instead emitted `<dcp-owner>s987</dcp-owner>` as literal text, `payload-filter.ts` would have mis-attributed ownership. Fix: scope extraction to DCP-appended tail parts only; strip hallucinated tags before derivation.
2. **Protocol leakage into tool args:** the model treated `mNNN` / `sNNN` as something to emit. Fix: prompt-level rule that DCP IDs are reference-only and must never appear in tool args or file content; and `compress` tool arg validation that rejects ID-shaped strings not present in the live snapshot.

---

## Agents (still live, for follow-up drilling)

- Upstream DCP diff: `ae4d51a1815d2a5d0`
- Frontier research: `ab081707bb5c8aa1f`
- Code-review audit: `a43e9bb0650d0e180`
- Platform-gap analysis: `a1b0620b30fa04941`
