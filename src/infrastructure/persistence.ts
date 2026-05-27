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
  type PersistedDcpStateV3,
} from "../state.js";
import { normalizeMessageAliasState, serializeMessageAliasState } from "../message-refs.js";
import type { TranscriptSnapshot } from "../transcript.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeBlockStatus(value: unknown): CompressionBlockStatus {
  return value === "superseded" || value === "decompressed" ? value : "active";
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeCompressionLogEntry(value: unknown): CompressionLogEntry | null {
  const entry = asObject(value);
  if (!entry || typeof entry.text !== "string") return null;

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
      };
    default:
      return null;
  }
}

function normalizeFileReadStat(value: unknown): CompressionFileReadStat | null {
  const stat = asObject(value);
  if (!stat || typeof stat.path !== "string") return null;

  return {
    path: stat.path,
    count: isFiniteNumber(stat.count) ? stat.count : 0,
    lineSpans: normalizeStringArray(stat.lineSpans),
  };
}

function normalizeFileWriteStat(value: unknown): CompressionFileWriteStat | null {
  const stat = asObject(value);
  if (!stat || typeof stat.path !== "string") return null;

  return {
    path: stat.path,
    editCount: isFiniteNumber(stat.editCount) ? stat.editCount : 0,
    addedLines: isFiniteNumber(stat.addedLines) ? stat.addedLines : 0,
    removedLines: isFiniteNumber(stat.removedLines) ? stat.removedLines : 0,
  };
}

function normalizeCommandStat(value: unknown): CompressionCommandStat | null {
  const stat = asObject(value);
  if (!stat || typeof stat.command !== "string") return null;

  return {
    command: stat.command,
    status: stat.status === "ok" || stat.status === "error" ? stat.status : "other",
  };
}

function normalizeCompressionBlockMetadata(
  value: unknown,
  legacySupersededBlockIds: number[]
): CompressionBlockMetadata {
  const metadata = asObject(value);
  if (!metadata) {
    return {
      ...createEmptyCompressionBlockMetadata(),
      supersededBlockIds: legacySupersededBlockIds,
    };
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
      ? metadata.fileReadStats
          .map(normalizeFileReadStat)
          .filter((stat): stat is CompressionFileReadStat => stat !== null)
      : [],
    fileWriteStats: Array.isArray(metadata.fileWriteStats)
      ? metadata.fileWriteStats
          .map(normalizeFileWriteStat)
          .filter((stat): stat is CompressionFileWriteStat => stat !== null)
      : [],
    commandStats: Array.isArray(metadata.commandStats)
      ? metadata.commandStats
          .map(normalizeCommandStat)
          .filter((stat): stat is CompressionCommandStat => stat !== null)
      : [],
  };
}

function normalizeLegacyBlock(value: unknown): CompressionBlock | null {
  const block = asObject(value);
  if (!block) return null;

  if (
    !isFiniteNumber(block.id) ||
    typeof block.topic !== "string" ||
    typeof block.summary !== "string" ||
    !isFiniteNumber(block.startTimestamp) ||
    !isFiniteNumber(block.endTimestamp)
  ) {
    return null;
  }

  const activityLog = Array.isArray(block.activityLog)
    ? block.activityLog
        .map(normalizeCompressionLogEntry)
        .filter((entry): entry is CompressionLogEntry => entry !== null)
    : undefined;

  return {
    id: block.id,
    topic: block.topic,
    summary: block.summary,
    startTimestamp: block.startTimestamp,
    endTimestamp: block.endTimestamp,
    anchorTimestamp: isFiniteNumber(block.anchorTimestamp) ? block.anchorTimestamp : Infinity,
    startSourceKey: typeof block.startSourceKey === "string" ? block.startSourceKey : undefined,
    endSourceKey: typeof block.endSourceKey === "string" ? block.endSourceKey : undefined,
    anchorSourceKey: typeof block.anchorSourceKey === "string" ? block.anchorSourceKey : undefined,
    active: typeof block.active === "boolean" ? block.active : true,
    summaryTokenEstimate: isFiniteNumber(block.summaryTokenEstimate)
      ? block.summaryTokenEstimate
      : 0,
    savedTokenEstimate: isFiniteNumber(block.savedTokenEstimate) ? block.savedTokenEstimate : 0,
    createdAt: isFiniteNumber(block.createdAt) ? block.createdAt : Date.now(),
    compressCallId: typeof block.compressCallId === "string" ? block.compressCallId : undefined,
    activityLogVersion: activityLog ? 1 : undefined,
    activityLog,
    metadata: normalizeCompressionBlockMetadata(block.metadata, []),
  };
}

