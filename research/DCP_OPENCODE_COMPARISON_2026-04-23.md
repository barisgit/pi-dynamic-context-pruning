# DCP vs upstream opencode DCP comparison

Date: 2026-04-23
Local repo: `/Users/blaz/Programming_local/Projects/pi-extensions/pi-dynamic-context-pruning`
Upstream checked: `https://github.com/Opencode-DCP/opencode-dynamic-context-pruning`
Upstream commit sampled locally: `98601123483bd9325d5ec5d1c3942e7e19019606` (`9860112 Merge pull request #500 from Opencode-DCP/dev`)
Prior local review also referenced upstream diff/agent id `ae4d51a1815d2a5d0`.

## Executive verdict

The local pi DCP is deeper on canonical transcript theory and hidden provider-payload ownership, but upstream opencode DCP has several pragmatic production features that should be ported before or alongside the v2 rewrite:

1. session-stable message references from raw message IDs,
2. `anchorMessageId` placement instead of timestamp placement,
3. hallucinated DCP tag stripping before model/tool text can feed back into state,
4. bounded prune/message compaction to avoid monotonic summary growth,
5. compaction detection and state reset,
6. model-specific context limits,
7. recompress and cross-session stats.

The most important upstream lesson is that **visible refs and block placement should be anchored to durable raw message IDs, not rendered ordinal snapshots or timestamps**.

## Upstream files sampled

Fetched into `/tmp/opencode-dcp-full` for inspection.

| Topic | Upstream file |
|---|---|
| Stable message IDs | `lib/message-ids.ts` |
| Compress state / block application | `lib/compress/state.ts` |
| Range resolution / placeholders | `lib/compress/range-utils.ts`, `lib/compress/search.ts` |
| Bounded prune | `lib/messages/prune.ts` |
| Hallucination stripping | `lib/messages/utils.ts`, `lib/hooks.ts` |
| Cross-provider metadata stripping | `lib/messages/reasoning-strip.ts` |
| Compression block sync | `lib/messages/sync.ts` |
| Session/compaction state | `lib/state/state.ts`, `lib/state/utils.ts` |
| Config/model limits | `lib/config.ts` |
| Recompress/stats commands | `lib/commands/recompress.ts`, `lib/commands/stats.ts` |
| Prompt contract | `lib/prompts/system.ts`, `lib/prompts/compress-range.ts`, `lib/prompts/compress-message.ts` |

## 1. Message IDs and anchors

### Upstream behavior

`lib/message-ids.ts` uses strict refs:

- message refs: `m0001`..`m9999` via `/^m(\d{4})$/`
- block refs: `bN` via `/^b([1-9]\d*)$/`
- rendered tag: `<dcp-message-id>m0001</dcp-message-id>`

The key function is `assignMessageRefs(state, messages)`:

- reads each raw message’s durable `message.info.id`
- reuses `state.messageIds.byRawId.get(rawMessageId)` if present
- otherwise allocates the next `mNNNN`
- persists both `byRawId` and `byRef`

`lib/compress/search.ts::resolveAnchorMessageId(startReference)` returns a raw message ID from the resolved boundary. `lib/compress/state.ts::applyCompressionState(...)` stores `anchorMessageId` on each block and indexes active blocks by `activeByAnchorMessageId`.

During render/prune, `lib/messages/prune.ts::filterCompressedRanges(...)` iterates raw messages and injects a synthetic summary before the raw message whose `msg.info.id` equals the active anchor.

### Local behavior

Local pi DCP:

- uses 3-digit visible IDs (`m001`) in `pruner.ts::injectMessageIds()` and `prompts.ts`
- rebuilds `state.messageIdSnapshot` each context pass from the rendered visible subset
- maps `mNNN -> timestamp`
- computes `anchorTimestamp` in `compress-tool.ts::resolveAnchorTimestamp()` and may invent `endTimestamp + 1`

### Port recommendation

Port the upstream shape, adapted to pi message objects:

```ts
state.messageAliases = {
  bySourceKeyOrRawId: Map<string, string>,
  byRef: Map<string, string>,
  nextRef: number,
}
```

