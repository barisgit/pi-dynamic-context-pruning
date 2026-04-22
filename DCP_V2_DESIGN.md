# DCP v2 — deterministic compression design

Date: 2026-04-22
Status: draft

## One-line goal

Make DCP cache-friendly and simple by making `compress` the only transcript-mutating transaction.

## Core invariants

These are the rules for v2.

1. **Between compresses, outbound context is stable.**
   - Same source transcript + same active blocks = same rendered prompt shape.
   - No opportunistic per-request deletions.
   - No reminder persistence into canonical/session history.
   - If nudges exist, they must be deterministic render-time advisories, not history mutations.
   - No heuristic pruning that sometimes fires and sometimes does not.

2. **`compress` is the only removal mechanism.**
   - Raw messages, hidden/provider artifacts, stale reminders, and old tool ballast are only removed when a `compress` transaction commits.
   - Everything else is read-only materialization.

3. **Agent-facing compression stays simple.**
   - Pick a closed visible range.
   - Write one good summary.
   - Call `compress`.
   - The agent does not manage hidden artifacts, tool-pair closure, or recompress lineage.

4. **Compression is deterministic.**
   - A visible range resolves to the same canonical closure every time.
   - A block renders in one stable place with one stable format.
   - The same blocks always produce the same prompt materialization.

5. **Old compressions can be consumed by newer compressions.**
   - Compressions must not accumulate forever.
   - Fully covered prior blocks are superseded by the new block.

---

## Why v1 still grows too much

The current implementation reduces some visible conversation, but the main token mass still drifts upward because v1 does not model compression as a deterministic transcript rewrite.

Today, the extension still relies on:

- timestamp-based block boundaries in `state.ts`
- per-request application in `pruner.ts`
- active block re-splicing on every `context` event
- placeholder expansion in `compress-tool.ts`
- overlap rejection instead of true recompress/supersession
- automatic deduplication and error purging that mutate pruning state outside `compress`
- reminder injection into live messages via `injectNudge(...)`

That means the current system is still carrying or re-creating ballast from:

- hidden/provider reasoning artifacts
- stale DCP reminder text
- prior compressed summaries that never get folded again
- tool/result ballast that is pruned heuristically instead of transactionally
- stats that are write-amplified by repeated reapplication

The result is predictable: prompt mass keeps growing even after several compressions.

---

## What changes in v2

v2 splits DCP into two concepts:

1. **Canonical transcript**
   - the stable source of truth for the session branch
   - read-only between compresses

2. **Compression block log**
   - the only persisted mutation layer
   - each block is a deterministic rewrite over canonical spans

Materialization becomes:

> canonical transcript + active blocks -> rendered outbound transcript

No hidden heuristics should change that materialization between compresses.

---

## The simplest possible mental model

### For agents

The agent should think only in visible ranges.

Workflow:
- inspect visible context
- identify a closed slice
- summarize it faithfully
- call `compress`

The agent should not think about:
- reasoning blobs
- reminder cleanup
- tool-result pairing
- superseding older blocks
- placeholder expansion
- overlap math
- hidden artifact IDs

### For the runtime

The runtime owns all complexity:
- map visible IDs to canonical spans
- expand to deterministic closure
- include hidden/provider artifacts attached to those spans
- absorb fully covered older blocks
- persist one new block
- render one stable replacement block

---

## Canonical transcript model

The current v1 code works directly on message arrays and repairs mistakes later. v2 should instead build a deterministic canonical transcript snapshot first.

### Source snapshot

Each `context` pass starts from the current session branch in root-to-leaf order.

The runtime normalizes it into source items.

### Source item types

At minimum:
- visible `user` messages
- visible `assistant` messages
- visible `toolResult` messages
- visible `bashExecution` messages
- passthrough/internal entries that affect adjacency
- hidden/provider artifacts attached to visible turns
  - reasoning items
  - old reminder fragments
  - other provider-only baggage if present in the source transcript

### Span model

The key simplification is this:

**Compression should operate on canonical spans, not raw message indices.**

A span is the smallest deterministic unit that may be removed or replaced.

Suggested span types:
- `message`
  - a standalone visible message with its attached hidden artifacts
- `tool-exchange`
  - assistant tool-call message + all linked `toolResult` / `bashExecution` entries + passthrough entries between them + attached hidden artifacts
- `compressed-block`
  - a rendered active block in the visible transcript, backed by underlying source spans and/or superseded blocks

By making `tool-exchange` a first-class span, v2 removes the need for the current repair-style logic in `applyCompressionBlocks(...)` and `repairOrphanedToolPairs(...)`.

### Why spans matter

If hidden/provider artifacts are attached to spans, then compressing a visible range automatically consumes:
- reasoning attached to covered turns
- reminder fragments attached to covered turns
- tool ballast attached to covered tool exchanges

