// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — persisted state migration helpers
// ---------------------------------------------------------------------------

import {
  createEmptyCompressionBlockMetadata,
  type CompressionBlock,
  type CompressionBlockMetadata,
  type CompressionCommandStat,
  type CompressionFileReadStat,
  type CompressionFileWriteStat,
  type CompressionLogEntry,
  type DcpState,
  type PersistedCompressionBlockV4,
  type PersistedCompressionBlockV5,
  type PersistedDcpState,
  type PersistedDcpStateV1,
  type PersistedDcpStateV3,
  type PersistedDcpStateV4,
  type PersistedDcpStateV5,
} from "../state.js";
import { normalizeMessageAliasState, serializeMessageAliasState } from "../domain/refs/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function persistCompressionBlockV5(block: CompressionBlock): PersistedCompressionBlockV5 {
  if (!block.active) return slimInactiveLegacyBlock(block);

  return {
    ...block,
    startTimestamp: Number.isFinite(block.startTimestamp) ? block.startTimestamp : 0,
    endTimestamp: Number.isFinite(block.endTimestamp) ? block.endTimestamp : 0,
    anchorTimestamp: Number.isFinite(block.anchorTimestamp)
      ? block.anchorTimestamp
      : Number.isFinite(block.endTimestamp)
        ? block.endTimestamp + 1
        : 0,
    startSourceKey: block.startSourceKey ?? null,
    endSourceKey: block.endSourceKey ?? null,
    anchorSourceKey: block.anchorSourceKey ?? null,
    active: true,
    activityLog: block.activityLog?.map((entry) => ({ ...entry })),
    metadata: {
      ...(block.metadata ?? createEmptyCompressionBlockMetadata()),
      coveredSourceKeys: [...(block.metadata?.coveredSourceKeys ?? [])],
      coveredSpanKeys: [...(block.metadata?.coveredSpanKeys ?? [])],
      coveredArtifactRefs: [...(block.metadata?.coveredArtifactRefs ?? [])],
      coveredToolIds: [...(block.metadata?.coveredToolIds ?? [])],
      supersededBlockIds: [...(block.metadata?.supersededBlockIds ?? [])],
      fileReadStats: (block.metadata?.fileReadStats ?? []).map((stat) => ({
        ...stat,
        lineSpans: [...stat.lineSpans],
      })),
      fileWriteStats: (block.metadata?.fileWriteStats ?? []).map((stat) => ({ ...stat })),
      commandStats: (block.metadata?.commandStats ?? []).map((stat) => ({ ...stat })),
    },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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

function persistCompressionBlockV4(block: CompressionBlock): PersistedCompressionBlockV4 {
  return {
    id: block.id,
    topic: block.topic,
    summary: block.summary,
    active: block.active,
    createdAt: block.createdAt,
    savedTokenEstimate: block.savedTokenEstimate ?? 0,
    summaryTokenEstimate: block.summaryTokenEstimate,
    compressCallId: block.compressCallId,
    supersededBlockIds: block.metadata?.supersededBlockIds ?? [],
  };
}

function normalizePersistedCompressionBlockV4(value: unknown): CompressionBlock | null {
  const block = asObject(value);
  if (!block) return null;

  if (
    !isFiniteNumber(block.id) ||
    typeof block.topic !== "string" ||
    typeof block.summary !== "string"
  ) {
    return null;
  }

  return {
    id: block.id,
    topic: block.topic,
    summary: block.summary,
    startTimestamp: Infinity,
    endTimestamp: Infinity,
    anchorTimestamp: Infinity,
    active: typeof block.active === "boolean" ? block.active : true,
    summaryTokenEstimate: isFiniteNumber(block.summaryTokenEstimate)
      ? block.summaryTokenEstimate
      : 0,
    savedTokenEstimate: isFiniteNumber(block.savedTokenEstimate) ? block.savedTokenEstimate : 0,
    createdAt: isFiniteNumber(block.createdAt) ? block.createdAt : Date.now(),
    compressCallId: typeof block.compressCallId === "string" ? block.compressCallId : undefined,
    metadata: {
      ...createEmptyCompressionBlockMetadata(),
      supersededBlockIds: Array.isArray(block.supersededBlockIds)
        ? block.supersededBlockIds.filter(isFiniteNumber)
        : [],
    },
  };
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

/**
 * Serialize runtime state into the current direct-restore shape.
 *
 * Empty sessions keep the tiny v3 scalar marker. Once blocks exist, v5 carries
 * active block coverage and anchors so resume can restore without replay.
 */
export function serializePersistedState(state: DcpState): PersistedDcpState {
  const scalars = {
    savedAt: Date.now(),
    currentTurn: state.currentTurn,
    lastNudgeTurn: state.lastNudgeTurn,
    lastCompressTurn: state.lastCompressTurn,
    prunedToolIds: Array.from(state.prunedToolIds),
    lifetimeTokensSavedRealized: state.lifetimeTokensSavedRealized,
  };

  if (state.compressionBlocks.length === 0) {
    const persisted: PersistedDcpStateV3 = {
      schemaVersion: 3,
      ...scalars,
    };
    return persisted;
  }

  const persisted: PersistedDcpStateV5 = {
    schemaVersion: 5,
    ...scalars,
    blocks: state.compressionBlocks.map(persistCompressionBlockV5),
    nextBlockId: state.nextBlockId,
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

function restorePersistedScalars(persisted: Record<string, unknown>, state: DcpState): void {
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
}

/**
 * Restore only the scalar bootstrap (prunedToolIds, turn watermarks, realized
 * lifetime savings) from a persisted DCP state entry, never blocks. Used by
 * direct-restore to recover scalar continuity from a v3 scalar snapshot when no
 * coverage-bearing entry exists on the branch.
 */
export function restorePersistedStateScalars(data: unknown, state: DcpState): void {
  const persisted = asObject(data);
  if (!persisted || persisted.unchanged === true) return;
  restorePersistedScalars(persisted, state);
}

export function restorePersistedState(data: unknown, state: DcpState): void {
  const persisted = asObject(data);
  if (!persisted) return;

  // Offline maintenance can replace redundant snapshots with a tiny no-op
  // marker. Restore is cumulative over branch entries, so this means "keep the
  // state restored from the nearest previous DCP snapshot on this branch".
  if (persisted.unchanged === true) return;

  // v5 direct-restore state. Active blocks carry exact coverage, anchors, and
  // finite timestamp fallbacks, so live resume does not need replay.
  if (persisted.schemaVersion === 5) {
    const blocks = Array.isArray(persisted.blocks)
      ? persisted.blocks.map(normalizeLegacyBlock).filter((b): b is CompressionBlock => b !== null)
      : [];

    restorePersistedScalars(persisted, state);
    state.schemaVersion = 1;
    state.compressionBlocks = blocks;
    state.nextBlockId = isFiniteNumber(persisted.nextBlockId)
      ? persisted.nextBlockId
      : blocks.length > 0
        ? Math.max(0, ...blocks.map((b) => b.id)) + 1
        : 1;
    state.tokensSaved = blocks
      .filter((block) => block.active)
      .reduce((sum, block) => sum + (block.savedTokenEstimate ?? 0), 0);
    return;
  }

  // v4 scalar bootstrap plus a light legacy-block list. Heavy coverage/log
  // metadata is intentionally not persisted; restored blocks are still useful
  // to native compaction tier rendering across restarts.
  if (persisted.schemaVersion === 4) {
    const blocks = Array.isArray(persisted.blocks)
      ? persisted.blocks
          .map(normalizePersistedCompressionBlockV4)
          .filter((b): b is CompressionBlock => b !== null)
      : [];

    restorePersistedScalars(persisted, state);
    state.schemaVersion = 1;
    state.compressionBlocks = blocks;
    state.nextBlockId = isFiniteNumber(persisted.nextBlockId)
      ? persisted.nextBlockId
      : blocks.length > 0
        ? Math.max(0, ...blocks.map((b) => b.id)) + 1
        : 1;
    state.tokensSaved = blocks
      .filter((block) => block.active)
      .reduce((sum, block) => sum + (block.savedTokenEstimate ?? 0), 0);
    return;
  }

  // v3 tiny marker shape (dcp-replay-v3 default for empty/new writes).
  // Blocks/messageAliases/tokensSaved are reconstructed by replay; only the
  // scalars and tombstone set are persisted here.
  if (persisted.schemaVersion === 3) {
    restorePersistedScalars(persisted, state);
    return;
  }

  const blocks = Array.isArray(persisted.compressionBlocks)
    ? persisted.compressionBlocks
        .map(normalizeLegacyBlock)
        .filter((b): b is CompressionBlock => b !== null)
    : [];

  state.schemaVersion = 1;
  state.compressionBlocks = blocks;
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
