// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — persisted state migration helpers
// ---------------------------------------------------------------------------

import type {
  CompressionBlock,
  CompressionBlockStatus,
  CompressionBlockV2,
  DcpState,
  PersistedDcpState,
  PersistedDcpStateV1,
  PersistedDcpStateV2,
} from "./state.js"

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
    createdAt: isFiniteNumber(block.createdAt) ? block.createdAt : Date.now(),
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

  const supersedesBlockIds = Array.isArray(block.supersedesBlockIds)
    ? block.supersedesBlockIds.filter(isFiniteNumber)
    : []

  return {
    id: block.id,
    topic: block.topic,
    summary: block.summary,
    startSpanKey: block.startSpanKey,
    endSpanKey: block.endSpanKey,
    supersedesBlockIds,
    status: normalizeBlockStatus(block.status),
    summaryTokenEstimate: isFiniteNumber(block.summaryTokenEstimate)
      ? block.summaryTokenEstimate
      : 0,
    createdAt: isFiniteNumber(block.createdAt) ? block.createdAt : Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
