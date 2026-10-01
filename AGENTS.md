# AGENTS.md — pi-dynamic-context-pruning

Reference for coding agents operating in this repository.

---

## Project overview

A **pi coding agent extension** (TypeScript/ESM) that implements Dynamic Context Pruning (DCP).
Pi loads extension `.ts` files directly — there is no build step and no compiled output.

Continuation fidelity is the primary objective: preserve intent, restrictions, corrections, evidence, and uncertainty rather than minimizing tokens or maximizing cache hits. Substantial authored memory is valid. No blanket losslessness guarantee follows from compression or recovery.

**Host runtime:** Node.js inside pi  
**Dev/test toolchain:** Bun  
**Package type:** `"type": "module"`

Important runtime constraint:

- Do **not** assume Bun-specific runtime APIs such as `bun:ffi` are available when this extension is loaded by pi.
- If DCP ever needs a Rust performance core, keep the extension entrypoint/hooks/UI/session integration in TypeScript and move only coarse-grained compute into Rust.
- Preferred Rust integration order:
  1. long-lived Rust sidecar (default)
  2. Node native addon (`napi-rs` / N-API) when in-process latency matters
- Avoid per-event process spawning and Bun-only FFI designs.

---

## Documentation map

Use the docs intentionally:

- `README.md`
  - user-facing install/config/commands/behavior overview
  - should describe current shipped behavior, not speculative v2-only ideas
- `AGENTS.md`
  - contributor/agent-oriented architecture and editing guidance
  - this file should explain the current implementation model and repo invariants
- `DCP_V2_DESIGN.md`
  - target architecture / design direction
  - contains valuable invariants and future-state reasoning, but parts are still aspirational
- `tests/`
  - Bun test suites split by behavior area for current runtime behavior
  - if docs and tests disagree, treat the tests plus live code as truth and update the docs

---

## Commands

| Task            | Command                            |
| --------------- | ---------------------------------- |
| Run tests       | `bun run test`                     |
| Watch tests     | `bun run test:watch`               |
| Type-check      | `bun run check-types`              |
| Lint            | `bun run lint`                     |
| Format          | `bun run format`                   |
| Full local gate | `bun run ci`                       |
| Build           | _(none — pi loads `.ts` directly)_ |

Notes:

- Tests use `bun:test` and live under `tests/unit/` and `tests/integration/`.
- `tests/helpers/dcp-test-utils.ts` contains shared fixtures/factories.
- When changing semantics, update both docs and the focused behavior tests together.

---

## Current architecture status

This repo is post **direct-restore**: persistence restores coverage-bearing blocks directly, and the in-memory block model is still the legacy block log with source-key anchors.

1. **Active runtime path = legacy blocks with source-key anchors**

- `state.compressionBlocks` is still the live block log used by the extension at runtime.
- `src/application/compress-tool/` resolves stable visible refs through canonical source keys and keeps timestamp fallback for legacy blocks.
- `src/domain/pruning/` still applies active legacy blocks on each `context` pass, preferring source-key placement when available.

2. **Exact canonical metadata is already partially live**

- new blocks persist exact `metadata.coveredSourceKeys` and `metadata.coveredSpanKeys`
- exact metadata is preferred over timestamp approximation whenever available
- exact metadata is used for:
  - live owner/liveness derivation
  - exact supersession of older fully covered blocks

3. **Canonical transcript scaffolding already exists**

- `src/domain/transcript/` builds `TranscriptSnapshot`
- assistant tool-call messages plus matching `toolResult` / `bashExecution` are grouped into one `tool-exchange` span
- this span model now drives several current semantics, not just future v2 work

4. **Persistence is direct-restore (schema v5)**

