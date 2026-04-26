# Dynamic Context Pruning (DCP) for Pi

Automatically reduces token usage in Pi coding agent sessions by managing conversation context through compression, deduplication, and smart nudges.

## Features

- **Compress tool** — LLM-callable tool that replaces stale conversation ranges with explicit high-fidelity technical summaries, preserving full context fidelity at a fraction of the token cost
- **Deduplication** — automatically removes duplicate tool call outputs (same tool, same args) keeping only the most recent result
- **Error purging** — cleans up failed tool inputs after a configurable number of logical turns
- **Context nudges** — injects compression reminders into the context at configurable thresholds: soft housekeeping notices, strong emergency warnings, and iteration reminders after long tool-call chains
- **Manual mode** — disable autonomous compression nudges; trigger compression only via `/dcp compress` or explicit user request
- **Session persistence** — compression blocks and pruning state survive session restarts
- **Debug logging** — optional best-effort JSONL diagnostics at `~/.pi/log/dcp.jsonl`
- **`/dcp` commands** — inspect context usage, view stats, sweep tool outputs, and manage compression blocks interactively

## Installation

### Global (applies to all pi sessions)

```bash
pi install npm:@complexthings/pi-dynamic-context-pruning
```

### Install globally from GitHub

```bash
pi install https://github.com/complexthings/pi-dynamic-context-pruning
```

### Try it without installing

```bash
pi -e https://github.com/complexthings/pi-dynamic-context-pruning
```

## Documentation map

- `README.md` — user-facing install, config, commands, and current shipped behavior
- `AGENTS.md` — contributor/agent-oriented architecture guide for editing this repo
- `DCP_V2_DESIGN.md` — target architecture and future-state design notes; parts are intentionally aspirational
- `tests/` — Bun test suites for current runtime semantics, split by behavior area

If you are modifying DCP behavior rather than just using it, read `AGENTS.md` first.

## Configuration

DCP uses a layered configuration system (later layers override earlier ones):

1. Built-in defaults
2. `~/.config/pi/dcp.jsonc` — global user config (auto-created with defaults on first run)
3. `$PI_CONFIG_DIR/dcp.jsonc` — if the env var is set
4. `<project>/.pi/dcp.jsonc` — project-local overrides (walk up from cwd)

### Example: `~/.config/pi/dcp.jsonc`

```jsonc
{
  // Disable the extension entirely
  // "enabled": false,

  // Start every session in manual mode
  // "manualMode": { "enabled": true, "automaticStrategies": true },

  // Best-effort JSONL diagnostics at ~/.pi/log/dcp.jsonl
  // "debug": false,

  "compress": {
    // Above 90 % context: fire an emergency nudge
    "maxContextPercent": 0.9,
    // Below 75 % context: no nudges
    "minContextPercent": 0.75,
    // Minimum newer logical turns between nudges
    "nudgeDebounceTurns": 2,
    // Legacy context-pass cadence knob (retained for backward compatibility)
    "nudgeFrequency": 8,
    // Nudge after this many tool calls since the last user message
    "iterationNudgeThreshold": 15,
    // Protect the hot tail beginning at the Nth-most-recent logical turn/tool batch
    "protectRecentTurns": 4,
    // "strong" = emergency tone, "soft" = housekeeping tone
    "nudgeForce": "soft",
    // These tool outputs are never auto-pruned
    "protectedTools": ["compress", "write", "edit"],
  },
  "strategies": {
    "deduplication": {
      "enabled": true,
      // Additional tools to exclude from dedup
      "protectedTools": [],
    },
    "purgeErrors": {
      "enabled": true,
      // Purge failed tool inputs after N logical turns
      "turns": 4,
      "protectedTools": [],
    },
  },
  // Glob patterns — matching file paths are never pruned
  "protectedFilePatterns": [],
  // "off" | "minimal" | "detailed"
  "pruneNotification": "detailed",
}
```

## Commands

All commands are available in the pi TUI via `/dcp <subcommand>`:

| Command               | Description                                                                 |
| --------------------- | --------------------------------------------------------------------------- |
| `/dcp` or `/dcp help` | Show command reference                                                      |
| `/dcp context`        | Show context window usage and session stats                                 |
| `/dcp stats`          | Show pruning statistics (tokens saved, blocks, operations)                  |
| `/dcp sweep [N]`      | Mark last N tool outputs for pruning (default: all since last user message) |
| `/dcp manual`         | Show current manual mode status                                             |
| `/dcp manual on`      | Enable manual mode — autonomous nudges disabled                             |
| `/dcp manual off`     | Disable manual mode — autonomous nudges re-enabled                          |
| `/dcp compress`       | Trigger LLM compression immediately (sends a followUp message)              |
| `/dcp decompress`     | List all active compression blocks                                          |
| `/dcp decompress N`   | Restore compression block `bN` (re-expands it in context)                   |

## How It Works

### Compression blocks

When the LLM calls the `compress` tool it provides one or more `{startId, endId, summary}` ranges. DCP:

1. Resolves visible message refs (`m0001`, `m0042`, etc.) and block refs (`b1`, `b3`) through stable internal source/span keys
2. Records the range as a `CompressionBlock` with legacy timestamps plus canonical source-key coverage/anchor metadata when available
3. On every `context` event, splices out the raw messages in that range and prefers source-key placement for anchored blocks, with timestamp fallback for legacy blocks
4. Injects a synthetic `[Compressed section: …]` user message containing the summary and, for newer blocks, a deterministic activity log
5. Keeps the block state in the session so it survives restarts

When a new compression exactly covers an older exact-coverage block, DCP now supersedes the older block instead of accumulating both summaries. Ambiguous partial overlap still rejects conservatively.