Use the best durable key available in pi:

1. native session entry/message ID if exposed,
2. else canonical `TranscriptSourceItem.key`,
3. else timestamp+role+ordinal fallback only during migration.

Replace `anchorTimestamp` with `anchorSourceKey` / `anchorMessageId`. This directly fixes local B-1 and removes a class of timestamp collision bugs.

### Migration note

Do not rush the 3-digit -> 4-digit visible contract unless the user-facing cost is acceptable. The important upstream behavior is stable aliasing and raw-ID anchoring, not the width. If changed, update `prompts.ts`, tests, and any parsing docs together.

## 2. Hallucination and metadata stripping

### Upstream behavior

`lib/messages/utils.ts` defines:

```ts
const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi
const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi

export const stripHallucinationsFromString = (text: string): string => {
  return text.replace(DCP_PAIRED_TAG_REGEX, "").replace(DCP_UNPAIRED_TAG_REGEX, "")
}
```

`stripHallucinations(messages)` applies that to text parts and completed tool output strings.

`lib/hooks.ts` calls it in two important places:

- in the chat transform before refs/pruning/nudges are injected
- in text completion output (`createTextCompleteHandler`) before output text is accepted

Subagent result injection also calls `stripHallucinationsFromString()`.

### Local behavior

Local `dcp-metadata.ts::stripDcpMetadataTags(text)` can strip `<dcp-id>`, `<dcp-owner>`, `<dcp-block-id>`, `<agent-summary>`, `<dcp-log>`, and `<dcp-system-reminder>`, but it is not currently equivalent to upstream’s always-on hallucination strip pass. Local `payload-filter.ts` still scans message text for `<dcp-owner>` / `<dcp-block-id>` markers, so hallucinated tags can become owner truth.

### Port recommendation

Port the upstream concept, not necessarily the exact regex unchanged:

1. Add a general `stripDcpHallucinationsFromString()` for model-generated assistant text, tool args, subagent text, and provider text output paths.
2. Run it before any ownership/range parsing.
3. Stop rendering `<dcp-owner>` entirely.
4. Make payload ownership canonical, not text-derived.

Important nuance: do **not** destructively strip user-authored literal DCP tags from user messages unless they are known DCP-injected trailers. Upstream strips generated output; local DCP also needs scoped extraction because it currently treats arbitrary text as authoritative ownership.

## 3. Bounded prune vs only summarize-compress

### Upstream behavior

`lib/messages/prune.ts` has a `prune(...)` pipeline:

- `filterCompressedRanges(...)`
- `pruneToolOutputs(...)`
- `pruneToolInputs(...)`
- `pruneToolErrors(...)`

`filterCompressedRanges(...)` injects active compressed summaries at `activeByAnchorMessageId` anchors and skips messages whose `byMessageId` entry has active block IDs.

This gives upstream two levers:

1. replace ranges with LLM-authored summaries,
2. remove/replace low-value tool ballast with bounded placeholders.

Upstream compression state in `lib/compress/state.ts::applyCompressionState(...)` also tracks:

- `directMessageIds`, `directToolIds`
- `effectiveMessageIds`, `effectiveToolIds`
- `consumedBlockIds`, `includedBlockIds`, `parentBlockIds`
- `activeByAnchorMessageId`

### Local behavior

Local pi DCP has a rich `compress` tool and exact metadata, but no separate bounded prune transaction/tool. It does automatic dedup/error purging in `pruner.ts` using `state.prunedToolIds`, which can survive decompression and is not clearly tied to a durable compression transaction.

### Port recommendation

Do not blindly port upstream `prune.ts` as-is because pi message shapes differ and local v2 wants compress-only deterministic materialization. Port the product concept:

- add a bounded prune transaction for oversized/obsolete tool output,
- store it as a first-class block/transaction with canonical source coverage,
- index by stable anchor/source key,
- make it supersession-aware,
- avoid global `prunedToolIds` tombstones.

Short-term alternative: implement large tool-output offload before storage, which may remove much of the need for opportunistic prune.

## 4. Compression block sync and compaction reset

### Upstream behavior

