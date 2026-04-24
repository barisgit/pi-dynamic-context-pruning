// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compress tool registration
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { CompressionBlock, DcpState } from "./types/state.js"
import type { DcpConfig } from "./types/config.js"
import { appendDebugLog, buildSessionDebugPayload } from "./debug-log.js"
import { COMPRESS_RANGE_DESCRIPTION } from "./prompts.js"
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
} from "./domain/compression/tooling.js"
import { estimateTokens } from "./domain/compression/range.js"

export type { CompressionCandidateRange, CompressionPlanningHints } from "./domain/compression/tooling.js"
export {
  buildCompressionArtifactsForRange,
  buildCompressionPlanningHints,
  renderCompressionPlanningHints,
  resolveAnchorSourceKey,
  resolveAnchorTimestamp,
  resolveProtectedTailStartTimestamp,
  resolveSupersededBlockIdsForRange,
  validateCompressionRangeBoundaryIds,
} from "./domain/compression/tooling.js"

function buildCurrentBranchMessages(ctx: any): any[] {
  const branchEntries = ctx.sessionManager.getBranch(ctx.sessionManager.getLeafId() ?? undefined)
  const messages: any[] = []

  for (const entry of branchEntries) {
    if (entry?.type === "message" && entry.message) {
      messages.push(entry.message)
      continue
    }

    if (entry?.type === "custom_message") {
      messages.push({
        role: "custom_message",
        content: entry.content,
        timestamp: Date.parse(entry.timestamp),
      })
      continue
    }

    if (entry?.type === "branch_summary") {
      messages.push({
        role: "branch_summary",
        content: [{ type: "text", text: entry.summary }],
        timestamp: Date.parse(entry.timestamp),
      })
      continue
    }

    if (entry?.type === "compaction") {
      messages.push({
        role: "compaction",
        content: [{ type: "text", text: entry.summary }],
        timestamp: Date.parse(entry.timestamp),
      })
    }
  }

  return messages
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCompressTool(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
): void {
  pi.registerTool({
    name: "compress",
    label: "Compress Context",
    description: COMPRESS_RANGE_DESCRIPTION,
    promptSnippet: "Compress ranges of conversation into summaries to manage context",
    parameters: Type.Object({
      topic: Type.String({
        description:
          "Short label (3-5 words) for display - e.g., 'Auth System Exploration'",
      }),
      ranges: Type.Array(
        Type.Object({
          startId: Type.String({
            description:
              "Message ID marking start of range (e.g. m0001, b2)",
          }),
          endId: Type.String({
            description:
              "Message ID marking end of range (e.g. m0042, b5)",
          }),
          summary: Type.String({
            description:
              "Complete technical summary replacing all content in range",
          }),
        }),
        { description: "One or more ranges to compress" },
      ),
    }),

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const newBlockIds: number[] = []
      const currentMessages = buildCurrentBranchMessages(ctx)
      const usage = ctx.getContextUsage()
      const contextPercent = usage && usage.tokens !== null ? usage.tokens / usage.contextWindow : null
      const protectedTailStartTimestamp = resolveProtectedTailStartTimestamp(
        currentMessages,
        config.compress.protectRecentTurns,
      )
      const planningHints = buildCompressionPlanningHints(
        currentMessages,
        state,
        config.compress.protectRecentTurns,
      )
      const plannedBlocks: CompressionBlock[] = []
      const pendingSupersededBlockIds = new Set<number>()
      let nextBlockId = state.nextBlockId
      let activeRange: { startId: string; endId: string } | null = null

      appendDebugLog(config, "compress_requested", {
        ...buildSessionDebugPayload(ctx.sessionManager),
        topic: params.topic,
        rangeCount: params.ranges.length,
        ranges: params.ranges.map((range) => ({
          startId: range.startId,
          endId: range.endId,
          summaryLength: range.summary.length,
        })),
        contextPercent,
        planningHints,
      })

      try {
        for (const range of params.ranges) {
          const { startId, endId, summary } = range
          activeRange = { startId, endId }

          validateCompressionRangeBoundaryIds(startId, endId, state)

          const startTimestamp = resolveIdToTimestamp(startId, "startTimestamp", state)
          const endTimestamp = resolveIdToTimestamp(endId, "endTimestamp", state)

          if (startTimestamp > endTimestamp) {
            throw new Error(
              `Range start "${startId}" must appear before end "${endId}" in the conversation`,
            )
          }

          if (!Number.isFinite(startTimestamp)) {
            throw new Error(
              `Start ID "${startId}" resolved to a non-finite timestamp (${startTimestamp}). ` +
                `This usually means the referenced message has a corrupted timestamp.`,
            )
          }
          if (!Number.isFinite(endTimestamp)) {
            throw new Error(
              `End ID "${endId}" resolved to a non-finite timestamp (${endTimestamp}). ` +
                `This usually means the referenced message has a corrupted timestamp.`,
            )
          }

          const touchesProtectedTail =
            protectedTailStartTimestamp !== null && endTimestamp >= protectedTailStartTimestamp
          const emergencyOverride =
            contextPercent !== null && contextPercent > config.compress.maxContextPercent

          if (touchesProtectedTail && !emergencyOverride) {
            const planningHintText = renderCompressionPlanningHints(planningHints, {
              includeTailStart: false,
            })
            throw new Error(
              `Compression ranges may not end inside the recent protected tail. ` +
                `This tail starts at ${planningHints.protectedTailStartId ?? "the protected hot-tail boundary"} and protects the last ` +
                `${config.compress.protectRecentTurns} logical turns/tool batches.` +
                `${planningHintText ? `\n\n${planningHintText}` : ""}` +
                `\n\nChoose an older range or wait for a hard context emergency.`,
            )
          }

          const anchorTimestamp = resolveAnchorTimestamp(endTimestamp, state)
          const boundaryStartSourceKey = resolveIdToSourceKey(startId, state, "startSourceKey")
          const boundaryEndSourceKey = resolveIdToSourceKey(endId, state, "endSourceKey")
          const expandedSummary = expandBlockPlaceholders(summary, state)
          const artifacts = buildCompressionArtifactsForRange(
            currentMessages,
            state,
            startTimestamp,
            endTimestamp,
          )
          const expandedStartSourceKey = artifacts.metadata.coveredSourceKeys[0] ?? boundaryStartSourceKey
          const expandedEndSourceKey = artifacts.metadata.coveredSourceKeys.at(-1) ?? boundaryEndSourceKey
          const anchorSourceKey = resolveAnchorSourceKey(endTimestamp, expandedEndSourceKey ?? null, state)
          const supersededBlockIds = resolveSupersededBlockIdsForRange(
            currentMessages,
            [...state.compressionBlocks, ...plannedBlocks],
            startTimestamp,
            endTimestamp,
            artifacts.metadata.coveredSourceKeys,
            startId,
            endId,
            pendingSupersededBlockIds,
          )
          for (const blockId of supersededBlockIds) {
            pendingSupersededBlockIds.add(blockId)
          }
          artifacts.metadata.supersededBlockIds = supersededBlockIds

          const block: CompressionBlock = {
            id: nextBlockId++,
            topic: params.topic,
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
          }

          plannedBlocks.push(block)
          newBlockIds.push(block.id)
        }

        if (plannedBlocks.length > 0) {
          state.nextBlockId = nextBlockId
          for (const existing of state.compressionBlocks) {
            if (pendingSupersededBlockIds.has(existing.id)) {
              existing.active = false
            }
          }
          state.compressionBlocks.push(...plannedBlocks)
          state.lastCompressTurn = state.currentTurn
          state.lastNudgeTurn = state.currentTurn
        }

        if (config.pruneNotification !== "off") {
          const count = params.ranges.length
          const rangeWord = count === 1 ? "range" : "ranges"

          if (config.pruneNotification === "detailed") {
            const totalTokens = newBlockIds.reduce((sum, id) => {
              const b = state.compressionBlocks.find((block) => block.id === id)
              return sum + (b?.summaryTokenEstimate ?? 0)
            }, 0)
            ctx.ui.notify(
              `Compressed: ${params.topic} (${count} ${rangeWord}, ~${totalTokens} tokens in summaries)`,
              "info",
            )
          } else {
            ctx.ui.notify(`Compressed: ${params.topic}`, "info")
          }
        }

        appendDebugLog(config, "compress_succeeded", {
          ...buildSessionDebugPayload(ctx.sessionManager),
          topic: params.topic,
          blockIds: newBlockIds,
          supersededBlockIds: Array.from(pendingSupersededBlockIds),
          planningHints,
          contextPercent,
        })

        return {
          content: [
            {
              type: "text",
              text: `Compressed ${params.ranges.length} range(s): ${params.topic}`,
            },
          ],
          details: {
            blockIds: newBlockIds,
            topic: params.topic,
          },
        }
      } catch (error) {
        appendDebugLog(config, "compress_failed", {
          ...buildSessionDebugPayload(ctx.sessionManager),
          topic: params.topic,
          activeRange,
          contextPercent,
          planningHints,
          error,
        })
        throw error
      }
    },
  })
}
