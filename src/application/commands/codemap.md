# src/application/commands/

## Responsibility

Registers the `/dcp` slash command with the pi extension host. Provides user-facing subcommands for inspecting and driving DCP state.

## Design

Single `registerCommands()` call exposes one top-level command with subcommands. No external state mutated — all reads flow from the passed `DcpState` and `DcpConfig` references.

## Command Surface (dcp-replay-v3)

| Subcommand | Handler               | Behavior                                                                 |
| ---------- | --------------------- | ------------------------------------------------------------------------ |
| `help`     | `handleHelp`          | Print HELP_TEXT to notification UI                                       |
| `context`  | `handleContext`       | Context-window %, tracked tools, pruned tools, block count, tokens saved |
| `stats`    | `handleStats`         | Session statistics: prune count, active/total blocks, tokens saved       |
| `compress` | `handleCompress`      | Wait for idle, send `dcp-compress-trigger` message to LLM                |
| `compact`  | `handleNativeCompact` | Wait for idle, call `triggerDcpNativeCompaction`                         |

Removed in f1-nuke-unused-commands (dcp-replay-v3): `handleDecompress`, `handleSweep`, `handleManual`.

Autocomplete list, `HELP_TEXT` string, and the `switch` dispatch all reflect the five active subcommands above.

## Flow

```
pi.registerCommand("dcp", { getArgumentCompletions, handler })
  └─ handler(args) → trim/split → switch(sub)
       ├─ "" / "help"  → handleHelp
       ├─ "context"     → handleContext(state)
       ├─ "stats"      → handleStats(state)
       ├─ "compress"   → handleCompress(pi, ctx)
       └─ "compact"    → handleNativeCompact(ctx, state)
```

## Integration

- Reads `DcpState` (toolCalls, prunedToolIds, compressionBlocks, tokensSaved, lifetimeTokensSavedRealized, totalPruneCount)
- Reads context window usage via `ctx.getContextUsage()`
- Sends `dcp-compress-trigger` custom message to the LLM
- Delegates native compaction to `../native-compaction.ts`
- Delegates displayed-token calculation to `../status.js`
