import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { REMINDER_UPSERT_EVENT } from "pi-reminders/src/types.js";
import type { ReminderIntent } from "pi-reminders/src/types.js";
import type { DcpConfig } from "../types/config.js";
import type { DcpMessage } from "../types/message.js";
import type { DcpState } from "../types/state.js";
import {
  applyPruning,
  exceedsMaxContextLimit,
  getNudgeType,
  resolveEffectiveContextSize,
} from "../domain/pruning/index.js";
import { estimateMessageTokens } from "../domain/tokens/estimate.js";
import {
  buildCompressionPlanningHints,
  renderCompressionPlanningHints,
} from "../domain/compression/tooling.js";
import { buildLiveOwnerKeys } from "../domain/transcript/index.js";
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.js";
import { updateDcpStatus } from "./status.js";

function cloneRenderedMessages(messages: DcpMessage[]): DcpMessage[] {
  return messages.map((message) => {
    const clone = { ...message };
    if (Array.isArray(clone.content)) {
      clone.content = clone.content.map((part: any) =>
        typeof part === "object" && part !== null ? { ...part } : part
      );
    }
    return clone;
  });
}

type NudgeType = NonNullable<ReturnType<typeof getNudgeType>>;

function buildCompactReminderText(
  details: string,
  nudgeType: NudgeType,
  config: DcpConfig,
  contextPercent: number,
  contextTokens?: number | null
): string {
  const header = buildNudgeHeader(nudgeType, config, contextPercent, contextTokens);
  const trimmedDetails = details.trim();
  return [header, trimmedDetails].filter(Boolean).join("\n");
}

function buildNudgeHeader(
  nudgeType: NudgeType,
  config: DcpConfig,
  contextPercent: number,
  contextTokens?: number | null
): string {
  const overCleanupTarget = exceedsMaxContextLimit(contextPercent, config, contextTokens);
  const targetText = formatCleanupTarget(config);

  if (overCleanupTarget || nudgeType === "context-strong") {
    return `Compress now: over DCP cleanup target${targetText}. Compress every eligible stretch below — not just the biggest. The list is a suggestion: you may also re-compress across existing \`bN\` blocks (merging or rewriting prior summaries) when that better serves the live task. \`bN\` summaries stay citable; carrying closed work raw degrades retrieval.`;
  }

  if (nudgeType === "iteration") {
    return `DCP checkpoint${targetText}. After a long tool run, compress every eligible stretch below — not just the biggest. The list is a suggestion: you may also re-compress across existing \`bN\` blocks when that better serves the live task. \`bN\` summaries stay citable; carrying closed work raw degrades retrieval.`;
  }

  return `DCP checkpoint${targetText}. Compress every eligible stretch below — not just the biggest. The list is a suggestion: you may also re-compress across existing \`bN\` blocks when that better serves the live task. \`bN\` summaries stay citable; carrying closed work raw degrades retrieval.`;
}

