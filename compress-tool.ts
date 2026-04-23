// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compress tool registration
// ---------------------------------------------------------------------------

import { Type } from "@sinclair/typebox"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import {
  createEmptyCompressionBlockMetadata,
  type CompressionBlock,
  type CompressionBlockMetadata,
  type CompressionLogEntry,
  type DcpState,
} from "./state.js"
import type { DcpConfig } from "./config.js"
import { COMPRESS_RANGE_DESCRIPTION } from "./prompts.js"
import { estimateTokens, resolveCompressionRangeIndices } from "./pruner.js"
import {
  buildTranscriptSnapshot,
  resolveCompressionBlockCoveredSourceKeys,
  resolveLogicalTurnTailStartTimestamp,
} from "./transcript.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_EXCERPT_CHARS = 160

type CompressionArtifacts = {
  activityLogVersion: 1
  activityLog: CompressionLogEntry[]
  metadata: CompressionBlockMetadata
}

type ToolCallDescriptor = {
  toolName: string
  inputArgs: Record<string, unknown>
}

/**
 * Replace `(bN)` placeholders in a summary with the stored content of the
 * referenced compression block. Unrecognised placeholders are left as-is.
 */
function expandBlockPlaceholders(summary: string, state: DcpState): string {
  return summary.replace(/\(b(\d+)\)/g, (match, idStr) => {
    const id = parseInt(idStr, 10)
    const block = state.compressionBlocks.find((b) => b.id === id && b.active)
    return block ? `[Previously compressed: ${block.topic}]\n${block.summary}` : match
  })
}

/**
 * Resolve a user-supplied ID string (e.g. "m001" or "b3") to an actual
 * message timestamp.
 */
function resolveIdToTimestamp(
  rawId: string,
  field: "startTimestamp" | "endTimestamp",
  state: DcpState,
): number {
  const id = rawId.trim()

  const blockMatch = id.match(/^b(\d+)$/i)
  if (blockMatch) {
    const blockId = parseInt(blockMatch[1]!, 10)
    const block = state.compressionBlocks.find((b) => b.id === blockId && b.active)
    if (!block) throw new Error(`Unknown message ID: ${id}`)
    return block[field]
  }

  const ts = state.messageIdSnapshot.get(id)
  if (ts === undefined) throw new Error(`Unknown message ID: ${id}`)
  return ts
}

/**
 * Determine the anchor timestamp for a compression block — the timestamp of
 * the first raw message that appears strictly after `endTimestamp`.
 */
function resolveAnchorTimestamp(endTimestamp: number, state: DcpState): number {
  let anchor: number | null = null
  for (const ts of state.messageIdSnapshot.values()) {
    if (ts > endTimestamp && (anchor === null || ts < anchor)) {
      anchor = ts
    }
  }
  return anchor ?? endTimestamp + 1
}

function resolveVisibleIdForTimestamp(timestamp: number, state: DcpState): string | null {
  for (const [messageId, candidateTimestamp] of state.messageIdSnapshot.entries()) {
    if (candidateTimestamp === timestamp) return messageId
  }
  return null
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…"
}

function countLines(text: string): number {
  return text === "" ? 0 : text.split(/\r?\n/).length
}

function getTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []

  return content
    .flatMap((part: any) => {
      if (!part || typeof part !== "object") return []
      if (typeof part.text === "string") return [part.text]
      if (typeof part.input === "string") return [part.input]
      return []
    })
    .filter((text): text is string => text.length > 0)
}

function extractMessageExcerpt(message: any): string | null {
  const joined = normalizeInlineWhitespace(getTextParts(message?.content).join(" "))
  if (!joined) return null
  return truncateText(joined, MAX_EXCERPT_CHARS)
}

