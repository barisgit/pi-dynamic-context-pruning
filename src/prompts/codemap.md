# `src/prompts/` — Codemap

## Responsibility

Pure string store for all human-readable prompt text used by DCP. No logic, no side effects. Exported as named constants and consumed by application-layer handlers.

## Files

### `src/prompts/index.ts`

Canonical source of all prompt constants.

| Export                     | Purpose                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SYSTEM_PROMPT`            | ~12-sentence instruction block appended to the host system prompt. Tells the agent to compress proactively, describes the `compress` tool semantics, and defines the "closedness over size" policy.                                                                                     |
| `COMPRESS_RANGE_DESCRIPTION` | ~30-line tool-description string registered as the `description` field on the `compress` tool schema. `startId`/`endId` accept `mNNNN` refs (user/toolResult/bashExecution) or `bN` block refs; assistant turns are pulled in via atomic-pair expansion. |
| `CONTEXT_LIMIT_NUDGE_SOFT` | Empty string — legacy placeholder. Live nudge text is assembled dynamically in `application/context-handler.ts`.                                                                                                                                                                      |
| `CONTEXT_LIMIT_NUDGE_STRONG` | Empty string — same legacy status.                                                                                                                                                                                                                                                    |
| `TURN_NUDGE`               | Empty string — same legacy status.                                                                                                                                                                                                                                                   |
| `ITERATION_NUDGE`          | Empty string — same legacy status.                                                                                                                                                                                                                                                   |

### `src/prompts/system.ts`

Thin re-export shim for stable import paths used by `application/system-prompt-handler.ts`:

```ts
export { SYSTEM_PROMPT } from "./index.js";
```

### `src/prompts/compress-tool.ts`

Thin re-export shim for `application/compress-tool/registration.ts`:

```ts
export { COMPRESS_RANGE_DESCRIPTION } from "./index.js";
```

### `src/prompts/nudge.ts`

Legacy re-export shim — all four nudge constants are empty strings, kept only to avoid breaking old import paths:

```ts
export { CONTEXT_LIMIT_NUDGE_SOFT, CONTEXT_LIMIT_NUDGE_STRONG, TURN_NUDGE, ITERATION_NUDGE } from "./index.js";
```

### `src/prompts.ts`

Root re-export aggregator at `src/`:

```ts
export * from "./prompts/index.js";
```

Allows `src/*.ts` shims to reference prompts without knowing the internal layout.

## Integration

**System prompt** (`application/system-prompt-handler.ts`): appends `SYSTEM_PROMPT` to the host system prompt on every `before_agent_start`. Manual mode was removed in dcp-replay-v3 — there is now a single prompt mode.

**`compress` tool registration** (`application/compress-tool/registration.ts`): assigns `COMPRESS_RANGE_DESCRIPTION` to the tool schema `description` field. The model reads this to understand input constraints and summary quality requirements.

**Nudge text** (`application/context-handler.ts`): built dynamically at context-pass time. Nudge constants in this module are empty — kept only for backward compatibility. Live nudge content is assembled by `buildNudgeHeader()` and `buildCompactReminderText()` in `context-handler.ts`, adapting wording to current context size, nudge type, and configured thresholds without a state save.