function formatCleanupTarget(config: DcpConfig): string {
  const minTokens = config.compress.minContextTokens;
  const maxTokens = config.compress.maxContextTokens;
  if (typeof minTokens === "number" && typeof maxTokens === "number") {
    return ` (${formatTokenCount(minTokens)}-${formatTokenCount(maxTokens)} tokens)`;
  }
  if (typeof maxTokens === "number") return ` (${formatTokenCount(maxTokens)} tokens)`;
  if (typeof minTokens === "number")
    return ` (starts around ${formatTokenCount(minTokens)} tokens)`;
  return "";
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimFixed(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimFixed(tokens / 1_000)}k`;
  return String(tokens);
}

function trimFixed(value: number): string {
  return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
}

function countToolCallsSinceLastUser(messages: DcpMessage[]): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") break;
    if (message?.role === "toolResult" || message?.role === "bashExecution") {
      count++;
    }
  }
  return count;
}

function nudgePriority(nudgeType: NudgeType): number {
  if (nudgeType === "context-strong") return 100;
  if (nudgeType === "context-soft") return 80;
  if (nudgeType === "iteration") return 60;
  return 40;
}

export type NudgeDecisionReason =
  | "emitted"
  | "no_context_usage"
  | "below_min_threshold"
  | "same_turn_or_post_compress_debounce"
  | "turn_debounce"
  | "not_evaluated";

function reachesMinNudgeThreshold(
  contextPercent: number,
  config: DcpConfig,
  contextTokens?: number | null
): boolean {
  if (contextPercent >= config.compress.minContextPercent) return true;
  const minTokens = config.compress.minContextTokens;
  return typeof minTokens === "number" && contextTokens !== null && contextTokens !== undefined
    ? contextTokens >= minTokens
    : false;
}

export function getNudgeDecisionReason(
  contextPercent: number | null,
  state: DcpState,
  config: DcpConfig,
  nudgeType: ReturnType<typeof getNudgeType>,
  contextTokens?: number | null
): NudgeDecisionReason {
  if (contextPercent === null) return "no_context_usage";
  if (nudgeType) return "emitted";
  if (!reachesMinNudgeThreshold(contextPercent, config, contextTokens)) {
    return "below_min_threshold";
  }
  if (state.currentTurn <= state.lastCompressTurn) {
    return "same_turn_or_post_compress_debounce";
  }

  const debounceTurns = Math.max(1, config.compress.nudgeDebounceTurns);
  if (state.lastNudgeTurn >= 0 && state.currentTurn - state.lastNudgeTurn < debounceTurns) {
    return state.lastCompressTurn >= state.lastNudgeTurn
      ? "same_turn_or_post_compress_debounce"
      : "turn_debounce";
  }

  return "not_evaluated";
}

interface ContextMaterializationResult {
  messages: DcpMessage[];
  liveOwnerKeys: Set<string>;
  mode: "v1";
}

export function materializeContextMessages(
  messages: DcpMessage[],
  state: DcpState,
  config: DcpConfig
): ContextMaterializationResult {
  const liveOwnerKeys = buildLiveOwnerKeys(messages, state.compressionBlocks);
  return {
    messages: applyPruning(messages, state, config),
    liveOwnerKeys,
    mode: "v1",
  };
}

/** Register the context pass handler that applies pruning and DCP nudges. */
export function registerContextHandler(pi: ExtensionAPI, state: DcpState, config: DcpConfig): void {
  pi.on("context", async (event, ctx) => {
    const materializedContext = materializeContextMessages(
      event.messages as DcpMessage[],
      state,
      config
    );
    const liveOwnerKeys = materializedContext.liveOwnerKeys;
    const prunedMessages = materializedContext.messages;
    const usage = ctx.getContextUsage();
    const dcpEstimatedTokens = prunedMessages.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0
    );
    const { effectiveTokens, effectivePercent } = resolveEffectiveContextSize(
      usage?.tokens ?? null,
      dcpEstimatedTokens,
      usage?.contextWindow ?? null
    );
    const contextPercent = effectivePercent;
    let toolCallsSinceLastUser: number | null = null;
    let nudgeType: ReturnType<typeof getNudgeType> = null;
    let nudgeDecisionReason: NudgeDecisionReason = "not_evaluated";

    if (contextPercent !== null) {
      toolCallsSinceLastUser = countToolCallsSinceLastUser(prunedMessages);
      nudgeType = getNudgeType(
        contextPercent,
        state,
        config,
        toolCallsSinceLastUser,
        effectiveTokens
      );

      if (nudgeType) {
        const planningHints = buildCompressionPlanningHints(
          event.messages,
          state,
          config.compress.protectRecentTurns
        );
        const planningHintText = renderCompressionPlanningHints(planningHints);
        const injectedNudgeText = buildCompactReminderText(
          planningHintText,
          nudgeType,
          config,
          contextPercent,
          effectiveTokens
        );

        const reminder: ReminderIntent = {
          source: "dcp",
          id: "nudge",
          label: "DCP",
          ttl: "once",
          priority: nudgePriority(nudgeType),
          display: true,
          text: injectedNudgeText,
          metadata: {
            nudgeType,
            contextPercent,
            contextTokens: effectiveTokens,
            currentTurn: state.currentTurn,
            toolCallsSinceLastUser,
          },
        };

        (pi.events as any).emit(REMINDER_UPSERT_EVENT, reminder);
        state.lastNudgeTurn = state.currentTurn;
        nudgeDecisionReason = "emitted";

        appendDebugLog(config, "nudge_emitted", {
          ...buildSessionDebugPayload(ctx.sessionManager),
          nudgeType,
          nudgeDecisionReason,
          nudgeMessage: injectedNudgeText,
          contextPercent,
          contextTokens: effectiveTokens,
          currentTurn: state.currentTurn,
          toolCallsSinceLastUser,
          planningHints,
        });
      }
    }

    if (!nudgeType) {
      nudgeDecisionReason = getNudgeDecisionReason(
        contextPercent,
        state,
        config,
        nudgeType,
        effectiveTokens
      );
    }

    state.lastRenderedMessages = cloneRenderedMessages(prunedMessages);
    state.lastLiveOwnerKeys = Array.from(liveOwnerKeys);
    // Stash DCP's own estimate of the rendered transcript so the compress
    // tool can gate its emergency override on effective context size
    // (max host, DCP estimate) without re-running the state-mutating
    // applyPruning pass at tool-call time.
    state.lastDcpEstimatedTokens = dcpEstimatedTokens;
    updateDcpStatus(ctx, state);

    appendDebugLog(config, "context_evaluated", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      contextTokens: usage?.tokens ?? null,
      dcpEstimatedTokens,
      effectiveContextTokens: effectiveTokens,
      contextWindow: usage?.contextWindow ?? null,
      contextPercent,
      currentTurn: state.currentTurn,
      sourceMessageCount: event.messages.length,
      renderedMessageCount: prunedMessages.length,
      liveOwnerCount: liveOwnerKeys.size,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      contextMaterializationMode: materializedContext.mode,
      tokensSaved: state.tokensSaved,
      totalPruneCount: state.totalPruneCount,
      toolCallsSinceLastUser,
      nudgeType,
      nudgeDecisionReason,
    });

    return { messages: prunedMessages as any[] };
  });
}