function quotedExcerpt(text: string): string {
  return `"${text}"`
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function formatReadLineSpan(args: Record<string, unknown>): string | null {
  const offset = asFiniteNumber(args.offset)
  const limit = asFiniteNumber(args.limit)
  if (offset === null) return null
  if (limit === null || limit <= 1) return `L${offset}`
  return `L${offset}-L${offset + Math.max(0, limit - 1)}`
}

function upsertFileReadStat(
  metadata: CompressionBlockMetadata,
  path: string,
  lineSpan: string | null,
): void {
  let stat = metadata.fileReadStats.find((candidate) => candidate.path === path)
  if (!stat) {
    stat = { path, count: 0, lineSpans: [] }
    metadata.fileReadStats.push(stat)
  }
  stat.count++
  if (lineSpan && !stat.lineSpans.includes(lineSpan)) {
    stat.lineSpans.push(lineSpan)
  }
}

function upsertFileWriteStat(
  metadata: CompressionBlockMetadata,
  path: string,
  editCount: number,
  addedLines: number,
  removedLines: number,
): void {
  let stat = metadata.fileWriteStats.find((candidate) => candidate.path === path)
  if (!stat) {
    stat = { path, editCount: 0, addedLines: 0, removedLines: 0 }
    metadata.fileWriteStats.push(stat)
  }
  stat.editCount += editCount
  stat.addedLines += addedLines
  stat.removedLines += removedLines
}

function pushCommandStat(
  metadata: CompressionBlockMetadata,
  command: string,
  status: "ok" | "error" | "other",
): void {
  metadata.commandStats.push({ command, status })
}

function classifyCommandKind(command: string): "command" | "test" | "commit" {
  if (/^git\s+commit\b/.test(command)) return "commit"
  if (/(^|\s)(bun\s+run|npm\s+test|pnpm\s+test|yarn\s+test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/.test(command)) {
    return "test"
  }
  return "command"
}

function buildEditStats(edits: unknown): { editCount: number; addedLines: number; removedLines: number } {
  if (!Array.isArray(edits)) {
    return { editCount: 0, addedLines: 0, removedLines: 0 }
  }

  let addedLines = 0
  let removedLines = 0
  let editCount = 0

  for (const rawEdit of edits) {
    const edit = asObject(rawEdit)
    if (!edit) continue
    editCount++

    const oldText = typeof edit.oldText === "string" ? edit.oldText : ""
    const newText = typeof edit.newText === "string" ? edit.newText : ""
    const oldLines = countLines(oldText)
    const newLines = countLines(newText)

    if (newLines > oldLines) {
      addedLines += newLines - oldLines
    } else if (oldLines > newLines) {
      removedLines += oldLines - newLines
    }
  }

  return { editCount, addedLines, removedLines }
}

function summarizeGenericToolArgs(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : null
  const pattern = typeof args.pattern === "string" ? args.pattern : null
  const command = typeof args.command === "string" ? args.command : null

  if (path && pattern) return `${path} ${pattern}`
  if (path) return path
  if (command) return truncateText(normalizeInlineWhitespace(command), MAX_EXCERPT_CHARS)
  if (pattern) return pattern
  return ""
}

function parseToolCallArguments(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }

  return {}
}

function buildToolCallLookup(messages: any[]): Map<string, ToolCallDescriptor> {
  const lookup = new Map<string, ToolCallDescriptor>()

  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue

    for (const block of message.content) {
      if (!block || typeof block !== "object") continue
      if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") {
        continue
      }

      lookup.set(block.id, {
        toolName: block.name,
        inputArgs: parseToolCallArguments((block as any).arguments),
      })
    }
  }

  return lookup
}