- empty on-disk `dcp-state` entries remain tiny scalar bootstraps (`PersistedDcpStateV3`)
- once blocks exist, `serializePersistedState()` writes `PersistedDcpStateV5`: scalars plus active blocks with exact coverage, source-key anchors, and finite timestamp fallbacks; inactive blocks are slimmed
- `src/application/session-handler.ts` uses the latest non-unchanged state entry: v1/v5 restore coverage directly; v3 restores scalar continuity; legacy v4 restores scalars but lacks recoverable coverage (`reset-legacy-v4`). Do not claim that this pre-existing lossy-v4 limitation is lossless migration
- runtime-only `state.toolCalls` records are rehydrated from the source transcript before context materialization, while live event records win; resume therefore preserves dedup/Jev candidate eligibility without persisting the tool-record cache
- **Mid-run restore is non-destructive on `session_start`.** pi can re-fire `session_start` mid-run (no matching `session_shutdown`). Because restore is snapshot-only, a `resetState()` + rebuild in that window would silently drop a just-created compress block that has not flushed yet. `directRestore` therefore retains live state (`restoreOutcome: "retained-live"`) when `state.pendingSave` is set and retain-live is allowed. This guard is scoped to `session_start` only; `session_tree` is a genuine branch switch and always loads the target branch (`allowRetainLive: false`).
- **`compress` flushes inline.** Like native compaction, a successful `compress` calls `saveState(...)` immediately after block accounting, so a new block reaches disk before any mid-run restore can run, rather than waiting for a deferred `agent_end`.
- `src/domain/replay/` is retained for offline scripts such as `scripts/vacuum-dcp-session.ts` and `scripts/replay-equivalence.ts`, not for live resume
- `src/domain/compression/materialize.ts` contains only the shared compressed-block renderer used by the legacy runtime path and offline replay/native-compaction support

---

## Current behavioral model (important)

### 1. Compression blocks

- New `compress` calls still create legacy `CompressionBlock`s with timestamp boundaries for fallback.
- New blocks also persist exact canonical metadata and source-key anchors when possible.
- Successful `compress` blocks also persist `compressCallId` so provider-payload filtering can recognize when a rendered block already represents that tool call.
- Fully covered older exact-coverage blocks are **superseded**. Agent-authored consolidation may rewrite one block (`bN..bN`) or several, without copying old summaries. New calls validate optional explicit `(bN)` inclusions against fully superseded active blocks, at most once; historical replay keeps its tolerant placeholder expansion. Exact coverage and saved originals remain the authority, not the generated Record label.
- Partial ambiguous overlap still rejects conservatively.
- Timestamp-only legacy overlap remains conservative and still rejects.
- Protected-tail rejections and injected nudges now surface planning hints: hot-tail start, protected visible IDs, protected active block IDs, and the largest safe visible candidate ranges.
- Live `compress` requires a nonempty `ranges` array; summaries remain freeform and both topic levels are optional (`Compressed history` fallback). There is no live heading field or heading-only invocation.
- Blocks store one historical `summary`, plus original `startId`/`endId` for a time-fixed Record header using `endTimestamp` in ordinary context. Summaries record constraints/corrections, rationale, evidence, and unresolved issues at the stretch's close. Later user corrections supersede historical excerpts and plans.
- `renderFullBlockCount` / `renderCompactBlockCount` are the existing configurable tier counts (defaults: newest 4 full, next 8 summary-only). Full includes the entire authored summary, conversation excerpts, aggregate effects, and modified-file paths. Summary-only keeps the entire authored summary and omits conversation/effects/modified-files. Older blocks render no model-visible block, but still hide exactly covered raw messages and retain canonical history. Rank the canonical block log including inactive entries before selecting active records, so retiring newer blocks cannot revive omitted older blocks after append or restore. This is count-based admission only: add no new timing, cadence, or retention knobs.
- Native rendering omits generated Record headers (including expanded nested headers) and generated tier/version labels; structured coverage/boundaries remain.
- `src/application/checkpoint-handoff.ts` generates a fresh orientation only at native compaction, using a dedicated working-model completion over current effective context **including the retained recent tail**. It rebuilds current context, materializes on cloned state, avoids Pi's tool-result-clipping summary serializer, and never enters a recursive main-agent turn. Use the host `modelRegistry.complete` for provider/auth routing; the former direct pi-ai `complete` fallback is not exported by the 0.87.1 SDK. Injectable generator/completion seams support tests.
- At `session_before_compact`, compute `minHiddenCoverageRatio` against the actual hidden range at the host's unchanged `firstKeptEntryId`; never move the cut to improve coverage. Exact `coveredSourceKeys` are the only omission certificate. Timestamp intervals remain fallback placement/legacy data and must not certify coverage.
- At sufficient coverage, the native checkpoint is budgeted retained blocks plus a fresh current-intent/constraints handoff from effective context, including the recent tail and later corrections. It may discard uncovered hidden raw tool evidence from model text while canonical session history stays intact. Do not recursively carry `preparation.previousSummary`; the fresh handoff replaces accumulated summary state.
- Budget reduction order is optional block metadata first, then whole oldest retained records. Never clip an authored summary. Low actual coverage or a fresh handoff that remains oversized after record dropping falls back to the host summarizer by replacing `event.preparation.previousSummary` with the fresh handoff. Do not seed this fallback through `event.customInstructions` and do not append old summaries. In-flight fallback details retain commit bookkeeping: retire all fully hidden exact blocks (including age/budget omissions), reset nudge watermarks, and resume authorized auto-compaction only after a real commit; persist no new schema fields.
- Unknown boundaries and failed/empty/truncated fresh handoffs still cancel because neither DCP nor host fallback has a safe current-intent seed. Do not restore the preserve-all budget-cancellation liveness dead end. This contract adds no async/background completion path, model-path selector, persistence schema/rollover change, or Jev promotion.
- `config.enabled: false` or `nativeCompaction.enabled: false` leaves host compaction alone. `/dcp compact` retains its active-block-only command UX.
- `state.heading` is retained only for historical compatibility. Heading-bearing v5 snapshots and old heading-only tool exchanges continue to decode automatically; no schema bump/manual conversion/new session is required. Ordinary materialization never injects a mutable heading or rewrites a previously baked heading. Heading-age reminders are removed. Legacy synthetic `INTERNAL_HEADING` messages remain excluded from source snapshots/ref injection/pruning.