That is much simpler than separately tracking every artifact class in the tool contract.

---

## Stable identity model

v1 uses timestamps as the durable boundary model. That is too weak as the main design.

v2 should separate three identity layers.

### 1. Source keys

Durable internal keys for canonical spans and items.

Requirements:
- deterministic across restarts
- independent from visible `mNNN` numbering
- stable enough to survive repeated materialization

Preferred source key:
- a true host/session entry ID if pi exposes one

Transitional source key if pi does not:
- a canonical key derived from source order and entry metadata, for example:
  - `msg:<timestamp>:<role>:<ordinal>`
  - `artifact:<parent-key>:<kind>:<ordinal>`
  - `span:<start-key>..<end-key>`

The important point is not the exact string format. The important point is:

- v2 persists **source keys**, not visible IDs
- visible IDs are derived fresh on materialization
- timestamps may still appear inside a source key during migration, but timestamps are no longer the entire model

### 2. Visible IDs

Visible IDs are only for the agent.

- raw visible messages get `mNNN`
- active compressed blocks may continue exposing `bN` for compatibility
- long-term, `bN` should become optional instead of mandatory

### 3. Block IDs

Block IDs remain the persisted identity for compression blocks:
- `b1`, `b2`, ...

These are stable handles for listing, decompressing, and migration.

---

## Persisted v2 state

v1 persists mutable counters and timestamp ranges. v2 should persist a much smaller, cleaner block log.

## Proposed persisted state

```ts
interface CompressionBlockV2 {
  id: number
  topic: string
  summary: string
  startSpanKey: string
  endSpanKey: string
  supersedesBlockIds: number[]
  status: "active" | "superseded" | "decompressed"
  summaryTokenEstimate: number
  createdAt: number
}

interface PersistedDcpStateV2 {
  schemaVersion: 2
  nextBlockId: number
  blocks: CompressionBlockV2[]
  manualMode: boolean
}
```

### Notes

- `anchorTimestamp` goes away.
- `active: boolean` becomes an explicit status.
- `tokensSaved` should no longer be a persisted accumulator.
- `totalPruneCount` should no longer be a persisted accumulator.
- `prunedToolIds` should not be the main persistence mechanism in v2 if pruning is truly compress-only.

### Derived runtime state

These should be rebuilt from the current branch and active blocks instead of persisted as authority:

- canonical source snapshot
- canonical spans
- visible `mNNN` mapping
- visible block placement
- materialized transcript
- stats derived from active blocks and rendered transcript

This change directly addresses the current accounting drift.

---

## Compress transaction algorithm

This is the heart of v2.

### Inputs

The agent still calls:

```ts
{
  topic: string,
  ranges: [{ startId, endId, summary }, ...]
}
```

The agent contract stays the same at first.

### Execution steps

For each range:

1. **Resolve visible boundaries**
   - map `startId` and `endId` against the latest materialized transcript
   - allow `mNNN`
   - keep `bN` only for compatibility during migration

2. **Map boundaries to canonical spans**
   - find the first and last underlying spans touched by those visible boundaries

3. **Expand to deterministic closure**
   - extend to full span boundaries
   - include all hidden/provider artifacts attached to those spans
   - include full tool-exchange spans
   - include any fully enclosed active compressed blocks

4. **Handle prior blocks**
   - if the closure fully covers active blocks, mark them for supersession
   - partial overlap with an active block is invalid unless the closure expansion can deterministically absorb the whole block
   - the runtime, not the agent, owns this decision

5. **Validate**
   - boundaries must resolve in the current materialized snapshot
   - final closure must be contiguous in canonical span order
   - no ambiguous partial coverage remains after closure expansion

6. **Persist the new block**
   - store one `CompressionBlockV2`
   - persist exact `startSpanKey`, `endSpanKey`, and `supersedesBlockIds`
   - preserve the agent summary exactly as written
   - do not perform placeholder expansion in v2

7. **Supersede old blocks atomically**
   - covered older blocks become `status: "superseded"`
   - the new block becomes `status: "active"`

### Important consequence

A single `compress` transaction removes both:
- visible source history in the selected closure
- all deterministically attached hidden baggage for that closure

This is the caching-safe way to shrink prompt mass.

---

## Materialization algorithm

Materialization must be byte-stable for a given source snapshot and block set.

### Steps

1. Build canonical spans from the source transcript.
2. Walk spans in order.
3. If a span range is covered by an active block, emit one synthetic compressed block message.
4. Otherwise emit the raw visible span.
5. After render, assign visible IDs in order.

### Synthetic block format

Keep one canonical rendering format, for example:

```text
[Compressed section: <topic>]

<summary>

<dcp-block-id>bN</dcp-block-id>
```

### Placement rule

The synthetic block is emitted at the position of the first covered span.