function buildToolLogEntry(
  message: any,
  state: DcpState,
  toolCallLookup: Map<string, ToolCallDescriptor>,
  metadata: CompressionBlockMetadata,
): CompressionLogEntry | null {
  const toolCallId = typeof message?.toolCallId === "string" ? message.toolCallId : null
  if (toolCallId) {
    metadata.coveredToolIds.push(toolCallId)
    metadata.coveredArtifactRefs.push(`tool:${toolCallId}`)
  }

  const record = toolCallId ? state.toolCalls.get(toolCallId) : undefined
  const descriptor = toolCallId ? toolCallLookup.get(toolCallId) : undefined
  const toolName = typeof message?.toolName === "string"
    ? message.toolName
    : descriptor?.toolName ?? record?.toolName
  const args = descriptor?.inputArgs ?? record?.inputArgs ?? {}

  if (!toolName) return null

  if (toolName === "read") {
    const path = typeof args.path === "string" ? args.path : "(unknown path)"
    const lineSpan = formatReadLineSpan(args)
    upsertFileReadStat(metadata, path, lineSpan)
    return {
      kind: "read",
      text: lineSpan ? `${path}#${lineSpan}` : path,
    }
  }

  if (toolName === "edit") {
    const path = typeof args.path === "string" ? args.path : "(unknown path)"
    const stats = buildEditStats(args.edits)
    upsertFileWriteStat(metadata, path, stats.editCount, stats.addedLines, stats.removedLines)
    return {
      kind: "edit",
      text: `${path} (${stats.editCount} edit${stats.editCount === 1 ? "" : "s"}, +${stats.addedLines}/-${stats.removedLines})`,
    }
  }

  if (toolName === "write") {
    const path = typeof args.path === "string" ? args.path : "(unknown path)"
    const content = typeof args.content === "string" ? args.content : ""
    const addedLines = countLines(content)
    upsertFileWriteStat(metadata, path, 1, addedLines, 0)
    return {
      kind: "write",
      text: `${path} (${addedLines} lines)`,
    }
  }

  if (toolName === "bash") {
    const rawCommand = typeof args.command === "string" ? args.command : "(unknown command)"
    const command = truncateText(normalizeInlineWhitespace(rawCommand), MAX_EXCERPT_CHARS)
    const status = message?.isError ? "error" : "ok"
    pushCommandStat(metadata, rawCommand, status)
    return {
      kind: classifyCommandKind(rawCommand),
      text: `${command} -> ${status}`,
    }
  }

  const suffix = summarizeGenericToolArgs(args)
  return {
    kind: "tool",
    text: suffix ? `${toolName} ${suffix}` : toolName,
  }
}

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

export function resolveProtectedTailStartTimestamp(
  messages: any[],
  protectRecentTurns: number,
): number | null {
  return resolveLogicalTurnTailStartTimestamp(messages, protectRecentTurns)
}

function buildOverlapError(startId: string, endId: string, existing: CompressionBlock): Error {
  return new Error(
    `Overlapping compression ranges are not supported. ` +
      `New range (${startId}..${endId}) overlaps existing block ` +
      `b${existing.id} "${existing.topic}". ` +
      `Choose a range entirely before or after b${existing.id}, or compress relative to b${existing.id} itself.`,
  )
}

export function resolveSupersededBlockIdsForRange(
  messages: any[],
  compressionBlocks: CompressionBlock[],
  startTimestamp: number,
  endTimestamp: number,
  newCoveredSourceKeys: Iterable<string>,
  startId: string,
  endId: string,
  ignoredBlockIds: Set<number> = new Set(),
): number[] {
  const snapshot = buildTranscriptSnapshot(messages)
  const newCoveredSourceKeySet = new Set(newCoveredSourceKeys)
  const supersededBlockIds: number[] = []

  for (const existing of compressionBlocks) {
    if (!existing.active) continue
    if (ignoredBlockIds.has(existing.id)) continue
    if (!Number.isFinite(existing.startTimestamp) || !Number.isFinite(existing.endTimestamp)) continue

    const overlaps =
      startTimestamp <= existing.endTimestamp && existing.startTimestamp <= endTimestamp
    if (!overlaps) continue

    const existingCoveredSourceKeys = resolveCompressionBlockCoveredSourceKeys(snapshot, existing)
    if (existingCoveredSourceKeys === null || existingCoveredSourceKeys.size === 0) {
      throw buildOverlapError(startId, endId, existing)
    }

    let coveredCount = 0
    for (const sourceKey of existingCoveredSourceKeys) {
      if (newCoveredSourceKeySet.has(sourceKey)) coveredCount++
    }

    if (coveredCount === existingCoveredSourceKeys.size) {
      supersededBlockIds.push(existing.id)
      continue
    }

    throw buildOverlapError(startId, endId, existing)
  }

  return supersededBlockIds
}