- Full rendered blocks contain four distinct layers: the historical record, bounded chronological `u:` / `a:` conversation excerpts, aggregate read/search/mutation/command/delegation counts, and bounded unique modified-file paths. Individual tool calls and commands are not rendered deterministically; the summary must preserve consequential commands, verification outcomes, and delegated findings. Summary-only blocks contain only the whole historical record.
- fo-coding-agent `sandbox.result` version 1 envelopes are treated as containers: nested timeline operations feed effect counts and modified-file metadata, while the outer `run` call and raw nested operations stay out of visible block text.

### 2. Ownership / hidden-provider pruning

- Visible message IDs (`m0001`-style, widening after `m9999`) are injected only on user/toolResult/bashExecution messages, and `bN` block IDs are **agent-facing boundaries only**.
- Hidden/provider artifact ownership is **not** derived from arbitrary rendered text.
- Do not render source owner markers into model-visible transcript content.
- `src/domain/provider/payload-filter.ts` prunes stale `reasoning`, `function_call`, and `function_call_output` using canonical live owner keys plus the latest internal visible-ref → owner map.
- Successful represented `compress` artifacts use a two-phase provider-payload rule: keep the newest live represented `compress` `function_call` / `function_call_output` as a compact success receipt, and suppress older represented pairs.
- Failed or otherwise unrepresented `compress` attempts must stay visible.
- Do **not** reintroduce visibility-based ownership heuristics.

### 3. Logical turns

DCP no longer treats “turn” as user-message count.

Current rule:

- one standalone visible message = one logical turn
- one assistant tool-call message plus its matching tool results = one logical turn

This logical-turn model is used by:

- `state.currentTurn`
- nudge debounce / cool-down semantics
- shared candidate eligibility age (`ToolRecord.turnIndex`)
- hot-tail protection (`protectRecentTurns`)

### 4. Saved-token accounting

- `state.tokensSaved` is **not** a lifetime cumulative total.
- It is the **current estimated net savings from active compression blocks**.
- Each active block stores `savedTokenEstimate`.
- Repeated `context` passes must not double-count.

### 5. Pruning and prefix-cache boundaries