function normalizeV2Block(value: unknown): CompressionBlockV2 | null {
  const block = asObject(value);
  if (!block) return null;

  if (
    !isFiniteNumber(block.id) ||
    typeof block.topic !== "string" ||
    typeof block.summary !== "string" ||
    typeof block.startSpanKey !== "string" ||
    typeof block.endSpanKey !== "string"
  ) {
    return null;
  }

  const legacySupersededBlockIds = Array.isArray(block.supersedesBlockIds)
    ? block.supersedesBlockIds.filter(isFiniteNumber)
    : [];
  const activityLog = Array.isArray(block.activityLog)
    ? block.activityLog
        .map(normalizeCompressionLogEntry)
        .filter((entry): entry is CompressionLogEntry => entry !== null)
    : [];
  const metadata = normalizeCompressionBlockMetadata(block.metadata, legacySupersededBlockIds);

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
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Span coverage for one remapped legacy block. */
export interface LegacyBlockSpanRange {
  startSpanKey: string;
  endSpanKey: string;
}

function findSourceItemKeyByTimestamp(
  snapshot: TranscriptSnapshot,
  timestamp: number
): string | null {
  const item = snapshot.sourceItems.find((candidate) => candidate.timestamp === timestamp);
  return item?.key ?? null;
}

function findContainingSpanKey(snapshot: TranscriptSnapshot, sourceKey: string): string | null {
  const span = snapshot.spans.find((candidate) => candidate.sourceKeys.includes(sourceKey));
  return span?.key ?? null;
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
  snapshot: TranscriptSnapshot
): LegacyBlockSpanRange | null {
  const startSourceKey = findSourceItemKeyByTimestamp(snapshot, block.startTimestamp);
  const endSourceKey = findSourceItemKeyByTimestamp(snapshot, block.endTimestamp);
  if (!startSourceKey || !endSourceKey) return null;

  const startSpanKey = findContainingSpanKey(snapshot, startSourceKey);
  const endSpanKey = findContainingSpanKey(snapshot, endSourceKey);
  if (!startSpanKey || !endSpanKey) return null;

  return {
    startSpanKey,
    endSpanKey,
  };
}

/**
 * Convert timestamp-backed persisted blocks into span-key blocks at the
 * persistence boundary. Unresolved blocks are skipped conservatively so callers
 * can keep using the original v1 state until they deliberately switch runtime
 * materialization to the converted blocks.
 */
export function migrateLegacyCompressionBlocksToV2(
  blocks: CompressionBlock[],
  snapshot: TranscriptSnapshot
): CompressionBlockV2[] {
  const migratedBlocks: CompressionBlockV2[] = [];

  for (const block of blocks) {
    const spanRange = mapLegacyBlockToSpanRange(block, snapshot);
    if (!spanRange) continue;

    const existingMetadata = block.metadata ?? createEmptyCompressionBlockMetadata();
    const coveredSpanKeys =
      existingMetadata.coveredSpanKeys.length > 0
        ? existingMetadata.coveredSpanKeys
        : [spanRange.startSpanKey, spanRange.endSpanKey];

    migratedBlocks.push({
      id: block.id,
      topic: block.topic,
      summary: block.summary,
      startSpanKey: spanRange.startSpanKey,
      endSpanKey: spanRange.endSpanKey,
      status: block.active ? "active" : "decompressed",
      summaryTokenEstimate: block.summaryTokenEstimate,
      createdAt: block.createdAt,
      activityLogVersion: 1,
      activityLog: block.activityLog ?? [],
      metadata: {
        ...existingMetadata,
        coveredSpanKeys,
      },
    });
  }

  return migratedBlocks;
}

// ---------------------------------------------------------------------------
// Inactive-block slimming
// ---------------------------------------------------------------------------

/**
 * Reduce an inactive (decompressed / superseded) v1 block to the minimum
 * fields needed for future restore/repair.
 *
 * Runtime sites uniformly skip blocks with `active: false` (see
 * `domain/compression/tooling.ts`, `domain/provider/payload-filter.ts`,
 * `domain/transcript/index.ts`), and `repairOffBranchNativeCompactionState`
 * pulls a fully-populated copy from an earlier active-state snapshot when it
 * needs to reactivate — it never reads coverage metadata, activity logs, or
 * summaries from the inactive entry itself. So we can safely drop those fat
 * fields on serialize. Older snapshots on disk remain full-fidelity for tree
 * navigation; only newly-written entries are slim.
 */
function slimInactiveLegacyBlock(block: CompressionBlock): CompressionBlock {
  if (block.active) return block;

  return {
    id: block.id,
    topic: "",
    summary: "",
    startTimestamp: block.startTimestamp,
    endTimestamp: block.endTimestamp,
    anchorTimestamp: block.anchorTimestamp,
    active: false,
    summaryTokenEstimate: block.summaryTokenEstimate,
    savedTokenEstimate: block.savedTokenEstimate,
    createdAt: block.createdAt,
    metadata: {
      coveredSourceKeys: [],
      coveredSpanKeys: [],
      coveredArtifactRefs: [],
      coveredToolIds: [],
      supersededBlockIds: block.metadata?.supersededBlockIds ?? [],
      fileReadStats: [],
      fileWriteStats: [],
      commandStats: [],
    },
  };
}

/** Mirror of `slimInactiveLegacyBlock` for the v2 schema. */
function slimInactiveV2Block(block: CompressionBlockV2): CompressionBlockV2 {
  if (block.status === "active") return block;

  return {
    id: block.id,
    topic: "",
    summary: "",
    startSpanKey: block.startSpanKey,
    endSpanKey: block.endSpanKey,
    status: block.status,
    summaryTokenEstimate: block.summaryTokenEstimate,
    createdAt: block.createdAt,
    activityLogVersion: 1,
    activityLog: [],
    metadata: {
      coveredSourceKeys: [],
      coveredSpanKeys: [],
      coveredArtifactRefs: [],
      coveredToolIds: [],
      supersededBlockIds: block.metadata?.supersededBlockIds ?? [],
      fileReadStats: [],
      fileWriteStats: [],
      commandStats: [],
    },
  };
}

/**
 * Serialize runtime state into the tiny v3 marker shape.
 *
 * dcp-replay-v3 stops persisting compression blocks, messageAliases, and
 * derived statistics because they are reconstructed from the session
 * transcript by `replayDcpState`. Only scalar counters and the
 * `prunedToolIds` tombstone set are written: dedup/error-purge cadence
 * depends on `currentTurn` and the active tombstone set, which would be
 * costly to re-derive deterministically on every restore.
 *
 * Legacy v1/v2 fat snapshots are still tolerated by `restorePersistedState`,
 * but new writes are always tiny.
 */
export function serializePersistedState(state: DcpState): PersistedDcpState {
  const persisted: PersistedDcpStateV3 = {
    schemaVersion: 3,
    savedAt: Date.now(),
    currentTurn: state.currentTurn,
    lastNudgeTurn: state.lastNudgeTurn,
    lastCompressTurn: state.lastCompressTurn,
    prunedToolIds: Array.from(state.prunedToolIds),
    lifetimeTokensSavedRealized: state.lifetimeTokensSavedRealized,
  };
  return persisted;
}

/**
 * Serialize runtime state into the legacy v1 fat snapshot shape.
 *
 * Used by tests and by the retro vacuum tool (f6) when round-tripping old
 * sessions. Not called by the live runtime.
 */
export function serializeLegacyV1PersistedState(state: DcpState): PersistedDcpStateV1 {
  return {
    schemaVersion: 1,
    compressionBlocks: state.compressionBlocks.map(slimInactiveLegacyBlock),
    nextBlockId: state.nextBlockId,
    messageAliases: serializeMessageAliasState(state.messageAliases),
    prunedToolIds: Array.from(state.prunedToolIds),
    tokensSaved: state.tokensSaved,
    lifetimeTokensSavedRealized: state.lifetimeTokensSavedRealized,
    totalPruneCount: state.totalPruneCount,
    currentTurn: state.currentTurn,
    lastNudgeTurn: state.lastNudgeTurn,
    lastCompressTurn: state.lastCompressTurn,
  };
}

/**
 * Serialize runtime state into the legacy v2 fat snapshot shape.
 *
 * Used by tests and by the retro vacuum tool when round-tripping old v2
 * sessions. Not called by the live runtime.
 */
export function serializeLegacyV2PersistedState(state: DcpState): PersistedDcpStateV2 {
  return {
    schemaVersion: 2,
    blocks: state.compressionBlocksV2.map(slimInactiveV2Block),
    nextBlockId: state.nextBlockId,
    messageAliases: serializeMessageAliasState(state.messageAliases),
    currentTurn: state.currentTurn,
    lastNudgeTurn: state.lastNudgeTurn,
    lastCompressTurn: state.lastCompressTurn,
  };
}

/**
 * Restore one persisted DCP state entry into runtime state.
 *
 * The current runtime still executes legacy v1 blocks; v2 blocks are preserved
 * in `state.compressionBlocksV2` for future work but are not yet materialized.
 */
export function restorePersistedState(data: unknown, state: DcpState): void {
  const persisted = asObject(data);
  if (!persisted) return;

  // Offline maintenance can replace redundant snapshots with a tiny no-op
  // marker. Restore is cumulative over branch entries, so this means "keep the
  // state restored from the nearest previous DCP snapshot on this branch".
  if (persisted.unchanged === true) return;

  // v3 tiny marker shape (dcp-replay-v3 default for new writes).
  // Blocks/messageAliases/tokensSaved are reconstructed by replay; only the
  // scalars and tombstone set are persisted here.
  if (persisted.schemaVersion === 3) {
    if (Array.isArray(persisted.prunedToolIds)) {
      state.prunedToolIds = new Set(
        persisted.prunedToolIds.filter((value): value is string => typeof value === "string")
      );
    }
    if (isFiniteNumber(persisted.lifetimeTokensSavedRealized)) {
      state.lifetimeTokensSavedRealized = persisted.lifetimeTokensSavedRealized;
    }
    if (isFiniteNumber(persisted.currentTurn)) {
      state.currentTurn = persisted.currentTurn;
    }
    if (isFiniteNumber(persisted.lastNudgeTurn)) {
      state.lastNudgeTurn = persisted.lastNudgeTurn;
    }
    if (isFiniteNumber(persisted.lastCompressTurn)) {
      state.lastCompressTurn = persisted.lastCompressTurn;
    }
    return;
  }

  if (persisted.schemaVersion === 2 || Array.isArray(persisted.blocks)) {
    const blocks = Array.isArray(persisted.blocks)
      ? persisted.blocks.map(normalizeV2Block).filter((b): b is CompressionBlockV2 => b !== null)
      : [];

    state.schemaVersion = 2;
    state.compressionBlocks = [];
    state.compressionBlocksV2 = blocks;
    state.nextBlockId = isFiniteNumber(persisted.nextBlockId)
      ? persisted.nextBlockId
      : blocks.length > 0
        ? Math.max(0, ...blocks.map((b) => b.id)) + 1
        : 1;
    state.messageAliases = normalizeMessageAliasState(persisted.messageAliases);

    // manualMode field was removed in dcp-replay-v3; ignore if present in
    // legacy persisted entries.
    if (isFiniteNumber(persisted.currentTurn)) {
      state.currentTurn = persisted.currentTurn;
    }
    if (isFiniteNumber(persisted.lastNudgeTurn)) {
      state.lastNudgeTurn = persisted.lastNudgeTurn;
    }
    if (isFiniteNumber(persisted.lastCompressTurn)) {
      state.lastCompressTurn = persisted.lastCompressTurn;
    }

    return;
  }

  const blocks = Array.isArray(persisted.compressionBlocks)
    ? persisted.compressionBlocks
        .map(normalizeLegacyBlock)
        .filter((b): b is CompressionBlock => b !== null)
    : [];

  state.schemaVersion = 1;
  state.compressionBlocks = blocks;
  state.compressionBlocksV2 = [];
  state.nextBlockId = isFiniteNumber(persisted.nextBlockId)
    ? persisted.nextBlockId
    : blocks.length > 0
      ? Math.max(0, ...blocks.map((b) => b.id)) + 1
      : 1;
  state.messageAliases = normalizeMessageAliasState(persisted.messageAliases);
  state.tokensSaved = isFiniteNumber(persisted.tokensSaved) ? persisted.tokensSaved : 0;
  state.lifetimeTokensSavedRealized = isFiniteNumber(persisted.lifetimeTokensSavedRealized)
    ? persisted.lifetimeTokensSavedRealized
    : 0;
  state.totalPruneCount = isFiniteNumber(persisted.totalPruneCount) ? persisted.totalPruneCount : 0;

  if (Array.isArray(persisted.prunedToolIds)) {
    state.prunedToolIds = new Set(
      persisted.prunedToolIds.filter((value): value is string => typeof value === "string")
    );
  }

  // manualMode field was removed in dcp-replay-v3; ignore if present in
  // legacy persisted entries.
  if (isFiniteNumber(persisted.currentTurn)) {
    state.currentTurn = persisted.currentTurn;
  }
  if (isFiniteNumber(persisted.lastNudgeTurn)) {
    state.lastNudgeTurn = persisted.lastNudgeTurn;
  }
  if (isFiniteNumber(persisted.lastCompressTurn)) {
    state.lastCompressTurn = persisted.lastCompressTurn;
  }
}
