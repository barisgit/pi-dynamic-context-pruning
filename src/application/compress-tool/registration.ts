// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compress tool registration
// ---------------------------------------------------------------------------

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompressionBlock, DcpState } from "../../types/state.js";
import type { DcpConfig } from "../../types/config.js";
import { appendDebugLog, buildSessionDebugPayload } from "../../infrastructure/debug-log.js";
import { COMPRESS_RANGE_DESCRIPTION } from "../../prompts/index.js";
import {
  buildCompressionArtifactsForRange,
  buildCompressionPlanningHints,
  expandCoveredBlockPlaceholders,
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
import { exceedsMaxContextLimit, resolveEffectiveContextSize } from "../../domain/pruning/index.js";
import { estimateMessageTokens, estimateTokens } from "../../domain/compression/range.js";
import { updateDcpStatus } from "../status.js";
import { saveState } from "../session-handler.js";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { buildTranscriptSnapshot } from "../../domain/transcript/index.js";
import { getProjectedSourceEntryIds } from "../compaction-state.js";

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

function buildCurrentBranchMessages(ctx: any): {
  messages: any[];
  entryIdsByKey: Map<string, string>;
} {
  const branch = ctx.sessionManager.getBranch();
  // getBranch is already a linear path; normalize entry links for partial host fixtures.
  const entries = branch.map((entry: any, index: number) => ({
    ...entry,
    id: entry.id ?? `entry-${index}`,
    parentId: index ? (branch[index - 1].id ?? `entry-${index - 1}`) : null,
  }));
  const projection = buildSessionProjection(entries);
  const entryIds = getProjectedSourceEntryIds(projection);
  const keys = buildTranscriptSnapshot(projection.messages as any[]).sourceItems;
  return {
    messages: projection.messages,
    entryIdsByKey: branch.every((entry: any) => typeof entry.id === "string")
      ? new Map(keys.map((item, index) => [item.key, entryIds[index]]))
      : new Map(),
  };
}

function resolveEffectiveRangeTopic(range: { topic?: string }, defaultTopic?: string): string {
  const topic = range.topic ?? defaultTopic;
  const trimmedTopic = topic?.trim();
  return trimmedTopic && trimmedTopic.length > 0 ? trimmedTopic : "Compressed history";
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
    conversationEntryCount: block.activityLog?.length ?? 0,
    coveredSourceKeyCount: metadata?.coveredSourceKeys.length ?? 0,
    coveredSpanKeyCount: metadata?.coveredSpanKeys.length ?? 0,
    coveredToolIdCount: metadata?.coveredToolIds.length ?? 0,
    fileReadStatCount: metadata?.fileReadStats.length ?? 0,
    fileWriteStatCount: metadata?.fileWriteStats.length ?? 0,
    commandEffectCount: metadata?.effectStats?.commands ?? metadata?.commandStats.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCompressTool(pi: ExtensionAPI, state: DcpState, config: DcpConfig): void {
  pi.registerTool({
    name: "compress",
    label: "Compress Context",
    description: COMPRESS_RANGE_DESCRIPTION,
    promptSnippet: "Preserve settled work, restrictions, and evidence in historical summaries",
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
            description:
              "Visible boundary marking start of range (e.g. non-assistant message m0001, or b2). Assistant turns are selected via surrounding user/toolResult/bashExecution IDs.",
          }),
          endId: Type.String({
            description:
              "Visible boundary marking end of range (e.g. non-assistant message m0042, or b5). Assistant turns are selected via surrounding user/toolResult/bashExecution IDs.",
          }),
          summary: Type.String({
            description: "Historical record of this stretch; follow the summary guidance above.",
          }),
          topic: Type.Optional(
            Type.String({
              description:
                "Short label (3-5 words) for this compressed block; falls back to top-level topic",
            })
          ),
        }),
        { description: "Nonempty ranges to compress", minItems: 1 }
      ),
    }),

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const ranges = params.ranges ?? [];
      if (ranges.length === 0) throw new Error("Provide at least one range.");
      const newBlockIds: number[] = [];
      const { messages: currentMessages, entryIdsByKey } = buildCurrentBranchMessages(ctx);
      const usage = ctx.getContextUsage();
      // Gate the protected-tail emergency override on effective context size =
      // max(host tokens, DCP's last rendered-transcript estimate), mirroring the
      // nudge gate. A host figure that under-reports after resume must not
      // silently suppress an emergency compression. The DCP estimate is read
      // from the latest `context` pass (state.lastDcpEstimatedTokens) rather
      // than recomputed here, because the estimating pass (applyPruning)
      // mutates state and must not run at tool-call time.
      const { effectiveTokens: effectiveContextTokens, effectivePercent: effectiveContextPercent } =
        resolveEffectiveContextSize(
          usage?.tokens ?? null,
          state.lastDcpEstimatedTokens,
          usage?.contextWindow ?? null
        );
      const contextPercent = effectiveContextPercent;
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
        rangeCount: ranges.length,
        ranges: ranges.map((range) => ({
          startId: range.startId,
          endId: range.endId,
          topic: range.topic,
          effectiveTopic: resolveEffectiveRangeTopic(range, params.topic),
          summaryLength: range.summary.length,
        })),
        contextPercent,
        contextTokens: usage?.tokens ?? null,
        effectiveContextTokens,
        dcpEstimatedTokens: state.lastDcpEstimatedTokens,
        planningHints,
      });

      try {
        for (const range of ranges) {
          const { startId, endId, summary } = range;
          const blockTopic = resolveEffectiveRangeTopic(range, params.topic);
          activeRange = { startId, endId };

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
            exceedsMaxContextLimit(contextPercent, config, effectiveContextTokens);

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
          const artifacts = buildCompressionArtifactsForRange(
            currentMessages,
            state,
            startTimestamp,
            endTimestamp
          );
          const provenance = artifacts.metadata.coveredSourceKeys.map((key) =>
            entryIdsByKey.get(key)
          );
          if (provenance.every((id): id is string => typeof id === "string")) {
            artifacts.metadata.coveredSourceEntryIds = provenance;
          }
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
            pendingSupersededBlockIds,
            state
          );
          for (const blockId of supersededBlockIds) {
            pendingSupersededBlockIds.add(blockId);
          }
          artifacts.metadata.supersededBlockIds = supersededBlockIds;
          // The authored summary replaces covered records. Explicit historical
          // quotations remain possible, but only for blocks this range retires.
          const expandedSummary = expandCoveredBlockPlaceholders(
            summary,
            state,
            supersededBlockIds
          );

          const block: CompressionBlock = {
            id: nextBlockId++,
            topic: blockTopic,
            summary: expandedSummary,
            startId,
            endId,
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
          for (const existing of [...state.compressionBlocks, ...plannedBlocks]) {
            if (pendingSupersededBlockIds.has(existing.id)) {
              existing.active = false;
            }
          }
          state.compressionBlocks.push(...plannedBlocks);
          state.lastCompressTurn = state.currentTurn;
          state.lastNudgeTurn = state.currentTurn;
          state.pendingSave = true;
        }

        if (plannedBlocks.length > 0 && config.pruneNotification !== "off") {
          const count = ranges.length;
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

        // Flush the new block(s) to disk immediately, mirroring native
        // compaction. `compress` runs deep inside an autonomous loop where
        // `agent_end` (the deferred flush) may not fire for many minutes; if pi
        // emits a mid-run `session_start` before then, restore would find no
        // persisted snapshot. Persisting here — after block savings/`tokensSaved`
        // accounting is finalized above — means the snapshot is complete and the
        // block survives a mid-run restore. No-op when nothing was created
        // (`pendingSave` stays false).
        if (plannedBlocks.length > 0) {
          saveState(pi, state, config, "compress", buildSessionDebugPayload(ctx.sessionManager));
        }

        // Recompute planning hints against the post-compress state for debug
        // diagnostics and structured result details. Keep them out of the
        // model-visible success text: structural eligibility does not mean a
        // range is semantically closed, and advertising another range here can
        // trigger an unnecessary same-turn compression loop. A later context
        // pass will emit a fresh nudge if context pressure still warrants one.
        const postCompressHints = buildCompressionPlanningHints(
          currentMessages,
          state,
          config.compress.protectRecentTurns
        );

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
          planningHints,
          postCompressHints,
          contextPercent,
        });

        const headerLine =
          ranges.length > 0
            ? `Compressed ${ranges.length} range(s): ${formatTopicList(plannedTopics)}`
            : "No ranges compressed.";
        const responseText = headerLine;

        return {
          content: [{ type: "text", text: responseText }],
          details: {
            blockIds: newBlockIds,
            topic: params.topic,
            topics: plannedTopics,
            blocks: newBlockIds.map((id, index) => ({ id, topic: plannedTopics[index] })),
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