- Exact-result deduplication is the only always-on automatic heuristic removal: require matching request fingerprint, complete visible content and error status, and retain the newer copy. Same arguments alone do not prove redundancy.
- Opt-in age masking (`strategies.ageMasking.enabled`, default false) is the one age rule: successful text outputs and exposed non-error fo Refs that pass shared candidate eligibility (`candidates.minAgeTurns`, size, protections, hot tail) join dedup in `commitHeuristicPruning` under the same item/batch gates. It always keeps errors, images/nontext, outer containers, write/edit/apply_patch, compress/dcp_recover and AGENTS.md/CLAUDE.md/SKILL.md reads. Do not add per-tool age tables; the retired customStrategies stay retired.
- Deterministic error purging and custom age-only clear/head-tail collectors are retired. Deprecated configuration cannot reactivate them. Preserve decoding/rendering of historical saved actions where needed for resume and exact recovery; do not silently reset existing state.
- `strategies.pruneCadenceTurns` controls cadence; never hardcode the user's25. Duplicate removals use bucketed eligibility and existing per-item/batch net-savings gates, including projection/recovery-marker costs and live red-zone semantics. Shadow proposals never apply. Explicit live proposals use the same actual net-savings gate and can commit on the next context pass after the asynchronous response, without waiting another cadence.
- Tool-result pruning replaces visible output, not the whole assistant/tool pair. Canonical originals stay untouched. Persisted unsafe image/composite/error selections retain their existing conservative restoration checks.
- Outer `run`, `subagent`, `workflow`, images and unsupported output are not generic logs. Exposed inner fo Refs use the optional versioned bridge for precise enumeration/projection/recovery. Private, derived, ambiguous and independently emitted error/image channels are not guessed or flattened.
- Composite `fo-ref:v1` IDs must survive resume and GC while their originals remain live. All exposed copies receive a consistent projection. Missing/unsupported bridges fail closed without affecting ordinary Pi.

### Jev review and explicit live application

- Optional `strategies.jev.enabled` defaults false; existing enabled configurations remain shadow unless `strategies.jev.apply === true`. Shadow judgments never mutate pruning selections or model text. Live proposals feed the existing commit/projection/savings path, including fo Refs, only after current identity/content/eligibility checks. Canonical originals never change. Exact duplicate pruning remains independent.
- One complete tool output per request, with tool name/arguments/error flag and bounded recent PUBLIC user/assistant dialogue. Exclude tool payloads, thinking and private metadata from dialogue. Existing summaries are older background, not authoritative current direction. No separate semantic task detector, supersession tracker or handoff field.
- Keep/drop choice schema; require raw DROP and `P(drop) >= 0.60` for acceptance. Confidence remains telemetry, not a chosen-option probability or calibrated accuracy. API/parse failures retain. The probability policy is `keep-drop-pdrop-v2`; do not mix it with historical confidence-gated evidence. No strong_keep, TTL, automatic summarizer or boolean conversion.
- Do not screen already eligible public requests for credential-like patterns in output, dialogue, tool names, or arguments. Selected public data may contain sensitive text; preserve private/unexposed/image/protected-tool boundaries and token budgets. Transport credentials and raw transport errors must never enter the audit ledger.
- Review all eligible outputs with bounded parallelism each CONFIGURED cadence. Shared candidate age/size/protection rules apply; eligible errors may be reviewed, never assumed resolved by age. KEEP is reevaluated next cadence. The private ledger is for audit and same-cadence duplicate suppression/resume, not cross-cadence relevance reuse.
- Snapshot one batch per cadence. Do not cancel it on every ordinary dialogue update and starve autonomous work. Session/branch resets prevent cross-session state/audit writes; records identify the actual snapshot and cadence. Background failures must never block context rendering.
- Runtime imports `src/infrastructure/jev-client.ts`; evaluation scripts re-export that client, never the reverse. Infrastructure owns private append-only audit files under the agent directory `dcp/jev/<session-id>.jsonl`, outside transcripts. Save actual sent context/instructions and artifact identity/hash, not large duplicated artifacts, auth material or raw transport errors. Audit skipped oversized inputs instead of silently disappearing.
- Live application initially protects error outputs rather than bypassing historical error-replacement safety. Revalidate late proposals after lifecycle/content changes; never load old ledger judgments as prune commands. Record application separately from proposal/held decisions. Applied selections use existing session persistence; no schema change or extra pruning engine. Model probabilities are not proof of safe omission.

### 6. Debug logging

- `config.debug` writes best-effort JSONL diagnostics to `~/.pi/log/dcp.jsonl`.
- Current logs include extension/session lifecycle, state saves, context evaluation, `heuristic_prune_evaluated` (per-pass deterministic dedup gate decision: candidate counts, action counts, item/batch gate outcome, redZone, cadence bucket, committed count), nudge emission, provider-payload filtering, and `compress` success/failure.
- Debug logging must never affect runtime behavior.

