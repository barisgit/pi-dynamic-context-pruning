# `src/prompts/` — Codemap

## Responsibility

Pure string store for all human-readable prompt text used by DCP. No logic, no side effects. Exported as named constants and consumed by application-layer handlers.

## Files

### `src/prompts/index.ts`

Canonical source of all prompt constants.

| Export                       | Purpose                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SYSTEM_PROMPT`              | Compact instruction block appended to the host system prompt. It defines proactive compression, the `compress` mental model, and the closed-work safety boundary.                                                                                                                          |
| `COMPRESS_RANGE_DESCRIPTION` | Concise tool description for `compress`. It preserves the non-schema contracts for visible `mNNNN`/`bN` boundaries, protected-tail avoidance, deterministic-footer-aware summaries that retain consequential command and delegation outcomes, and exact nested-`bN` placeholder expansion. |

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

## Integration

**System prompt** (`application/system-prompt-handler.ts`): appends `SYSTEM_PROMPT` to the host system prompt on every `before_agent_start`. Manual mode was removed — there is now a single prompt mode.

**`compress` tool registration** (`application/compress-tool/registration.ts`): assigns `COMPRESS_RANGE_DESCRIPTION` to the tool schema `description` field. The model reads this to understand input constraints and summary quality requirements.

**Nudge text** (`application/context-handler.ts`): built dynamically at context-pass time. Live nudge content is assembled by `buildNudgeHeader()` and `buildCompactReminderText()` in `context-handler.ts`, adapting wording to current context size, nudge type, and configured thresholds without a state save.
