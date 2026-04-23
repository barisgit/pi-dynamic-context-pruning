// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — persisted state migration helpers
// ---------------------------------------------------------------------------

import {
  createEmptyCompressionBlockMetadata,
  type CompressionBlock,
  type CompressionBlockMetadata,
  type CompressionBlockStatus,
  type CompressionBlockV2,
  type CompressionCommandStat,
  type CompressionFileReadStat,
  type CompressionFileWriteStat,
  type CompressionLogEntry,
  type DcpState,
  type PersistedDcpState,
  type PersistedDcpStateV1,
  type PersistedDcpStateV2,
} from "./state.js"
import type { TranscriptSnapshot } from "./transcript.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null
  return value as Record<string, unknown>
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function normalizeBlockStatus(value: unknown): CompressionBlockStatus {
  return value === "superseded" || value === "decompressed" ? value : "active"
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function normalizeCompressionLogEntry(value: unknown): CompressionLogEntry | null {
  const entry = asObject(value)
  if (!entry || typeof entry.text !== "string") return null

  switch (entry.kind) {
    case "user_excerpt":
    case "assistant_excerpt":
    case "read":
    case "edit":
    case "write":
    case "command":
    case "test":
    case "commit":
    case "tool":
      return {
        kind: entry.kind,
        text: entry.text,
      }
    default:
      return null
  }
}

function normalizeFileReadStat(value: unknown): CompressionFileReadStat | null {
  const stat = asObject(value)
  if (!stat || typeof stat.path !== "string") return null

  return {
    path: stat.path,
    count: isFiniteNumber(stat.count) ? stat.count : 0,
    lineSpans: normalizeStringArray(stat.lineSpans),
  }
}

function normalizeFileWriteStat(value: unknown): CompressionFileWriteStat | null {
  const stat = asObject(value)
  if (!stat || typeof stat.path !== "string") return null

  return {
    path: stat.path,
    editCount: isFiniteNumber(stat.editCount) ? stat.editCount : 0,
    addedLines: isFiniteNumber(stat.addedLines) ? stat.addedLines : 0,
    removedLines: isFiniteNumber(stat.removedLines) ? stat.removedLines : 0,
  }
}

function normalizeCommandStat(value: unknown): CompressionCommandStat | null {
  const stat = asObject(value)
  if (!stat || typeof stat.command !== "string") return null

  return {
    command: stat.command,
    status: stat.status === "ok" || stat.status === "error" ? stat.status : "other",
  }
}

function normalizeCompressionBlockMetadata(value: unknown, legacySupersededBlockIds: number[]): CompressionBlockMetadata {
  const metadata = asObject(value)
  if (!metadata) {
    return {
      ...createEmptyCompressionBlockMetadata(),
      supersededBlockIds: legacySupersededBlockIds,
    }
  }

  return {
    coveredSourceKeys: normalizeStringArray(metadata.coveredSourceKeys),
    coveredSpanKeys: normalizeStringArray(metadata.coveredSpanKeys),
    coveredArtifactRefs: normalizeStringArray(metadata.coveredArtifactRefs),
    coveredToolIds: normalizeStringArray(metadata.coveredToolIds),
    supersededBlockIds: Array.isArray(metadata.supersededBlockIds)
      ? metadata.supersededBlockIds.filter(isFiniteNumber)
      : legacySupersededBlockIds,
    fileReadStats: Array.isArray(metadata.fileReadStats)
      ? metadata.fileReadStats.map(normalizeFileReadStat).filter((stat): stat is CompressionFileReadStat => stat !== null)
      : [],
    fileWriteStats: Array.isArray(metadata.fileWriteStats)
      ? metadata.fileWriteStats.map(normalizeFileWriteStat).filter((stat): stat is CompressionFileWriteStat => stat !== null)
      : [],
    commandStats: Array.isArray(metadata.commandStats)
      ? metadata.commandStats.map(normalizeCommandStat).filter((stat): stat is CompressionCommandStat => stat !== null)
      : [],
  }
}

function normalizeLegacyBlock(value: unknown): CompressionBlock | null {
  const block = asObject(value)
  if (!block) return null

  if (
    !isFiniteNumber(block.id) ||
    typeof block.topic !== "string" ||
    typeof block.summary !== "string" ||
    !isFiniteNumber(block.startTimestamp) ||
    !isFiniteNumber(block.endTimestamp)
  ) {
    return null
  }

  const activityLog = Array.isArray(block.activityLog)
    ? block.activityLog
        .map(normalizeCompressionLogEntry)
        .filter((entry): entry is CompressionLogEntry => entry !== null)
    : undefined

  return {
    id: block.id,
    topic: block.topic,
    summary: block.summary,
    startTimestamp: block.startTimestamp,
    endTimestamp: block.endTimestamp,
    anchorTimestamp: isFiniteNumber(block.anchorTimestamp)
      ? block.anchorTimestamp
      : Infinity,
    active: typeof block.active === "boolean" ? block.active : true,
    summaryTokenEstimate: isFiniteNumber(block.summaryTokenEstimate)
      ? block.summaryTokenEstimate
      : 0,
    savedTokenEstimate: isFiniteNumber(block.savedTokenEstimate)
      ? block.savedTokenEstimate
      : 0,
    createdAt: isFiniteNumber(block.createdAt) ? block.createdAt : Date.now(),
    compressCallId: typeof block.compressCallId === "string" ? block.compressCallId : undefined,
    activityLogVersion: activityLog ? 1 : undefined,
    activityLog,
    metadata: normalizeCompressionBlockMetadata(block.metadata, []),
  }
}

function normalizeV2Block(value: unknown): CompressionBlockV2 | null {
  const block = asObject(value)
  if (!block) return null

  if (
    !isFiniteNumber(block.id) ||
    typeof block.topic !== "string" ||
    typeof block.summary !== "string" ||
    typeof block.startSpanKey !== "string" ||
    typeof block.endSpanKey !== "string"
  ) {
    return null
  }

  const legacySupersededBlockIds = Array.isArray(block.supersedesBlockIds)
    ? block.supersedesBlockIds.filter(isFiniteNumber)
    : []
  const activityLog = Array.isArray(block.activityLog)
    ? block.activityLog
        .map(normalizeCompressionLogEntry)
        .filter((entry): entry is CompressionLogEntry => entry !== null)
    : []
  const metadata = normalizeCompressionBlockMetadata(block.metadata, legacySupersededBlockIds)

  return {
    id: block.id,
    topic: block.topic,
    summary: block.summary,
    startSpanKey: block.startSpanKey,
    endSpanKey: block.endSpanKey,
    status: normalizeBlockStatus(block.status),
    summaryTokenEstimate: isFiniteNumber(block.summaryTokenEstimate)
      ? block.summaryTokenEstimate
      : 0,
    createdAt: isFiniteNumber(block.createdAt) ? block.createdAt : Date.now(),
    activityLogVersion: 1,
    activityLog,
    metadata,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Span coverage for one remapped legacy block. */
export interface LegacyBlockSpanRange {
  startSpanKey: string
  endSpanKey: string
}

function findSourceItemKeyByTimestamp(
  snapshot: TranscriptSnapshot,
  timestamp: number,
): string | null {
  const item = snapshot.sourceItems.find((candidate) => candidate.timestamp === timestamp)
  return item?.key ?? null
}

function findContainingSpanKey(
  snapshot: TranscriptSnapshot,
  sourceKey: string,
): string | null {
  const span = snapshot.spans.find((candidate) => candidate.sourceKeys.includes(sourceKey))
  return span?.key ?? null
}

/**
 * Map a legacy timestamp-based block onto the current v2 span model.
 *
 * If the legacy timestamps fall inside a grouped `tool-exchange` span, the
 * returned start/end keys point at that encompassing span rather than the raw
 * underlying source item.
 */
export function mapLegacyBlockToSpanRange(
  block: CompressionBlock,
  snapshot: TranscriptSnapshot,
): LegacyBlockSpanRange | null {
  const startSourceKey = findSourceItemKeyByTimestamp(snapshot, block.startTimestamp)
  const endSourceKey = findSourceItemKeyByTimestamp(snapshot, block.endTimestamp)
  if (!startSourceKey || !endSourceKey) return null

  const startSpanKey = findContainingSpanKey(snapshot, startSourceKey)
  const endSpanKey = findContainingSpanKey(snapshot, endSourceKey)
  if (!startSpanKey || !endSpanKey) return null

  return {
    startSpanKey,
    endSpanKey,
  }
}

/**
 * Serialize runtime state back into the most-recent persisted schema seen by
 * the current process. This keeps Phase 1 backward-compatible while avoiding
 * accidental loss of future v2 block data during round-trips.
 */
export function serializePersistedState(state: DcpState): PersistedDcpState {
  if (state.schemaVersion === 2) {
    const persisted: PersistedDcpStateV2 = {
      schemaVersion: 2,
      blocks: state.compressionBlocksV2,
      nextBlockId: state.nextBlockId,
      manualMode: state.manualMode,
      lastNudgeTurn: state.lastNudgeTurn,
      lastCompressTurn: state.lastCompressTurn,
    }
    return persisted
  }

  const persisted: PersistedDcpStateV1 = {
    schemaVersion: 1,
    compressionBlocks: state.compressionBlocks,
    nextBlockId: state.nextBlockId,
    prunedToolIds: Array.from(state.prunedToolIds),
    tokensSaved: state.tokensSaved,
    totalPruneCount: state.totalPruneCount,
    manualMode: state.manualMode,
    lastNudgeTurn: state.lastNudgeTurn,
    lastCompressTurn: state.lastCompressTurn,
  }
  return persisted
}

/**
 * Restore one persisted DCP state entry into runtime state.
 *
 * The current runtime still executes legacy v1 blocks; v2 blocks are preserved
 * in `state.compressionBlocksV2` for future work but are not yet materialized.
 */
export function restorePersistedState(data: unknown, state: DcpState): void {
  const persisted = asObject(data)
  if (!persisted) return

  if (persisted.schemaVersion === 2 || Array.isArray(persisted.blocks)) {
    const blocks = Array.isArray(persisted.blocks)
      ? persisted.blocks.map(normalizeV2Block).filter((b): b is CompressionBlockV2 => b !== null)
      : []

    state.schemaVersion = 2
    state.compressionBlocks = []
    state.compressionBlocksV2 = blocks
    state.nextBlockId = isFiniteNumber(persisted.nextBlockId)
      ? persisted.nextBlockId
      : blocks.length > 0
        ? Math.max(0, ...blocks.map((b) => b.id)) + 1
        : 1

    if (typeof persisted.manualMode === "boolean") {
      state.manualMode = persisted.manualMode
    }
    if (isFiniteNumber(persisted.lastNudgeTurn)) {
      state.lastNudgeTurn = persisted.lastNudgeTurn
    }
    if (isFiniteNumber(persisted.lastCompressTurn)) {
      state.lastCompressTurn = persisted.lastCompressTurn
    }

    return
  }

  const blocks = Array.isArray(persisted.compressionBlocks)
    ? persisted.compressionBlocks
        .map(normalizeLegacyBlock)
        .filter((b): b is CompressionBlock => b !== null)
    : []

  state.schemaVersion = 1
  state.compressionBlocks = blocks
  state.compressionBlocksV2 = []
  state.nextBlockId = isFiniteNumber(persisted.nextBlockId)
    ? persisted.nextBlockId
    : blocks.length > 0
      ? Math.max(0, ...blocks.map((b) => b.id)) + 1
      : 1
  state.tokensSaved = isFiniteNumber(persisted.tokensSaved) ? persisted.tokensSaved : 0
  state.totalPruneCount = isFiniteNumber(persisted.totalPruneCount)
    ? persisted.totalPruneCount
    : 0

  if (Array.isArray(persisted.prunedToolIds)) {
    state.prunedToolIds = new Set(
      persisted.prunedToolIds.filter((value): value is string => typeof value === "string"),
    )
  }

  if (typeof persisted.manualMode === "boolean") {
    state.manualMode = persisted.manualMode
  }
  if (isFiniteNumber(persisted.lastNudgeTurn)) {
    state.lastNudgeTurn = persisted.lastNudgeTurn
  }
  if (isFiniteNumber(persisted.lastCompressTurn)) {
    state.lastCompressTurn = persisted.lastCompressTurn
  }
}
