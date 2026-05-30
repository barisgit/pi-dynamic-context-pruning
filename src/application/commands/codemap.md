# src/application/commands/

## Responsibility

Registers the `/dcp` slash command with the pi extension host. Provides user-facing subcommands for inspecting and driving DCP state.

## Design

Single `registerCommands()` call exposes one top-level command with subcommands. No external state mutated — all reads flow from the passed `DcpState` and `DcpConfig` references.

## Command Surface

| Subcommand | Handler               | Behavior                                                                 |
| ---------- | --------------------- | ------------------------------------------------------------------------ |
| `help`     | `handleHelp`          | Print HELP_TEXT to notification UI                                       |
| `context`  | `handleContext`       | Context-window %, tracked tools, pruned tools, block count, tokens saved |
| `stats`    | `handleStats`         | Session statistics: prune count, active/total blocks, tokens saved       |
| `compact`  | `handleNativeCompact` | Wait for idle, call `triggerDcpNativeCompaction`                         |

Removed command paths: `handleDecompress`, `handleSweep`, `handleManual`, and `handleCompress`.

Autocomplete list, `HELP_TEXT` string, and the `switch` dispatch all reflect the four active subcommands above.

## Flow

```text
pi.registerCommand("dcp", { getArgumentCompletions, handler })
  └─ handler(args) → trim/split → switch(sub)
       ├─ "" / "help"  → handleHelp
       ├─ "context"     → handleContext(state)
       ├─ "stats"      → handleStats(state)
       └─ "compact"    → handleNativeCompact(ctx, state)
```

## Integration

- Reads `DcpState` (toolCalls, prunedToolIds, compressionBlocks, tokensSaved, lifetimeTokensSavedRealized, totalPruneCount)
- Reads context window usage via `ctx.getContextUsage()`
- Delegates native compaction to `../native-compaction.ts`
- Delegates displayed-token calculation to `../status.js`
