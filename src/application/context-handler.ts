import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DcpConfig } from "../types/config.js";
import type { DcpMessage } from "../types/message.js";
import type { DcpState } from "../types/state.js";
import {
  CONTEXT_LIMIT_NUDGE_SOFT,
  CONTEXT_LIMIT_NUDGE_STRONG,
  ITERATION_NUDGE,
  TURN_NUDGE,
} from "../prompts/nudge.js";
import {
  applyPruning,
  finalizeMaterializedMessages,
  getNudgeType,
  injectNudge,
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

function appendReminderDetails(reminder: string, details: string): string {
  if (!details) return reminder;

  const closingTag = "";
  if (!reminder.includes(closingTag)) {
    return `${reminder}\n\n${details}`;
  }

  return reminder.replace(closingTag, `\n\n${details}\n${closingTag}`);
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

function selectNudgeText(nudgeType: NonNullable<ReturnType<typeof getNudgeType>>): string {
  if (nudgeType === "context-strong") return CONTEXT_LIMIT_NUDGE_STRONG;
  if (nudgeType === "context-soft") return CONTEXT_LIMIT_NUDGE_SOFT;
  if (nudgeType === "iteration") return ITERATION_NUDGE;
  return TURN_NUDGE;
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
        const injectedNudgeText = appendReminderDetails(
          selectNudgeText(nudgeType),
          planningHintText
        );

        injectNudge(prunedMessages, injectedNudgeText);
        state.lastNudgeTurn = state.currentTurn;

        appendDebugLog(config, "nudge_emitted", {
          ...buildSessionDebugPayload(ctx.sessionManager),
          nudgeType,
          nudgeMessage: injectedNudgeText,
          contextPercent,
          contextTokens: usage?.tokens ?? null,
          currentTurn: state.currentTurn,
          toolCallsSinceLastUser,
          planningHints,
        });
      }
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
    });

    return { messages: prunedMessages as any[] };
  });
}
