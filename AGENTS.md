# AGENTS.md — pi-dynamic-context-pruning

Reference for coding agents operating in this repository.

---

## Project overview

A **pi coding agent extension** (TypeScript/ESM) that implements Dynamic Context Pruning (DCP).
Pi loads extension `.ts` files directly — there is no build step and no compiled output.

**Runtime:** Bun  
**Package type:** `"type": "module"`

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
- `pruner.test.ts`
  - executable specification for the current runtime behavior
  - if docs and tests disagree, treat the tests plus live code as truth and update the docs

---

## Commands

| Task | Command |
|------|---------|
| Run tests | `bun run pruner.test.ts` |
| Type-check | `tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --skipLibCheck *.ts` |
| Build | _(none — pi loads `.ts` directly)_ |
| Lint | _(no lint config present)_ |
| Format | _(no formatter config present)_ |

Notes:
- Tests are plain `assert` + `console.log`; there is no test framework.
- `pruner.test.ts` is the main regression suite for pruning/compression behavior.
- When changing semantics, update both docs and tests together.

---

## Current architecture status

This repo is in a **hybrid state**:

1. **Active runtime path = legacy timestamp-based blocks**
   - `state.compressionBlocks` is still the live block log used by the extension.
   - `compress-tool.ts` still resolves visible IDs to timestamps.
   - `pruner.ts` still applies active legacy blocks on each `context` pass.

2. **Exact canonical metadata is already partially live**
   - new blocks persist exact `metadata.coveredSourceKeys` and `metadata.coveredSpanKeys`
   - exact metadata is preferred over timestamp approximation whenever available
   - exact metadata is used for:
     - live owner/liveness derivation
     - exact supersession of older fully covered blocks

3. **Canonical transcript scaffolding already exists**
   - `transcript.ts` builds `TranscriptSnapshot`
   - assistant tool-call messages plus matching `toolResult` / `bashExecution` are grouped into one `tool-exchange` span
   - this span model now drives several current semantics, not just future v2 work

4. **Full v2 materialization is not active yet**
   - `compressionBlocksV2` and `materialize.ts` are scaffolding / shared renderer support
   - the runtime still materializes legacy blocks, not full v2 span-key blocks

---

## Current behavioral model (important)

### 1. Compression blocks

- New `compress` calls still create legacy `CompressionBlock`s with timestamp boundaries.
- New blocks also persist exact canonical metadata when possible.
- Fully covered older exact-coverage blocks are **superseded**.
- Partial ambiguous overlap still rejects conservatively.
- Timestamp-only legacy overlap remains conservative and still rejects.

### 2. Ownership / hidden-provider pruning

- Visible `mNNN` IDs are **agent-facing boundaries only**.
- Hidden/provider artifact ownership is **not** derived from rendered visibility.
- `dcp-owner` is an internal canonical owner marker used to associate hidden payload artifacts with canonical source entities.
- `payload-filter.ts` prunes stale `reasoning`, `function_call`, and `function_call_output` using canonical live owner keys derived from the source transcript plus active blocks.
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

---

## Module map

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point; registers hooks and wires pruning/filtering/nudges |
| `config.ts` | JSONC config loading + default schema/comments |
| `state.ts` | Runtime/persisted state types, compression block shapes, metadata helpers |
| `transcript.ts` | Canonical source-item/span snapshot building, logical-turn helpers, exact coverage resolution |
| `pruner.ts` | Active runtime pruning path: block application, dedup, purge, nudge injection, ID injection |
| `compress-tool.ts` | `compress` tool registration, range validation, exact metadata generation, supersession planning |
| `payload-filter.ts` | Provider-payload stale artifact filtering using canonical owner keys |
| `migration.ts` | Persisted state restoration/normalization across schema versions |
| `materialize.ts` | Shared compressed-block renderer + v2 materialization scaffolding |
| `commands.ts` | `/dcp` slash commands |
| `prompts.ts` | system prompt additions, compress tool contract text, nudge text |
| `pruner.test.ts` | Executable regression suite for current semantics |
| `DCP_V2_DESIGN.md` | future-state design and invariants |

---

## Common edit targets

### If you change compression range semantics
Touch at least:
- `compress-tool.ts`
- `pruner.ts`
- `pruner.test.ts`
- `README.md` / `AGENTS.md` if user-visible behavior changes

### If you change ownership / hidden artifact filtering
Touch at least:
- `payload-filter.ts`
- `transcript.ts`
- `index.ts`
- `pruner.test.ts`

### If you change turn semantics
Touch at least:
- `transcript.ts`
- `pruner.ts`
- `compress-tool.ts`
- `state.ts`
- `config.ts` / `README.md`
- `pruner.test.ts`

### If you change persisted block metadata
Touch at least:
- `state.ts`
- `migration.ts`
- `compress-tool.ts`
- `pruner.test.ts`

---

## Key invariants — do not break

1. **Assistant + tool-result pairs must be removed atomically.**
   - If a compression range touches a tool result, the matching assistant/tool-call message must come with it.
   - `pruner.ts` contains both expansion logic and a repair safety net.

2. **Prefer exact coverage metadata over timestamps.**
   - `coveredSourceKeys` / `coveredSpanKeys` are the best available truth.
   - Timestamp fallback exists for backward compatibility only.

3. **Do not solve liveness with long-lived caches.**
   - Persist canonical facts.
   - Recompute liveness from the current source transcript plus active blocks.

4. **Visible IDs and internal ownership are different layers.**
   - `mNNN` / `bN` are for the agent/tool contract.
   - canonical owner keys are internal runtime bookkeeping.

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
  import { loadConfig } from "./config.js"
  ```
- Use `import type` for type-only imports.
- Named imports preferred; default export only for the extension entry point (`index.ts`).

---

## Code style

### Naming
| Kind | Convention | Examples |
|------|-----------|---------|
| Files | kebab-case or camelCase | `compress-tool.ts`, `pruner.ts` |
| Interfaces / Types | PascalCase | `DcpState`, `CompressionBlock`, `ToolRecord` |
| Functions | camelCase | `applyPruning`, `buildTranscriptSnapshot` |
| Constants (module-level) | UPPER_SNAKE_CASE | `DEFAULT_CONFIG`, `ALWAYS_PROTECTED_DEDUP` |
| Variables / parameters | camelCase | `contextPercent`, `activeBlocks`, `toolCallId` |

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

| Package | Role |
|---------|------|
| `jsonc-parser` | Parse JSONC config files |
| `@mariozechner/pi-coding-agent` | Peer — `ExtensionAPI`, event types |
| `@mariozechner/pi-tui` | Peer — UI types |
| `@sinclair/typebox` | Peer — tool input schemas |

---

## Recommended workflow for non-trivial edits

1. Read `AGENTS.md`, `README.md`, and the relevant module(s).
2. Read the matching `pruner.test.ts` section before editing semantics.
3. Make the smallest coherent change.
4. Update docs/comments if user-visible or architectural semantics changed.
5. Run:
   - `bun run pruner.test.ts`
   - `tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --skipLibCheck *.ts`
6. Commit in small logical slices when the repo is green.