No timestamp math.
No `anchorTimestamp - 0.5` insertion tricks.
No post-hoc resorting.

That makes the rendered transcript much easier to reason about and test.

---

## What v2 removes or de-scopes from v1

Some v1 features conflict directly with the new invariants.

### 1. Per-request pruning state mutations

The following should no longer mutate transcript state on ordinary `context` passes:
- deduplication via `applyDeduplication(...)`
- error purging via `applyErrorPurging(...)`
- opportunistic tool tombstoning via `prunedToolIds`

If these behaviors remain useful, they should be reintroduced in one of two ways:
- folded into explicit compress transactions
- exposed as separate explicit user tools that create deterministic block-log mutations

But they should not silently change the rendered prompt between compresses.

### 2. Render-time nudge policy

The saved `agent/sessions` transcript suggests nudges are not persisted as normal session-history messages. That part of the architecture is fine.

The real problems are:

- `getNudgeType(...)` is too eager
- the policy is keyed to raw `context` event cadence instead of user-turn pacing
- nudges can repeat even when nothing meaningful changed
- after a successful `compress`, the system can nudge again too soon
- `injectNudge(...)` rewrites existing visible messages at render time, which is worse for cache shape than a dedicated advisory layer

So v2 should **keep nudges**, but simplify them into threshold-driven pressure signals with straightforward debounce.

Desired policy:
- nudge only when context usage is above configured threshold(s)
- debounce by user turns, not by raw `context` passes
- after a successful `compress`, suppress further nudges until at least one newer user turn has happened
- soft vs strong nudges should come from threshold bands, not semantic guesses about whether history is "closed"
- do not try to infer whether the model currently has a compressible slice; that is the agent's job
- prefer one stable advisory placement instead of rewriting old messages
- keep nudges out of canonical/session history
- keep nudge semantics out of the agent contract

Suggested runtime state:
- `lastNudgeTurn`
- `lastCompressTurn`
- optionally `lastNudgeLevel` when strong/soft escalation needs debouncing too

Good render options:
- a deterministic synthetic advisory block at the tail of the rendered transcript
- a deterministic system-suffix reminder layer
- UI/status surfaces in addition to the rendered advisory

The key rule is:

**It is fine to nudge the agent, but the nudge policy must be simple, threshold-based, debounced by user turns, and render-only.**

### 3. Placeholder-based recompress

`(bN)` placeholder expansion is too complex for the agent and unnecessary if the backend owns block supersession.

v2 should stop requiring:
- manual placeholder management
- exact block placeholder accounting
- summary rewriting just to inline prior blocks

Phase 1 may keep `bN` as a boundary input for compatibility, but placeholder expansion should be removed from the long-term design.

---

## Agent contract in v2

This is the desired end state for prompt text in `prompts.ts`.

### What the agent sees

- visible `mNNN` boundaries
- optionally visible `bN` markers for compatibility
- one simple instruction: compress closed visible ranges with exhaustive summaries

### What the agent no longer sees

- placeholder rules
- block lineage bookkeeping
- overlap policy details
- reminder-cleanup responsibilities
- hidden artifact semantics

### Simplified contract text

The agent contract should move toward:

- Pick a closed visible range.
- Use visible IDs that exist in the current transcript.
- Summarize the selected slice faithfully and exhaustively.
- Do not worry about prior compressed blocks or hidden artifacts; DCP will handle them.

That is much simpler than the current placeholder-heavy tool description.

---

## Commands in v2

### `/dcp compress`

Still valid.
It remains the explicit way to ask the model to run `compress` now.

### `/dcp decompress`

Still valid.
But it should operate on block status:
- `active`
- `superseded`
- `decompressed`

For now, only `active -> decompressed` is necessary.

### `/dcp sweep`

This command conflicts with “compress is the only mutating transaction.”

Recommended direction:
- deprecate `/dcp sweep`
- or redefine it later as a convenience wrapper that produces a deterministic compression-like mutation instead of directly editing `prunedToolIds`

### `/dcp stats`

Stats should become derived rather than accumulative.

Recommended derived stats:
- active blocks
- superseded blocks
- decompressed blocks
- rendered summary tokens
- estimated raw tokens replaced by active blocks
- net estimated savings in the current materialization

That avoids the current write-amplified counter problem.

---

## Migration plan

This should be incremental.

### Phase 0 — design freeze

Decide the invariants first:
- compress-only removal mutation
- deterministic materialization
- nudges may exist, but only as deterministic render-only overlays
- no placeholder-based recompress requirement

### Phase 1 — add v2 types and snapshot builder

Add new modules:
- `transcript.ts`
- `materialize.ts`
- `migration.ts`

Keep v1 running while v2 snapshot/materialization is built in tests.

### Phase 2 — dual-read state

Support both:
- legacy timestamp blocks
- v2 span-key blocks

