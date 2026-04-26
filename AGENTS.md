# AGENTS.md — pi-dynamic-context-pruning

Reference for coding agents operating in this repository.

---

## Project overview

A **pi coding agent extension** (TypeScript/ESM) that implements Dynamic Context Pruning (DCP).
Pi loads extension `.ts` files directly — there is no build step and no compiled output.

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

This repo is in a **hybrid state**:

1. **Active runtime path = legacy blocks with source-key anchors**
   - `state.compressionBlocks` is still the live block log used by the extension.
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

4. **Full v2 materialization is not active yet**
   - `compressionBlocksV2` and `src/domain/compression/materialize.ts` are scaffolding / shared renderer support
   - the runtime still materializes legacy blocks, not full v2 span-key blocks

---

## Current behavioral model (important)

### 1. Compression blocks

- New `compress` calls still create legacy `CompressionBlock`s with timestamp boundaries for fallback.
- New blocks also persist exact canonical metadata and source-key anchors when possible.
- Successful `compress` blocks also persist `compressCallId` so provider-payload filtering can recognize when a rendered block already represents that tool call.
- Fully covered older exact-coverage blocks are **superseded**.
- Partial ambiguous overlap still rejects conservatively.
- Timestamp-only legacy overlap remains conservative and still rejects.
- Protected-tail rejections and injected nudges now surface planning hints: hot-tail start, protected visible IDs, protected active block IDs, and the largest safe visible candidate ranges.

### 2. Ownership / hidden-provider pruning

- Visible `mNNNN` IDs and `bN` block IDs are **agent-facing boundaries only**.
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
- error-purging age (`ToolRecord.turnIndex`)
- hot-tail protection (`protectRecentTurns`)

### 4. Saved-token accounting

- `state.tokensSaved` is **not** a lifetime cumulative total.
- It is the **current estimated net savings from active compression blocks**.
- Each active block stores `savedTokenEstimate`.
- Repeated `context` passes must not double-count.

### 5. Prefix-cache mutation trade-offs

DCP intentionally changes older rendered context in a few places. Treat these as cache-cost trade-offs, not bugs:

- Compression blocks replace covered raw transcript spans with rendered `bN` blocks. This is the primary intentional prefix-cache break and should buy significant token savings.
- `applyErrorPurging()` marks old errored `toolResult`s after `purgeErrors.turns` logical turns by adding their `toolCallId` to `state.prunedToolIds`.
- `applyDeduplication()` marks older duplicate `toolResult`s in `state.prunedToolIds` while keeping the newest result.
- `applyToolOutputPruning()` does **not** remove the whole assistant/tool pair; it replaces matching `toolResult.content` with a stable tombstone. The cache break happens when the ID first enters `state.prunedToolIds`; later renders should be stable.
- Render detail aging can change older block text when blocks move full → compact → minimal according to `renderFullBlockCount` / `renderCompactBlockCount`.
- Provider-payload filtering is separate from visible transcript rendering. The newest represented successful `compress` exchange is minified to a receipt; older represented pairs are suppressed.

Ideas discussed but not currently implemented:

- replace N-turn error purging with compression-driven or explicit-sweep-only pruning
- make stale error/dedup pruning emergency/context-pressure-driven instead of time/turn-driven
- batch tombstone transitions into explicit deterministic pruning checkpoints
- prefer representation-driven artifact pruning, where old artifacts are removed/minified only after a durable block or receipt represents them

### 6. Debug logging

- `config.debug` writes best-effort JSONL diagnostics to `~/.pi/log/dcp.jsonl`.
- Current logs include extension/session lifecycle, state saves, context evaluation, nudge emission, provider-payload filtering, and `compress` success/failure.
- Debug logging must never affect runtime behavior.

---

## Module map

| Path                              | Purpose                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/index.ts`                    | Thin pi extension entrypoint; wires config, state, tools, commands, and hook handlers               |
| `src/types/`                      | DCP config, state, message, and provider/boundary contracts                                         |
| `src/domain/transcript/`          | Canonical source-item/span snapshots, logical turns, exact coverage, owner-key derivation           |
| `src/domain/refs/`                | Visible ref parsing/formatting/allocation and DCP metadata stripping                                |
| `src/domain/compression/`         | Compression range helpers, materialization, exact metadata, planning, supersession helpers          |
| `src/domain/pruning/`             | Active runtime pruning path: block application, repair, dedup, purge, nudge injection, ID injection |
| `src/domain/nudge/`               | Nudge decision helpers re-exported from pruning/domain behavior                                     |
| `src/domain/provider/`            | Provider-payload stale artifact filtering using canonical owner keys                                |
| `src/application/`                | Pi hook/tool/command orchestration and host payload adaptation                                      |
| `src/application/compress-tool/`  | `compress` registration plus validation/artifact helper exports                                     |
| `src/application/commands/dcp.ts` | `/dcp` slash command registration                                                                   |
| `src/infrastructure/`             | JSONC config loading, debug logging, persisted-state migration/serialization                        |
| `src/prompts/`                    | System prompt additions, compress tool contract text, nudge text                                    |
| `src/*.ts` shims                  | Compatibility re-exports for older local import paths                                               |
| `tests/unit/`                     | Focused Bun unit suites for transcript, compression, pruning, nudges, provider filtering            |
| `tests/integration/`              | End-to-end applyPruning/compress-tool/debug behavior coverage                                       |
| `DCP_V2_DESIGN.md`                | future-state design and invariants                                                                  |

### Layer rules

- Domain modules must not import `@mariozechner/pi-coding-agent`, filesystem utilities, config loading, debug logging, or application handlers.
- Application modules adapt pi/provider payloads and delegate pure decisions to domain modules.
- Infrastructure modules own side effects such as config files, persisted-state migration, and JSONL debug logging.
- Compatibility shims in `src/*.ts` should stay thin; new code should prefer the layered paths.

---

## Common edit targets

### If you change compression range semantics

Touch at least:

- `src/application/compress-tool/` and `src/domain/compression/`
- `src/domain/pruning/`
- `tests/unit/compression.test.ts` and relevant `tests/integration/*`
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

Touch at least:

- `src/state.ts` / `src/types/state.ts`
- `src/infrastructure/persistence.ts`
- `src/domain/compression/` and `src/application/compress-tool/`
- `tests/unit/compression.test.ts`

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
   - `mNNNN` / `bN` are for the agent/tool contract.
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

| Package                         | Role                               |
| ------------------------------- | ---------------------------------- |
| `jsonc-parser`                  | Parse JSONC config files           |
| `gpt-tokenizer`                 | OpenAI-style token estimates with chars/4 fallback wrapper |
| `@mariozechner/pi-coding-agent` | Peer — `ExtensionAPI`, event types |
| `@mariozechner/pi-tui`          | Peer — UI types                    |
| `@sinclair/typebox`             | Peer — tool input schemas          |

---

## Recommended workflow for non-trivial edits

1. Read `AGENTS.md`, `README.md`, and the relevant module(s).
2. Read the matching `pruner.test.ts` section before editing semantics.
3. Make the smallest coherent change.
4. Update docs/comments if user-visible or architectural semantics changed.
5. Run `bun run ci` before committing.
6. Commit in small logical slices when the repo is green.