function buildCompressionArtifactsFromMessages(
  messages: any[],
  state: DcpState,
  metadata: CompressionBlockMetadata = createEmptyCompressionBlockMetadata(),
): CompressionArtifacts {
  const activityLog: CompressionLogEntry[] = []
  const toolCallLookup = buildToolCallLookup(messages)

  for (const message of messages) {
    const timestamp = typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)
      ? message.timestamp
      : null
    if (timestamp !== null) {
      metadata.coveredArtifactRefs.push(`message:${timestamp}`)
    }

    if (message?.role === "user") {
      const excerpt = extractMessageExcerpt(message)
      if (excerpt) activityLog.push({ kind: "user_excerpt", text: quotedExcerpt(excerpt) })
      continue
    }

    if (message?.role === "assistant") {
      const excerpt = extractMessageExcerpt(message)
      if (excerpt) activityLog.push({ kind: "assistant_excerpt", text: quotedExcerpt(excerpt) })
      continue
    }

    if (message?.role === "toolResult" || message?.role === "bashExecution") {
      const entry = buildToolLogEntry(message, state, toolCallLookup, metadata)
      if (entry) activityLog.push(entry)
    }
  }

  metadata.coveredToolIds = Array.from(new Set(metadata.coveredToolIds))
  metadata.coveredArtifactRefs = Array.from(new Set(metadata.coveredArtifactRefs))

  return {
    activityLogVersion: 1,
    activityLog,
    metadata,
  }
}

export function buildCompressionArtifactsForRange(
  messages: any[],
  state: DcpState,
  startTimestamp: number,
  endTimestamp: number,
): CompressionArtifacts {
  const range = resolveCompressionRangeIndices(messages, startTimestamp, endTimestamp)
  if (!range) {
    return {
      activityLogVersion: 1,
      activityLog: [],
      metadata: createEmptyCompressionBlockMetadata(),
    }
  }

  const snapshot = buildTranscriptSnapshot(messages)
  const coveredItems = snapshot.sourceItems.slice(range.lo, range.hi + 1)
  const coveredSourceKeys = coveredItems.map((item) => item.key)
  const coveredSourceKeySet = new Set(coveredSourceKeys)
  const metadata = createEmptyCompressionBlockMetadata()
  metadata.coveredSourceKeys = coveredSourceKeys
  metadata.coveredSpanKeys = snapshot.spans
    .filter((span) => span.sourceKeys.every((key) => coveredSourceKeySet.has(key)))
    .map((span) => span.key)

  return buildCompressionArtifactsFromMessages(messages.slice(range.lo, range.hi + 1), state, metadata)
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
              "Message ID marking start of range (e.g. m001, b2)",
          }),
          endId: Type.String({
            description:
              "Message ID marking end of range (e.g. m042, b5)",
          }),
          summary: Type.String({
            description:
              "Complete technical summary replacing all content in range",
          }),
        }),
        { description: "One or more ranges to compress" },
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const newBlockIds: number[] = []
      const currentMessages = buildCurrentBranchMessages(ctx)
      const usage = ctx.getContextUsage()
      const contextPercent = usage && usage.tokens !== null ? usage.tokens / usage.contextWindow : null
      const protectedTailStartTimestamp = resolveProtectedTailStartTimestamp(
        currentMessages,
        config.compress.protectRecentTurns,
      )
      const plannedBlocks: CompressionBlock[] = []
      const pendingSupersededBlockIds = new Set<number>()
      let nextBlockId = state.nextBlockId

      for (const range of params.ranges) {
        const { startId, endId, summary } = range

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
          const protectedTailStartId = resolveVisibleIdForTimestamp(protectedTailStartTimestamp, state)
          throw new Error(
            `Compression ranges may not end inside the recent protected tail. ` +
              `This tail starts at ${protectedTailStartId ?? "the protected hot-tail boundary"} and protects the last ` +
              `${config.compress.protectRecentTurns} logical turns/tool batches. ` +
              `Choose an older range or wait for a hard context emergency.`,
          )
        }

        const anchorTimestamp = resolveAnchorTimestamp(endTimestamp, state)
        const expandedSummary = expandBlockPlaceholders(summary, state)
        const artifacts = buildCompressionArtifactsForRange(
          currentMessages,
          state,
          startTimestamp,
          endTimestamp,
        )
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
          active: true,
          summaryTokenEstimate: estimateTokens(expandedSummary),
          savedTokenEstimate: 0,
          createdAt: Date.now(),
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
    },
  })
}
