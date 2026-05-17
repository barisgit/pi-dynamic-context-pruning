// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compress tool registration
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CompressionBlock, DcpState } from "../../types/state.js";
import type { DcpConfig } from "../../types/config.js";
import { appendDebugLog, buildSessionDebugPayload } from "../../infrastructure/debug-log.js";
import { COMPRESS_RANGE_DESCRIPTION } from "../../prompts/index.js";
import {
  buildCompressionArtifactsForRange,
  buildCompressionPlanningHints,
  expandBlockPlaceholders,
  renderCompressionPlanningHints,
  resolveAnchorSourceKey,
  resolveAnchorTimestamp,
  resolveIdToSourceKey,
  resolveIdToTimestamp,
  resolveProtectedTailStartTimestamp,
  resolveSupersededBlockIdsForRange,
  validateCompressionRangeBoundaryIds,
} from "../../domain/compression/tooling.js";
import { renderCompressedBlockMessage } from "../../domain/compression/materialize.js";
import { exceedsMaxContextLimit } from "../../domain/pruning/index.js";
import { estimateMessageTokens, estimateTokens } from "../../domain/compression/range.js";
import { updateDcpStatus } from "../status.js";
import { queueDcpAutoNativeCompaction } from "../native-compaction.js";
import { buildTranscriptSnapshot } from "../../domain/transcript/index.js";

export type {
  CompressionCandidateRange,
  CompressionPlanningHints,
} from "../../domain/compression/tooling.js";
export {
  buildCompressionArtifactsForRange,
  buildCompressionPlanningHints,
  renderCompressionPlanningHints,
  resolveAnchorSourceKey,
  resolveAnchorTimestamp,
  resolveProtectedTailStartTimestamp,
  resolveSupersededBlockIdsForRange,
  validateCompressionRangeBoundaryIds,
} from "../../domain/compression/tooling.js";

function buildCurrentBranchMessages(ctx: any): any[] {
  const branchEntries = ctx.sessionManager.getBranch(ctx.sessionManager.getLeafId() ?? undefined);
  const messages: any[] = [];

  for (const entry of branchEntries) {
    if (entry?.type === "message" && entry.message) {
      messages.push(entry.message);
      continue;
    }

    if (entry?.type === "custom_message") {
      messages.push({
        role: "custom_message",
        content: entry.content,
        timestamp: Date.parse(entry.timestamp),
      });
      continue;
    }

    if (entry?.type === "branch_summary") {
      messages.push({
        role: "branch_summary",
        content: [{ type: "text", text: entry.summary }],
        timestamp: Date.parse(entry.timestamp),
      });
      continue;
    }

    if (entry?.type === "compaction") {
      messages.push({
        role: "compaction",
        content: [{ type: "text", text: entry.summary }],
        timestamp: Date.parse(entry.timestamp),
      });
    }
  }

  return messages;
}

function resolveEffectiveRangeTopic(
  range: { topic?: string },
  defaultTopic?: string
): string | null {
  const topic = range.topic ?? defaultTopic;
  const trimmedTopic = topic?.trim();
  return trimmedTopic && trimmedTopic.length > 0 ? trimmedTopic : null;
}

function formatTopicList(topics: string[]): string {
  const uniqueTopics = [...new Set(topics)];
  return uniqueTopics.length === 1 ? uniqueTopics[0] : uniqueTopics.join(", ");
}

function estimateBlockSavingsAtCreation(
  block: CompressionBlock,
  currentMessages: readonly any[]
): { removedTokenEstimate: number; addedTokenEstimate: number; netSavedTokenEstimate: number } {
  const coveredSourceKeys = block.metadata?.coveredSourceKeys;
  if (!coveredSourceKeys || coveredSourceKeys.length === 0) {
    return { removedTokenEstimate: 0, addedTokenEstimate: 0, netSavedTokenEstimate: 0 };
  }

  const covered = new Set(coveredSourceKeys);
  const snapshot = buildTranscriptSnapshot([...currentMessages]);
  const removedTokenEstimate = snapshot.sourceItems.reduce(
    (sum, item) => sum + (covered.has(item.key) ? estimateMessageTokens(item.message) : 0),
    0
  );
  const addedTokenEstimate = estimateMessageTokens(renderCompressedBlockMessage(block));

  return {
    removedTokenEstimate,
    addedTokenEstimate,
    netSavedTokenEstimate: Math.max(0, removedTokenEstimate - addedTokenEstimate),
  };
}