---

## Module map

| Path                                    | Purpose                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                          | Thin pi extension entrypoint; wires config, state, tools, commands, and hook handlers                         |
| `src/types/`                            | DCP config, state, message, and provider/boundary contracts                                                   |
| `src/domain/transcript/`                | Canonical source-item/span snapshots, logical turns, exact coverage, owner-key derivation                     |
| `src/domain/refs/`                      | Visible ref parsing/formatting/allocation and DCP metadata stripping                                          |
| `src/domain/compression/`               | Compression range helpers, materialization, exact metadata, planning, supersession helpers                    |
| `src/domain/pruning/`                   | Active runtime pruning path: block application, repair, dedup, Jev eligibility, nudge injection, ID injection |
| `src/domain/provider/`                  | Provider-payload stale artifact filtering using canonical owner keys                                          |
| `src/application/`                      | Pi hook/tool/command orchestration and host payload adaptation                                                |
| `src/application/checkpoint-handoff.ts` | Dedicated working-model orientation from full effective context at compaction                                 |
| `src/application/recover-tool.ts`       | Canonical saved-output recovery and optional fo bridge discovery                                              |
| `src/application/compress-tool/`        | `compress` registration; validation/artifact helpers live in domain/compression/tooling                       |
| `src/application/commands/dcp.ts`       | `/dcp` slash command registration                                                                             |
| `src/infrastructure/`                   | JSONC config loading, debug logging, persisted-state migration/serialization                                  |
| `src/prompts/`                          | System prompt additions, compress tool contract text, nudge text                                              |
| `tests/unit/`                           | Focused Bun unit suites for transcript, compression, pruning, nudges, provider filtering                      |
| `tests/integration/`                    | End-to-end applyPruning/compress-tool/debug behavior coverage                                                 |
| `DCP_V2_DESIGN.md`                      | future-state design and invariants                                                                            |

### Layer rules

- Domain modules must not import `@earendil-works/pi-coding-agent`, filesystem utilities, config loading, debug logging, or application handlers.
- Application modules adapt pi/provider payloads and delegate pure decisions to domain modules.
- Infrastructure modules own side effects such as config files, persisted-state migration, and JSONL debug logging.

---

## Common edit targets

### If you change compression range semantics

Touch at least:

- `src/application/compress-tool/` and `src/domain/compression/`
- `src/domain/pruning/`
- `tests/unit/compression.test.ts` and relevant `tests/integration/`\*
- `README.md` / `AGENTS.md` if user-visible behavior changes

### If you change ownership / hidden artifact filtering

Touch at least:

- `src/domain/provider/payload-filter.ts`
- `src/domain/transcript/`
- `src/application/provider-handler.ts`
- `tests/unit/provider-payload-filter.test.ts`

### If you change turn semantics

Touch at least:

- `src/domain/transcript/`
- `src/domain/pruning/`
- `src/domain/compression/`
- `src/state.ts` / `src/types/state.ts`
- `src/types/config.ts` / `README.md`
- `tests/unit/transcript.test.ts` and `tests/unit/nudge.test.ts`

### If you change persisted block metadata

Persistence is **direct-restore**: v5 `dcp-state` entries persist active compression blocks with exact coverage and finite timestamp fallback so resume does not replay the live context buffer. Empty sessions still write v3 scalar markers and restore scalar continuity. Legacy v4 omitted recoverable coverage (see the compatibility limitation above). Current v5 shapes, including historical headings, remain unchanged; users must not need manual conversion or a fresh session for this update. Anything needed by live pruning after reload must be persisted in v5 or derivable from the current transcript.

Touch at least:

- `src/state.ts` / `src/types/state.ts`
- `src/infrastructure/persistence.ts`
- `src/domain/replay/` (replay must be able to reproduce the new field)
- `src/application/session-handler.ts` (restore branching between replay and snapshot fallback)
- `scripts/replay-equivalence.ts` and `scripts/vacuum-dcp-session.ts` (the verifiers that gate VAL-REPLAY-RESTORES-EQUIVALENT-STATE and VAL-RETRO-VACUUM-PRESERVES-RESTORE)
- `tests/unit/compression.test.ts`, `tests/unit/replay.test.ts`, `tests/integration/persistence-budget.test.ts`, `tests/integration/legacy-session-restore.test.ts`, `tests/unit/vacuum.test.ts`