`lib/state/state.ts::checkSession(...)` detects compaction:

```ts
const lastCompactionTimestamp = findLastCompactionTimestamp(messages)
if (lastCompactionTimestamp > state.lastCompaction) {
  state.lastCompaction = lastCompactionTimestamp
  resetOnCompaction(state)
  saveSessionState(state, logger)
}
```

`lib/messages/sync.ts::syncCompressionBlocks(...)` reconciles active blocks with the current raw message list:

- if a block’s origin/compress message no longer exists, deactivate it
- consumed blocks are deactivated deterministically
- `activeByAnchorMessageId` is rebuilt from currently present anchor messages
- per-message active block IDs are repaired from all known block IDs

### Local behavior

Local state restore/migration is stronger in some ways, but runtime does not detect native compaction and reset stale DCP blocks. If pi compacts or rewrites history under DCP, timestamp and source ordinal assumptions can become false.

### Port recommendation

Add a pi-specific compaction/rewrite detection layer:

1. subscribe to `session_before_compact` / compaction-related hooks if available,
2. detect compaction/branch summary entries in `context` if hooks are unavailable,
3. reset or mark compression blocks stale when source anchors vanish,
4. rebuild active block liveness from current source transcript each pass,
5. log reset reason to debug log.

This should be implemented before relying on long-lived v2 block state across native pi compactions.

## 5. Cross-provider stale metadata stripping

### Upstream behavior

`lib/messages/reasoning-strip.ts::stripStaleMetadata(messages)` mirrors opencode’s different-model handling. It finds the last user message’s `providerID/modelID`, then removes `metadata` fields from assistant `text`, `tool`, and `reasoning` parts that came from a different provider/model.

`lib/hooks.ts` runs `stripStaleMetadata(output.messages)` after message ID/nudge injection.

### Local behavior

Local `payload-filter.ts` filters provider input items (`reasoning`, `function_call`, `function_call_output`) by ownership, but there is no explicit cross-provider metadata scrub. If a session switches providers/models, stale provider-specific metadata could still cause request-shape failures.

### Port recommendation

Add a provider-metadata scrub pass in `before_provider_request` or the `context` hook, depending on where pi exposes provider/model details. Keep it conservative:

- only remove provider-specific metadata fields,
- preserve text/tool content,
- apply only when current provider/model differs from artifact provider/model,
- log counts in debug mode.

## 6. Config and model-specific thresholds

### Upstream behavior

`lib/config.ts` supports:

- `compress.maxContextLimit` / `minContextLimit` as number or percentage string,
- `compress.modelMaxLimits` / `modelMinLimits` keyed by provider/model,
- config validation helpers,
- separate turn protection concepts,
- many command/manual/compress knobs.

### Local behavior

Local `config.ts` uses `maxContextPercent`/`minContextPercent` as 0-1 floats. It has dead/misleading keys:

- `compress.nudgeFrequency` retained but not meaningfully used,
- `compress.protectUserMessages` declared but not wired,
- `protectedFilePatterns` documented/configured but not wired to runtime behavior.

### Port recommendation

Port only high-signal config improvements:

1. `modelMaxLimits` / `modelMinLimits` keyed by provider/model.
2. Validation for unknown/wrong config value types.
3. Either wire or delete local dead keys.

Avoid copying upstream’s whole config surface until DCP v2 stabilizes.

## 7. Stats, timing, and recompress

### Upstream behavior

Upstream has:

- compression timing (`attachCompressionDuration`, pending call IDs),
- cross-session stats (`lib/commands/stats.ts`, `loadAllSessionStats`),
- `/dcp recompress` (`lib/commands/recompress.ts`) to reactivate user-decompressed blocks and resync state.

### Local behavior

Local stats are mostly session/current-active estimates. This is cleaner than lifetime overcounting, but there is no cross-session ROI view and no recompress command.

### Port recommendation

Port observability ideas after correctness:

1. per-block compression duration,
2. per-block estimated raw tokens vs summary tokens,
3. cross-session aggregate report,
4. recompress/reactivate command only after v2 supersession semantics are stable.

For now, the better first observability artifact is the planned proxy/DCP correlation report.