On session restore:
- load existing v1 blocks
- map them into v2 coverage once
- materialize using the v2 renderer where possible

### Phase 3 — switch new writes to v2

Change `compress-tool.ts` so new compressions create `CompressionBlockV2` only.

At this point:
- placeholder expansion should stop for new blocks
- supersession should replace overlap rejection

### Phase 4 — remove v1 mutation paths

Delete or retire:
- timestamp-based anchor insertion
- repeated `tokensSaved` accumulation
- `prunedToolIds` as primary pruning state
- `injectNudge(...)`-style in-message render mutation
- placeholder expansion requirements in prompts

### Phase 5 — simplify prompts and commands

Update:
- `prompts.ts`
- `README.md`
- `/dcp` command help

So the visible contract matches the new simpler model.

---

## File-level implementation plan

### `state.ts`

Replace the current timestamp-centric `CompressionBlock` with a v2 block shape and versioned persisted state.

### `compress-tool.ts`

Replace:
- `resolveIdToTimestamp(...)`
- `resolveAnchorTimestamp(...)`
- `expandBlockPlaceholders(...)`
- overlap rejection logic

With:
- visible-ID resolution against the materialized transcript
- canonical closure expansion
- block supersession
- atomic v2 block creation

### `pruner.ts`

Shrink this file substantially.

The current role of `pruner.ts` mixes:
- compression application
- repair logic
- dedup/error heuristics
- reminder injection
- ID injection

In v2, this should split into cleaner responsibilities:
- source snapshot normalization
- canonical span building
- materialization
- visible ID injection

### `index.ts`

Change the extension pipeline so ordinary `context` handling becomes mostly:
- build source snapshot
- materialize active blocks
- inject visible IDs
- return rendered transcript

No other hidden mutations should happen there.

### `commands.ts`

Update block listing/decompression semantics and decide the fate of `/dcp sweep`.

### `prompts.ts`

Rewrite the tool description so agents no longer manage `(bN)` placeholder obligations.

### `README.md`

Rewrite “How it works” around:
- canonical transcript
- deterministic materialization
- block supersession
- compress-only mutation

### `pruner.test.ts`

Move away from anchor/timestamp repair tests and add determinism tests.

---

## Test plan

v2 needs stronger tests than v1 because its main promise is determinism.

### Determinism tests

- repeated materialization with no new compressions yields byte-identical output
- restart + state restore yields the same rendered transcript
- visible `mNNN` assignment is stable for a fixed materialized transcript

### Closure tests

- compressing across part of a tool exchange consumes the whole exchange
- attached reasoning artifacts disappear when the owning span is compressed
- stale reminder fragments disappear when the owning span is compressed
- passthrough entries do not break closure

### Supersession tests

- a new block fully covering older active blocks supersedes them
- old summaries do not accumulate after recompress
- partial overlap is rejected or deterministically expanded in exactly one way

### Migration tests

- v1 timestamp blocks can still render during compatibility mode
- legacy blocks can be remapped into v2 span coverage

### Stats tests

- no repeated accumulation across identical `context` passes
- derived savings reflect current active materialization only

---

## Open questions

These should be resolved before code lands.

### 1. What is the best stable source key available from pi?

If pi exposes a true stable session entry ID, use it.
If not, the fallback key scheme must be documented and tested carefully.

### 2. Do we keep `bN` visible in the prompt long-term?

Recommendation:
- keep it for compatibility during migration
- move toward visible-range compression without requiring agents to reason about block IDs

### 3. How should nudges render?

Recommendation:
- keep nudges
- make them render-only advisories
- never persist them into canonical/session history
- render them in one stable place with one stable format
- gate them on pressure thresholds
- debounce them by user turns
- suppress them immediately after `compress` until a newer user turn
- use UI/status surfaces as an extra channel, not the only channel

### 4. What happens to `/dcp sweep`?

Recommendation:
- deprecate it unless it can be redefined as a deterministic compression-class mutation

---

## Recommended implementation order

1. Add v2 state types and canonical snapshot/span builder.
2. Add deterministic materialization with no timestamp-anchor insertion.
3. Change `compress` to create v2 blocks and supersede fully covered prior blocks.
4. Remove placeholder expansion requirements.
5. Redesign nudge policy around thresholds + user-turn debounce + post-compress suppression, with render-only advisories.
6. Remove or redesign dedup/error/sweep so they no longer mutate outside `compress`.
7. Rebuild stats as derived values.
8. Update prompts, README, and commands.

---

## Short version

The v2 design is:

- **simple for agents**
- **deterministic for caching**
- **transactional for pruning**
- **recursive for recompressing old compressions**

Or more bluntly:

> DCP should stop behaving like a collection of pruning heuristics and start behaving like a deterministic transcript rewrite system whose only write is `compress`.