---

## Key invariants — do not break

1. **Assistant + tool-result pairs must be removed atomically.**

- If a compression range touches a tool result, the matching assistant/tool-call message must come with it.
- `src/domain/pruning/` contains both expansion logic and a repair safety net.

2. **Prefer exact coverage metadata over timestamps.**

- `coveredSourceKeys` / `coveredSpanKeys` are the best available truth.
- Timestamp fallback exists for backward compatibility only.

3. **Do not solve liveness with long-lived caches.**

- Persist canonical facts.
- Recompute liveness from the current source transcript plus active blocks.

4. **Visible IDs and internal ownership are different layers.**

- `m0001`-style non-assistant message refs / `bN` block refs are for the agent/tool contract; assistants are selected through surrounding refs and atomic tool-pair expansion.
- canonical owner keys are internal runtime bookkeeping and must not be rendered as visible owner tags.

5. **Supersession is allowed only for exact full coverage.**

- Full containment of an older exact block is absorbable.
- Partial ambiguous overlap should still reject.

6. **Hot-tail protection is about recent logical work, not raw message count.**

- `protectRecentTurns` protects recent logical turns/tool batches.

7. **Saved-token accounting must be stable across repeated renders.**

- never re-add the same block savings on every `context` pass.

---

## Imports

- Always use `.js` extension for local imports:
  ```ts
  import { loadConfig } from "./config.js";
  ```
- Use `import type` for type-only imports.
- Named imports preferred; default export only for the extension entry point (`index.ts`).

---

## Code style

### Naming

| Kind                     | Convention              | Examples                                       |
| ------------------------ | ----------------------- | ---------------------------------------------- |
| Files                    | kebab-case or camelCase | `compress-tool.ts`, `pruner.ts`                |
| Interfaces / Types       | PascalCase              | `DcpState`, `CompressionBlock`, `ToolRecord`   |
| Functions                | camelCase               | `applyPruning`, `buildTranscriptSnapshot`      |
| Constants (module-level) | UPPER_SNAKE_CASE        | `DEFAULT_CONFIG`, `ALWAYS_PROTECTED_DEDUP`     |
| Variables / parameters   | camelCase               | `contextPercent`, `activeBlocks`, `toolCallId` |

### Sections

Use the established separators:

```ts
// ---------------------------------------------------------------------------
// Section Name
// ---------------------------------------------------------------------------
```

### JSDoc

- Add concise JSDoc to exported functions and non-trivial interfaces.
- Keep comments factual and current; stale comments are actively harmful in this repo.

### Types

- Explicit return types on exported functions.
- `any` is acceptable at message-shape boundaries where provider/pi payloads are heterogeneous.
- Prefer stronger internal typing when adding new helpers.

---

## Error handling

Established patterns:

1. **Best-effort / safe default**

- config loading
- optional file reads
- non-critical inspection paths

2. **Throw explicit domain errors**

- invalid IDs
- invalid compression ranges
- unsupported overlap

Do not silently swallow programming mistakes.

---

## Dependencies

| Package                           | Role                                                       |
| --------------------------------- | ---------------------------------------------------------- |
| `jsonc-parser`                    | Parse JSONC config files                                   |
| `gpt-tokenizer`                   | OpenAI-style token estimates with chars/4 fallback wrapper |
| `@earendil-works/pi-coding-agent` | Peer — `ExtensionAPI`, event types                         |
| `@earendil-works/pi-tui`          | Peer — UI types                                            |
| `@earendil-works/pi-ai`           | Peer — tool input schemas and model types                  |

---

## Recommended workflow for non-trivial edits

1. Read `AGENTS.md`, `README.md`, and the relevant module(s).
2. Read the matching `pruner.test.ts` section before editing semantics.
3. Make the smallest coherent change.
4. Update docs/comments if user-visible or architectural semantics changed.
5. Run `bun run ci` before committing.
6. Commit in small logical slices when the repo is green.