## 8. Prompt contract differences

### Upstream behavior

Upstream uses `<dcp-message-id>` and `m0001` IDs. Its range prompt is shorter and modular. It also supports both `(bN)` and `{block_N}` placeholders in `BLOCK_PLACEHOLDER_REGEX`.

### Local behavior

Local `prompts.ts` uses:

- `<dcp-id>` and `m001`,
- large detailed compression prompt,
- strict `(bN)` placeholder requirements,
- explicit DCP philosophy/cadence instructions.

### Port recommendation

Do not import upstream prompt text wholesale. Instead:

1. simplify the local agent contract as v2 absorbs lineage/supersession,
2. remove `(bN)` placeholder obligations once runtime can consume/supersede blocks automatically,
3. add a hard rule that DCP refs are reference-only and must never appear in file/tool output except as `compress` arguments,
4. consider moving from visible XML-ish tags to less imitation-prone metadata if pi supports non-text annotations.

## 9. Cache behavior and nudge injection

### Upstream behavior

Upstream synthetic messages/parts use stable IDs derived from hashes (`createSyntheticUserMessage`, `createSyntheticTextPart`). It still injects text into messages, but it has a stronger synthetic-ID discipline and strips hallucinations around generated output.

### Local behavior

Local `injectNudge()` appends reminder text into an existing visible message, which causes prompt churn and can invalidate cache suffixes. Local `cloneRenderedMessages()` is shallow.

### Port recommendation

Use upstream’s stable synthetic-ID idea, adapted to pi:

- render nudges as deterministic standalone advisory messages or synthetic parts,
- do not mutate existing historical content,
- assign stable IDs/seeds based on threshold kind + anchor/source key,
- measure cache impact through the proxy plan.

## Port priority table

| Priority | Upstream idea | Local target | Why |
|---|---|---|---|
| P0 | Stable raw-ID refs | `state.messageAliases`, `injectMessageIds`, `compress-tool` range resolution | Fixes rotating IDs and enables durable anchors |
| P0 | `anchorMessageId` | Replace `anchorTimestamp` with source-key anchor | Fixes B-1 timestamp collision |
| P0 | `stripHallucinations` | `dcp-metadata.ts`, context/text/provider hooks | Addresses live protocol leakage |
| P0 | Compaction reset/sync | `index.ts`, `migration.ts`, `state.ts` | Prevents DCP blocks lying after native compaction |
| P1 | Model-specific limits | `config.ts`, nudge/context threshold code | Better behavior across model context windows |
| P1 | Bounded prune concept | v2 transaction or tool-output offload | Controls monotonic summary/tool ballast growth |
| P1 | Stale metadata stripping | `before_provider_request` / context hook | Avoids cross-provider payload failures |
| P2 | Compression timing/stats | debug/proxy report first, then `/dcp stats` | Real ROI visibility |
| P2 | `/dcp recompress` | commands after v2 semantics | Useful once block lineage is stable |
| P3 | Prompt simplification | `prompts.ts` after v2 | Lower prompt overhead and fewer protocol leaks |

## Recommended merge into current roadmap

Update Wave 0 to include upstream-derived work:

1. Port hallucination stripping around generated assistant/tool/subagent text.
2. Hide/remove `<dcp-owner>` from visible transcript.
3. Add stable source-key/raw-ID message aliases.
4. Replace timestamp anchors with source-key anchors.
5. Add compaction/source-anchor invalidation detection.

Then Wave 1/Wave 2:

6. Add model-specific thresholds.
7. Prototype bounded prune or tool-output offload.
8. Add stale provider metadata stripping.
9. Add stats/recompress after v2 materialization stabilizes.

## Final take

Upstream opencode DCP has already solved several practical lifecycle problems that local pi DCP is currently rediscovering: stable IDs, raw-ID anchors, hallucination stripping, compaction reset, and model-aware thresholds. Local pi DCP should not clone upstream wholesale because the local canonical-span and provider-payload-filter architecture is stronger. The best path is to port upstream’s durable-reference and hygiene primitives, then continue the local v2 materialization plan on top of them.