function buildBlockDebugMetrics(
  block: CompressionBlock,
  creationSavings?: {
    removedTokenEstimate: number;
    addedTokenEstimate: number;
    netSavedTokenEstimate: number;
  }
): Record<string, unknown> {
  const metadata = block.metadata;
  return {
    id: block.id,
    topic: block.topic,
    summaryCharCount: block.summary.length,
    summaryTokenEstimate: block.summaryTokenEstimate,
    savedTokenEstimate: block.savedTokenEstimate ?? 0,
    savedTokenEstimateScope: "current_render",
    creationRemovedTokenEstimate: creationSavings?.removedTokenEstimate,
    creationAddedTokenEstimate: creationSavings?.addedTokenEstimate,
    creationNetSavedTokenEstimate: creationSavings?.netSavedTokenEstimate,
    activityLogEntryCount: block.activityLog?.length ?? 0,
    coveredSourceKeyCount: metadata?.coveredSourceKeys.length ?? 0,
    coveredSpanKeyCount: metadata?.coveredSpanKeys.length ?? 0,
    coveredToolIdCount: metadata?.coveredToolIds.length ?? 0,
    fileReadStatCount: metadata?.fileReadStats.length ?? 0,
    fileWriteStatCount: metadata?.fileWriteStats.length ?? 0,
    commandStatCount: metadata?.commandStats.length ?? 0,
  };
}

// Passthrough entries are PI housekeeping (reminders, prior compaction
// summaries, branch summaries), not real LLM turns. Counting them against
// `autoTriggerMessageCount` makes the threshold fire much earlier than the
// config implies — e.g. a 347-message session with ~150 DCP reminders and
// prior compaction entries would trip a documented threshold of 500.
const NATIVE_COMPACTION_PASSTHROUGH_ROLES = new Set([
  "compaction",
  "branch_summary",
  "custom_message",
]);

function countLlmMessages(messages: readonly any[]): number {
  let count = 0;
  for (const message of messages) {
    const role = typeof message?.role === "string" ? message.role : "";
    if (NATIVE_COMPACTION_PASSTHROUGH_ROLES.has(role)) continue;
    count++;
  }
  return count;
}

