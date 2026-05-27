import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { DcpState } from "../../types/state.js";
import type { DcpConfig } from "../../types/config.js";
import { computeDisplayedTokensSaved, updateDcpStatus } from "../status.js";
import { triggerDcpNativeCompaction } from "../native-compaction.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP_TEXT = `DCP — Dynamic Context Pruning

Commands:
  /dcp context      — Show context window usage breakdown
  /dcp stats        — Show pruning statistics for this session
  /dcp compress     — Trigger compression (sends compress tool invocation to LLM)
  /dcp compact      — Materialize active DCP blocks into pi-native compaction`;

function handleHelp(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(HELP_TEXT, "info");
}

// ---------------------------------------------------------------------------
// Context usage
// ---------------------------------------------------------------------------

function handleContext(ctx: ExtensionCommandContext, state: DcpState): void {
  const usage = ctx.getContextUsage();

  const lines: string[] = [];

  if (usage) {
    if (usage.tokens !== null) {
      const pct = ((usage.tokens / usage.contextWindow) * 100).toFixed(1);
      lines.push(
        `Context Usage: ${pct}% (${fmt(usage.tokens)} / ${fmt(usage.contextWindow)} tokens)`
      );
    } else {
      lines.push(`Context Usage: unknown / ${fmt(usage.contextWindow)} tokens`);
    }
  } else {
    lines.push("Context Usage: unavailable");
  }

  lines.push("");
  lines.push("Session Stats:");
  lines.push(`  Tool calls tracked: ${fmt(state.toolCalls.size)}`);
  lines.push(`  Pruned tools: ${fmt(state.prunedToolIds.size)}`);
  lines.push(`  Compression blocks: ${state.compressionBlocks.filter((b) => b.active).length}`);
  appendTokensSavedLines(lines, state, "  ");

  ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Append "Tokens saved" lines with a breakdown when both active-block and
 * realized-by-compaction estimates contribute.
 */
function appendTokensSavedLines(lines: string[], state: DcpState, indent: string): void {
  const displayed = computeDisplayedTokensSaved(state);
  const realized = Math.max(0, state.lifetimeTokensSavedRealized ?? 0);
  const active = Math.max(0, state.tokensSaved);
  lines.push(`${indent}Tokens saved (estimated): ${fmt(displayed)}`);
  if (realized > 0 && active > 0) {
    lines.push(`${indent}  Active blocks: ${fmt(active)}`);
    lines.push(`${indent}  Realized by compaction: ${fmt(realized)}`);
  } else if (realized > 0) {
    lines.push(`${indent}  Realized by compaction: ${fmt(realized)}`);
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function handleStats(ctx: ExtensionCommandContext, state: DcpState): void {
  const activeBlocks = state.compressionBlocks.filter((b) => b.active).length;
  const totalBlocks = state.compressionBlocks.length;

  const lines: string[] = [];
  lines.push("DCP Session Statistics:");
  appendTokensSavedLines(lines, state, "  ");
  lines.push(`  Total pruning operations: ${fmt(state.totalPruneCount)}`);
  lines.push(`  Compression blocks active: ${activeBlocks} / ${totalBlocks} total`);

  ctx.ui.notify(lines.join("\n"), "info");
}

// ---------------------------------------------------------------------------
// Compress (trigger)
// ---------------------------------------------------------------------------

async function handleCompress(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();

  pi.sendMessage(
    {
      customType: "dcp-compress-trigger",
      content: "Please compress stale conversation sections using the compress tool now.",
      display: false,
    },
    { triggerTurn: true, deliverAs: "followUp" }
  );

  ctx.ui.notify("Triggered compression", "info");
}

async function handleNativeCompact(ctx: ExtensionCommandContext, state: DcpState): Promise<void> {
  await ctx.waitForIdle();
  await triggerDcpNativeCompaction(ctx, state, "command");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerCommands(pi: ExtensionAPI, state: DcpState, _config: DcpConfig): void {
  pi.registerCommand("dcp", {
    description: "Dynamic Context Pruning — manage context window usage",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const subcommands: AutocompleteItem[] = [
        { value: "context", label: "context", description: "Show context window usage breakdown" },
        { value: "stats", label: "stats", description: "Show pruning statistics" },
        { value: "compress", label: "compress", description: "Trigger LLM compression" },
        {
          value: "compact",
          label: "compact",
          description: "Materialize DCP blocks into pi compaction",
        },
        { value: "help", label: "help", description: "Show help" },
      ];
      const matched = subcommands
        .filter((s) => typeof s.value === "string")
        .filter((s) => s.value.startsWith(prefix));
      return matched.length > 0 ? matched : null;
    },

    async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "";

      switch (sub) {
        case "":
        case "help":
          handleHelp(ctx);
          break;

        case "context":
          handleContext(ctx, state);
          break;

        case "stats":
          handleStats(ctx, state);
          break;

        case "compress":
          await handleCompress(pi, ctx);
          break;

        case "compact":
          await handleNativeCompact(ctx, state);
          break;

        default:
          ctx.ui.notify(
            `Unknown DCP command: "${sub}". Run /dcp help for available commands.`,
            "error"
          );
          break;
      }
    },
  });
}
