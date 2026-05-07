import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { REMINDER_UPSERT_EVENT } from "pi-reminders/src/types.js";
import type { ReminderIntent } from "pi-reminders/src/types.js";
import type { DcpConfig } from "../types/config.js";
import type { DcpMessage } from "../types/message.js";
import type { DcpState } from "../types/state.js";
import {
  applyPruning,
  exceedsMaxContextLimit,
  finalizeMaterializedMessages,
  getNudgeType,
} from "../domain/pruning/index.js";
import { materializeTranscript } from "../domain/compression/materialize.js";
import {
  buildCompressionPlanningHints,
  renderCompressionPlanningHints,
} from "../domain/compression/tooling.js";
import { buildLiveOwnerKeys, buildTranscriptSnapshot } from "../domain/transcript/index.js";
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
    return `Compress now: you crossed the user's DCP cleanup target${targetText}. Prefer the largest safe older range below unless you need it immediately.`;
  }

  if (nudgeType === "iteration") {
    return `Routine DCP checkpoint${targetText}: after a long tool run, compress a finished older slice if one is stale.`;
  }

  return `Routine DCP checkpoint${targetText}: if an older slice is finished, compress it; keep the active working slice raw.`;
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
  | "manual_mode"
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
  if (state.manualMode) return "manual_mode";
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
  mode: "v1" | "v2";
  renderedV2BlockIds: number[];
}

function hasActiveV2Blocks(state: DcpState): boolean {
  return state.compressionBlocksV2.some((block) => block.status === "active");
}

export function materializeContextMessages(
  messages: DcpMessage[],
  state: DcpState,
  config: DcpConfig
): ContextMaterializationResult {
  if (state.schemaVersion === 2 && hasActiveV2Blocks(state)) {
    const snapshot = buildTranscriptSnapshot(messages);
    const materialized = materializeTranscript(snapshot, state.compressionBlocksV2, {
      renderFullBlockCount: config.compress.renderFullBlockCount,
      renderCompactBlockCount: config.compress.renderCompactBlockCount,
    });
    const finalizedMessages = finalizeMaterializedMessages(materialized.messages, state, config, {
      turnMessages: messages,
      messageOwnerKeys: materialized.messageOwnerKeys,
      messageSourceKeys: materialized.messageSourceKeys,
    });

    return {
      messages: finalizedMessages,
      liveOwnerKeys: new Set(state.messageOwnerSnapshot.values()),
      mode: "v2",
      renderedV2BlockIds: materialized.renderedBlockIds,
    };
  }

  const liveOwnerKeys = buildLiveOwnerKeys(messages, state.compressionBlocks);
  return {
    messages: applyPruning(messages, state, config),
    liveOwnerKeys,
    mode: "v1",
    renderedV2BlockIds: [],
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
    const contextPercent =
      usage && usage.tokens !== null ? usage.tokens / usage.contextWindow : null;
    let toolCallsSinceLastUser: number | null = null;
    let nudgeType: ReturnType<typeof getNudgeType> = null;
    let nudgeDecisionReason: NudgeDecisionReason = "not_evaluated";

    if (contextPercent !== null && !state.manualMode) {
      toolCallsSinceLastUser = countToolCallsSinceLastUser(prunedMessages);
      nudgeType = getNudgeType(
        contextPercent,
        state,
        config,
        toolCallsSinceLastUser,
        usage?.tokens ?? null
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
          usage?.tokens ?? null
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
            contextTokens: usage?.tokens ?? null,
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
          contextTokens: usage?.tokens ?? null,
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
        usage?.tokens ?? null
      );
    }

    state.lastRenderedMessages = cloneRenderedMessages(prunedMessages);
    state.lastLiveOwnerKeys = Array.from(liveOwnerKeys);
    updateDcpStatus(ctx, state);

    appendDebugLog(config, "context_evaluated", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? null,
      contextPercent,
      currentTurn: state.currentTurn,
      manualMode: state.manualMode,
      sourceMessageCount: event.messages.length,
      renderedMessageCount: prunedMessages.length,
      liveOwnerCount: liveOwnerKeys.size,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      activeCompressionBlockV2Count: state.compressionBlocksV2.filter(
        (block) => block.status === "active"
      ).length,
      contextMaterializationMode: materializedContext.mode,
      renderedV2BlockIds: materializedContext.renderedV2BlockIds,
      tokensSaved: state.tokensSaved,
      totalPruneCount: state.totalPruneCount,
      toolCallsSinceLastUser,
      nudgeType,
      nudgeDecisionReason,
    });

    return { messages: prunedMessages as any[] };
  });
}