By default, DCP also protects the hot tail of the conversation: ranges that end inside the last `protectRecentTurns` logical turns/tool batches are rejected unless the session is already above the hard emergency threshold (`maxContextPercent`). When a range is rejected, DCP now includes planning hints that surface the hot-tail start, protected `m0001` / `bN` IDs, and the largest visible safe candidate ranges; the same guidance is appended to live compression nudges.

Message IDs (`m0001`, `m0042`, etc.) and block IDs (`b1`, `b3`) are injected into context so the LLM can reference exact compression boundaries. Internal owner keys are not rendered as model-visible metadata; provider-payload filtering uses canonical source/span/block ownership tracked in state.

### Atomic tool pair removal

When a compression range touches any part of an assistant→toolResult group, DCP automatically expands the range to include the entire group. This prevents orphaned `tool_use` or `tool_result` blocks that would cause API validation errors. The expansion logic skips over PI-internal passthrough messages (`compaction`, `branch_summary`, `custom_message`) that may sit between an assistant and its tool results. A post-compression repair pass acts as a safety net to catch any orphaned pairs that the expansion heuristics miss.

### Nudge types

| Nudge              | Condition                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **context-strong** | Above `maxContextPercent`, after logical-turn debounce / post-compress cool-down, `nudgeForce = "strong"`                                          |
| **context-soft**   | Same as above with `nudgeForce = "soft"`                                                                                                           |
| **iteration**      | Between min/max percent, after logical-turn debounce / post-compress cool-down, AND ≥ `iterationNudgeThreshold` tool calls since last user message |
| **turn**           | Between min/max percent, after logical-turn debounce / post-compress cool-down                                                                     |

### Deduplication

Two tool results share the same fingerprint (`toolName::JSON(sorted-args)`) if they were called with identical arguments. All but the last occurrence are replaced with a tombstone message. The tool result remains structurally present, but its content is replaced with:

```txt
[Output removed to save context - information superseded or no longer needed]
```

### Error purging

Tool results that were errors are replaced with a tombstone after `purgeErrors.turns` logical turns have passed, keeping the context clean of long-dead failure traces. The tool result remains structurally present, but its content is replaced with:

```txt
[Error output removed - tool failed more than N turns ago]
```

### Prefix-cache considerations

DCP optimizes context size first, but some strategies intentionally mutate previously rendered transcript content and can invalidate provider prefix cache at the point where the mutation first appears:

- **Compression blocks:** replacing old raw messages with a `[Compressed section: …]` block is the largest intentional prefix change, usually justified by much larger token savings.
- **Error purging:** when an errored tool result crosses the `purgeErrors.turns` age threshold, its old output changes to the error tombstone once. The `toolCallId` then stays in `state.prunedToolIds`, so later renders are stable.
- **Deduplication:** when an older duplicate result becomes pruned, its old output changes to the generic tombstone once.
- **Block detail aging:** when newer blocks are added, older blocks can move from full → compact → minimal according to `renderFullBlockCount` / `renderCompactBlockCount`, changing prior block text.
- **Nudges:** reminder text is appended near the active context tail, so it is usually a suffix change rather than an old-prefix rewrite.
- **Provider-payload filtering:** hidden provider artifacts can be suppressed or minified independently of the visible transcript. Represented successful `compress` artifacts keep only the newest compact receipt and suppress older represented pairs.

Ideas considered for a more cache-stable future policy:

- disable age-based automatic error purging and only prune errors during compression or explicit sweep events
- make stale error/dedup pruning context-pressure or emergency-only instead of N-turn-based
- keep tombstoning deterministic but batch it into explicit pruning checkpoints so cache breaks are rarer and easier to reason about
- prefer representation-driven pruning: remove/minify artifacts only once a durable compression block or receipt represents them

## Status indicator

A `DCP` badge is shown in the pi status bar. In manual mode it displays `DCP [manual]`.

## Development

```bash
bun run test         # Bun test suites under tests/
bun run check-types  # tsc --noEmit
bun run lint         # ESLint
bun run format       # Prettier
bun run ci           # typecheck + lint + tests
```

Pi loads the extension TypeScript directly from `./src/index.ts` — there is no build step for normal development. For normal installs, that extension code runs inside pi's **Node.js** process even though this repo uses **Bun** for local test/dev commands.

### Source layout

```text
src/
  index.ts                 # thin pi extension entrypoint
  types/                   # internal config/state/message/provider contracts
  domain/                  # pure DCP logic: transcript, refs, compression, pruning, nudges, provider filtering
  application/             # pi hook/tool/command orchestration and host payload adaptation
  infrastructure/          # config loading, persistence migration, debug logging
  prompts/                 # system, nudge, and compress-tool prompt text
  *.ts                     # compatibility re-export shims for older local imports

tests/
  helpers/                 # shared test factories/utilities
  unit/                    # transcript, compression, pruning, nudge, provider-filter tests
  integration/             # applyPruning, compress-tool/debug end-to-end behavior coverage
```

Domain modules should stay pure: no pi API imports, no filesystem/config loading/debug logging side effects, and no application-layer dependencies. Boundary payload narrowing belongs in `src/application/`; durable state/config/message contracts live in `src/types/`.

Do not assume Bun-only runtime APIs such as `bun:ffi` are available inside the extension. If DCP ever needs a Rust performance core, keep the extension shell in TypeScript and integrate Rust via a long-lived sidecar process or a Node native addon.

## Contributors

[![complexthings](https://github.com/complexthings.png?size=50)](https://github.com/complexthings)
[![wassname](https://github.com/wassname.png?size=50)](https://github.com/wassname)

Full contributor list: https://github.com/complexthings/pi-dynamic-context-pruning/graphs/contributors
