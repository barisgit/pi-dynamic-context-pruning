# `src/prompts/` — Codemap

## Responsibility

`src/prompts/` holds all human-readable prompt text used by DCP. It is a pure string store — no logic, no side effects. Strings are exported as named constants and consumed by application-layer handlers in `src/application/`.

## Files

### `src/prompts/index.ts`

**Canonical source of all prompt constants.** All four files below are thin re-exports pointing here.

| Export                       | Purpose                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYSTEM_PROMPT`              | ~12-sentence instruction block appended to the host's system prompt in automatic mode. Tells the agent to compress proactively, describes the `compress` tool's semantics, and defines the "closedness over size" policy.                                                  |
| `MANUAL_MODE_SYSTEM_PROMPT`  | ~6-sentence variant used when `state.manualMode = true`. Instructs the agent to compress only on explicit user request or emergency nudge — never proactively.                                                                                                             |
| `COMPRESS_RANGE_DESCRIPTION` | ~30-line tool-description string registered as the `description` field on the `compress` tool schema. Defines input shape (`ranges[]` with `startId`/`endId`/`summary`/`topic`), summary content rules, nested `(bN)` placeholder semantics, and the no-hot-tail boundary. |
| `CONTEXT_LIMIT_NUDGE_SOFT`   | Empty string (`""`). Legacy placeholder; nudges are now generated dynamically in `application/context-handler.ts`.                                                                                                                                                         |
| `CONTEXT_LIMIT_NUDGE_STRONG` | Empty string (`""`). Same legacy status as above.                                                                                                                                                                                                                          |
| `TURN_NUDGE`                 | Empty string (`""`). Same legacy status.                                                                                                                                                                                                                                   |
| `ITERATION_NUDGE`            | Empty string (`""`). Same legacy status.                                                                                                                                                                                                                                   |

### `src/prompts/system.ts`

Thin re-export shim:

```ts
export { MANUAL_MODE_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./index.js";
```

Provides a stable import path for `application/system-prompt-handler.ts` (`../prompts/system.js`).

### `src/prompts/compress-tool.ts`

Thin re-export shim:

```ts
export { COMPRESS_RANGE_DESCRIPTION } from "./index.js";
```

Provides a stable import path for `application/compress-tool/registration.ts` (`../../prompts/index.js`).

### `src/prompts/nudge.ts`

Thin re-export shim:

```ts
export {
  CONTEXT_LIMIT_NUDGE_SOFT,
  CONTEXT_LIMIT_NUDGE_STRONG,
  ITERATION_NUDGE,
  TURN_NUDGE,
} from "./index.js";
```

Provided for historical import compatibility; all four constants are empty strings — kept so that old import paths do not break.

### `src/prompts.ts`

Root re-export aggregator at the `src/` level:

```ts
export * from "./prompts/index.js";
```

Allows `src/*.ts` shims (legacy compatibility) to reference prompts without knowing the internal directory layout.

## Integration

### System prompt composition

**Consumer:** `application/system-prompt-handler.ts`

On every `before_agent_start` event, the registered handler reads `state.manualMode` and appends the appropriate string to the host's existing system prompt:

```
<host system prompt> + "\n\n" + (MANUAL_MODE_SYSTEM_PROMPT | SYSTEM_PROMPT)
```

### `compress` tool registration

**Consumer:** `application/compress-tool/registration.ts`

The `COMPRESS_RANGE_DESCRIPTION` string is assigned to the `description` field of the `compress` tool schema. The model reads this description to understand input constraints and summary quality requirements before each `compress` call.

### Nudge text (live — no longer from this module)

**Consumer:** `application/context-handler.ts`

Nudge text is built **dynamically** at context-pass time. The four nudge-constant exports in `index.ts` are empty — kept only for backward compatibility. Live nudge content is assembled by two functions in `context-handler.ts`:

- `buildNudgeHeader()` — produces the one-line imperative ("Compress now", "DCP checkpoint") with token-range annotations from `config.compress`
- `buildCompactReminderText()` — wraps the header around the compression-range details injected by `domain/pruning/`

This separation means nudge wording adapts to current context size, nudge type (`context-soft` / `context-strong` / `iteration`), and configured thresholds without requiring a state save or a new release.