function shouldAutoTriggerNativeCompaction(
  currentMessages: readonly any[],
  state: DcpState,
  config: DcpConfig,
  newBlockCount: number
): boolean {
  if (!config.nativeCompaction.enabled) return false;
  if (newBlockCount <= 0) return false;
  const minActiveBlockCount = Math.max(1, Math.floor(config.nativeCompaction.minActiveBlockCount));
  const activeBlockCount = state.compressionBlocks.filter((block) => block.active).length;
  if (activeBlockCount < minActiveBlockCount) return false;

  const autoTriggerMessageCount = Math.max(
    1,
    Math.floor(config.nativeCompaction.autoTriggerMessageCount)
  );
  return countLlmMessages(currentMessages) >= autoTriggerMessageCount;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCompressTool(pi: ExtensionAPI, state: DcpState, config: DcpConfig): void {
  pi.registerTool({
    name: "compress",
    label: "Compress Context",
    description: COMPRESS_RANGE_DESCRIPTION,
    promptSnippet: "Compress ranges of conversation into summaries to manage context",
    parameters: Type.Object({
      topic: Type.Optional(
        Type.String({
          description:
            "Optional default short label (3-5 words) used for ranges that omit ranges[].topic",
        })
      ),
      ranges: Type.Array(
        Type.Object({
          startId: Type.String({
            description: "Message ID marking start of range (e.g. m0001, b2)",
          }),
          endId: Type.String({
            description: "Message ID marking end of range (e.g. m0042, b5)",
          }),
          summary: Type.String({
            description: "Complete technical summary replacing all content in range",
          }),
          topic: Type.Optional(
            Type.String({
              description:
                "Short label (3-5 words) for this compressed block; falls back to top-level topic",
            })
          ),
        }),
        { description: "One or more ranges to compress; each range creates one compressed block" }
      ),
    }),

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const newBlockIds: number[] = [];
      const currentMessages = buildCurrentBranchMessages(ctx);
      const usage = ctx.getContextUsage();
      const contextPercent =
        usage && usage.tokens !== null ? usage.tokens / usage.contextWindow : null;
      const protectedTailStartTimestamp = resolveProtectedTailStartTimestamp(
        currentMessages,
        config.compress.protectRecentTurns
      );
      const planningHints = buildCompressionPlanningHints(
        currentMessages,
        state,
        config.compress.protectRecentTurns
      );
      const plannedBlocks: CompressionBlock[] = [];
      const pendingSupersededBlockIds = new Set<number>();
      const plannedTopics: string[] = [];
      let nextBlockId = state.nextBlockId;
      let activeRange: { startId: string; endId: string } | null = null;

      appendDebugLog(config, "compress_requested", {
        ...buildSessionDebugPayload(ctx.sessionManager),
        topic: params.topic,
        rangeCount: params.ranges.length,
        ranges: params.ranges.map((range) => ({
          startId: range.startId,
          endId: range.endId,
          topic: range.topic,
          effectiveTopic: resolveEffectiveRangeTopic(range, params.topic),
          summaryLength: range.summary.length,
        })),
        contextPercent,
        contextTokens: usage?.tokens ?? null,
        planningHints,
      });

      try {
        for (const range of params.ranges) {
          const { startId, endId, summary } = range;
          const blockTopic = resolveEffectiveRangeTopic(range, params.topic);
          activeRange = { startId, endId };

          if (!blockTopic) {
            throw new Error(
              `Compression range ${startId}..${endId} requires a non-empty topic. ` +
                `Provide ranges[].topic for this block or a top-level topic default.`
            );
          }

          validateCompressionRangeBoundaryIds(startId, endId, state);

          const startTimestamp = resolveIdToTimestamp(startId, "startTimestamp", state);
          const endTimestamp = resolveIdToTimestamp(endId, "endTimestamp", state);

          if (startTimestamp > endTimestamp) {
            throw new Error(
              `Range start "${startId}" must appear before end "${endId}" in the conversation`
            );
          }

          if (!Number.isFinite(startTimestamp)) {
            throw new Error(
              `Start ID "${startId}" resolved to a non-finite timestamp (${startTimestamp}). ` +
                `This usually means the referenced message has a corrupted timestamp.`
            );
          }
          if (!Number.isFinite(endTimestamp)) {
            throw new Error(
              `End ID "${endId}" resolved to a non-finite timestamp (${endTimestamp}). ` +
                `This usually means the referenced message has a corrupted timestamp.`
            );
          }

          const touchesProtectedTail =
            protectedTailStartTimestamp !== null && endTimestamp >= protectedTailStartTimestamp;
          const emergencyOverride =
            contextPercent !== null &&
            exceedsMaxContextLimit(contextPercent, config, usage?.tokens ?? null);

          if (touchesProtectedTail && !emergencyOverride) {
            const planningHintText = renderCompressionPlanningHints(planningHints, {
              includeTailStart: false,
              includeProtectedIdList: true,
            });
            throw new Error(
              `Compression ranges may not end inside the recent protected tail. ` +
                `This tail starts at ${planningHints.protectedTailStartId ?? "the protected hot-tail boundary"} and protects the last ` +
                `${config.compress.protectRecentTurns} logical turns/tool batches.` +
                `${planningHintText ? `\n\n${planningHintText}` : ""}` +
                `\n\nChoose an older range or wait for a hard context emergency.`
            );
          }

          const anchorTimestamp = resolveAnchorTimestamp(endTimestamp, state);
          const boundaryStartSourceKey = resolveIdToSourceKey(startId, state, "startSourceKey");
          const boundaryEndSourceKey = resolveIdToSourceKey(endId, state, "endSourceKey");
          const expandedSummary = expandBlockPlaceholders(summary, state);
          const artifacts = buildCompressionArtifactsForRange(
            currentMessages,
            state,
            startTimestamp,
            endTimestamp
          );
          const expandedStartSourceKey =
            artifacts.metadata.coveredSourceKeys[0] ?? boundaryStartSourceKey;
          const expandedEndSourceKey =
            artifacts.metadata.coveredSourceKeys.at(-1) ?? boundaryEndSourceKey;
          const anchorSourceKey = resolveAnchorSourceKey(
            endTimestamp,
            expandedEndSourceKey ?? null,
            state
          );
          const supersededBlockIds = resolveSupersededBlockIdsForRange(
            currentMessages,
            [...state.compressionBlocks, ...plannedBlocks],
            startTimestamp,
            endTimestamp,
            artifacts.metadata.coveredSourceKeys,
            startId,
            endId,
            pendingSupersededBlockIds
          );
          for (const blockId of supersededBlockIds) {
            pendingSupersededBlockIds.add(blockId);
          }
          artifacts.metadata.supersededBlockIds = supersededBlockIds;

          const block: CompressionBlock = {
            id: nextBlockId++,
            topic: blockTopic,
            summary: expandedSummary,
            startTimestamp,
            endTimestamp,
            anchorTimestamp,
            startSourceKey: expandedStartSourceKey,
            endSourceKey: expandedEndSourceKey,
            anchorSourceKey,
            active: true,
            summaryTokenEstimate: estimateTokens(expandedSummary),
            savedTokenEstimate: 0,
            createdAt: Date.now(),
            compressCallId: toolCallId,
            activityLogVersion: artifacts.activityLogVersion,
            activityLog: artifacts.activityLog,
            metadata: artifacts.metadata,
          };

          plannedBlocks.push(block);
          newBlockIds.push(block.id);
          plannedTopics.push(blockTopic);
        }

        if (plannedBlocks.length > 0) {
          state.nextBlockId = nextBlockId;
          for (const existing of state.compressionBlocks) {
            if (pendingSupersededBlockIds.has(existing.id)) {
              existing.active = false;
            }
          }
          state.compressionBlocks.push(...plannedBlocks);
          state.lastCompressTurn = state.currentTurn;
          state.lastNudgeTurn = state.currentTurn;
        }

        if (config.pruneNotification !== "off") {
          const count = params.ranges.length;
          const rangeWord = count === 1 ? "range" : "ranges";

          if (config.pruneNotification === "detailed") {
            const totalTokens = newBlockIds.reduce((sum, id) => {
              const b = state.compressionBlocks.find((block) => block.id === id);
              return sum + (b?.summaryTokenEstimate ?? 0);
            }, 0);
            ctx.ui.notify(
              `Compressed: ${formatTopicList(plannedTopics)} (${count} ${rangeWord}, ~${totalTokens} tokens in summaries)`,
              "info"
            );
          } else {
            ctx.ui.notify(`Compressed: ${formatTopicList(plannedTopics)}`, "info");
          }
        }

        const creationSavingsByBlockId = new Map(
          plannedBlocks.map((block) => [
            block.id,
            estimateBlockSavingsAtCreation(block, currentMessages),
          ])
        );
        for (const block of plannedBlocks) {
          block.savedTokenEstimate =
            creationSavingsByBlockId.get(block.id)?.netSavedTokenEstimate ?? 0;
        }
        state.tokensSaved = state.compressionBlocks
          .filter((block) => block.active)
          .reduce((sum, block) => sum + (block.savedTokenEstimate ?? 0), 0);
        updateDcpStatus(ctx, state);

        const nativeCompactionRequested = shouldAutoTriggerNativeCompaction(
          currentMessages,
          state,
          config,
          plannedBlocks.length
        );
        if (nativeCompactionRequested) {
          queueDcpAutoNativeCompaction(state, newBlockIds);
          if (ctx.hasUI) {
            ctx.ui.notify("DCP native compaction will run at the end of this turn", "info");
          }
        }

        // Recompute planning hints against the post-compress state so the
        // returned tool message tells the agent what's still safe to compress
        // without waiting for the next context-pass nudge. O(N) over the
        // current transcript; cheap relative to compress itself.
        const postCompressHints = buildCompressionPlanningHints(
          currentMessages,
          state,
          config.compress.protectRecentTurns
        );
        const postCompressHintsText = renderCompressionPlanningHints(postCompressHints, {
          includeTailStart: false,
        });

        appendDebugLog(config, "compress_succeeded", {
          ...buildSessionDebugPayload(ctx.sessionManager),
          topic: params.topic,
          topics: plannedTopics,
          blockIds: newBlockIds,
          blocks: plannedBlocks.map((block) =>
            buildBlockDebugMetrics(block, creationSavingsByBlockId.get(block.id))
          ),
          totalCreationNetSavedTokenEstimate: plannedBlocks.reduce(
            (sum, block) =>
              sum + (creationSavingsByBlockId.get(block.id)?.netSavedTokenEstimate ?? 0),
            0
          ),
          activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active)
            .length,
          tokensSavedAfter: state.tokensSaved,
          supersededBlockIds: Array.from(pendingSupersededBlockIds),
          nativeCompactionRequested,
          planningHints,
          postCompressHints,
          contextPercent,
        });

        const headerLine = `Compressed ${params.ranges.length} range(s): ${formatTopicList(plannedTopics)}`;
        const followUpLine =
          postCompressHints.candidateRanges.length > 0
            ? "If still over the cleanup target, you can compress one of these now:"
            : "No additional safe ranges remain right now.";
        const responseText = [headerLine, followUpLine, postCompressHintsText]
          .filter((segment) => segment && segment.trim().length > 0)
          .join("\n\n");

        return {
          content: [{ type: "text", text: responseText }],
          details: {
            blockIds: newBlockIds,
            topic: params.topic,
            topics: plannedTopics,
            blocks: newBlockIds.map((id, index) => ({ id, topic: plannedTopics[index] })),
            nativeCompactionRequested,
            postCompressHints,
          },
        };
      } catch (error) {
        appendDebugLog(config, "compress_failed", {
          ...buildSessionDebugPayload(ctx.sessionManager),
          topic: params.topic,
          topics: plannedTopics,
          activeRange,
          contextPercent,
          contextTokens: usage?.tokens ?? null,
          planningHints,
          error,
        });
        throw error;
      }
    },
  });
}
