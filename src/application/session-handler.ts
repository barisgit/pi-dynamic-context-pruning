import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DcpConfig } from "../types/config.js";
import type { CompressionBlock, DcpState } from "../types/state.js";
import { createState, resetState } from "../state.js";
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.js";
import {
  restorePersistedState,
  restorePersistedStateScalars,
  serializePersistedState,
} from "../infrastructure/persistence.js";
import { updateDcpStatus } from "./status.js";

/** Apply config-derived baseline state before session hooks run. */
export function initializeSessionState(_state: DcpState, _config: DcpConfig): void {
  // No-op: manual mode was removed in dcp-replay-v3.
}

function isCoverageBearingDcpState(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  if ((data as { unchanged?: unknown }).unchanged === true) return false;
  const persisted = data as {
    schemaVersion?: unknown;
    compressionBlocks?: unknown;
    blocks?: unknown;
  };
  if (persisted.schemaVersion === 5) return Array.isArray(persisted.blocks);
  if (persisted.schemaVersion === 1 || persisted.schemaVersion === undefined) {
    return Array.isArray(persisted.compressionBlocks);
  }
  return false;
}

/**
 * Latest non-`unchanged` `dcp-state` entry regardless of whether it carries
 * blocks. Used to recover scalar continuity (tombstones, turn watermarks,
 * realized lifetime savings) for branches that never compressed and therefore
 * only ever wrote v3 scalar snapshots.
 */
function findLatestDcpStateEntry(branchEntries: readonly any[]): any | null {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (!isDcpStateEntry(entry)) continue;
    const data = entry.data as { unchanged?: unknown } | null | undefined;
    if (data && typeof data === "object" && data.unchanged === true) continue;
    return entry;
  }
  return null;
}

export type RestoreMode = "persisted";

/**
 * Concrete outcome of a restore pass, distinct from the single restore-path
 * name (`RestoreMode = "persisted"`). This is what makes a block-dropping
 * resume obvious in the log instead of hiding behind the reassuring word
 * "persisted":
 * - `restored-v{n}` — coverage-bearing entry restored full block state
 * - `reset-legacy-v4` — a lossy legacy v4 entry was the latest, so blocks were
 *   intentionally dropped and only scalar continuity was recovered (the scary
 *   case: this session HAD blocks that could not be restored)
 * - `scalar-v3` — a normal v3 scalar marker (never compressed; no blocks to drop)
 * - `scalar-legacy` — scalar-only continuity from some other non-coverage shape
 * - `empty` — no dcp-state entry to restore from
 */
export type RestoreOutcome =
  | `restored-v${number}`
  | "reset-legacy-v4"
  | "scalar-v3"
  | "scalar-legacy"
  | "empty";

interface RestoreStateFromBranchResult {
  branchEntryCount: number;
  restoredStateEntries: number;
  repairedBlockIds: number[];
  repairedNudgeWatermarks: boolean;
  mode: RestoreMode;
  restoreOutcome: RestoreOutcome;
  restoredSchemaVersion: number | null;
}

/** Read a persisted entry's schemaVersion, treating legacy (v1) omission as 1. */
function readPersistedSchemaVersion(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const version = (data as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === "number" ? version : null;
}

function isDcpStateEntry(entry: any): boolean {
  return entry?.type === "custom" && entry.customType === "dcp-state";
}

function getDcpNativeCompactionBlockIds(entry: any): number[] {
  if (entry?.type !== "compaction") return [];
  const details = entry.details;
  if (!details || typeof details !== "object") return [];
  if (details.source !== "dcp-native-compaction") return [];
  return Array.isArray(details.representedBlockIds)
    ? details.representedBlockIds.filter((id: unknown): id is number => typeof id === "number")
    : [];
}

function cloneCompressionBlock(block: CompressionBlock): CompressionBlock {
  return {
    ...block,
    activityLog: block.activityLog?.map((entry) => ({ ...entry })),
    metadata: block.metadata
      ? {
          coveredSourceKeys: [...block.metadata.coveredSourceKeys],
          coveredSpanKeys: [...block.metadata.coveredSpanKeys],
          coveredArtifactRefs: [...block.metadata.coveredArtifactRefs],
          coveredToolIds: [...block.metadata.coveredToolIds],
          supersededBlockIds: [...block.metadata.supersededBlockIds],
          fileReadStats: block.metadata.fileReadStats.map((stat) => ({
            ...stat,
            lineSpans: [...stat.lineSpans],
          })),
          fileWriteStats: block.metadata.fileWriteStats.map((stat) => ({ ...stat })),
          commandStats: block.metadata.commandStats.map((stat) => ({ ...stat })),
        }
      : undefined,
  };
}

function restoreSinglePersistedState(data: unknown, config: DcpConfig): DcpState {
  const restored = createState();
  initializeSessionState(restored, config);
  restorePersistedState(data, restored);
  return restored;
}

function collectNativeCompactedBlockIds(entries: readonly any[]): Set<number> {
  const ids = new Set<number>();
  for (const entry of entries) {
    for (const id of getDcpNativeCompactionBlockIds(entry)) ids.add(id);
  }
  return ids;
}

function branchHasDcpNativeCompaction(entries: readonly any[]): boolean {
  for (const entry of entries) {
    if (getDcpNativeCompactionBlockIds(entry).length > 0) return true;
  }
  return false;
}

/**
 * Repair stale nudge debounce watermarks left by sessions that compacted under
 * earlier DCP versions. Post-compaction pi rebuilds agent.state.messages so
 * countLogicalTurns returns a much smaller currentTurn than before compaction;
 * if lastCompressTurn/lastNudgeTurn still hold the pre-compaction values, the
 * `currentTurn <= lastCompressTurn` gate silences nudges indefinitely.
 *
 * Safe heuristic: if the active branch already contains a DCP-native
 * compaction entry, the watermarks must not be greater than the current
 * compactionEntry-aware turn count. We don't have a clean lower bound here,
 * so we reset to the initial sentinel (-1). This only reduces the debounce
 * window; it never falsely re-emits a nudge in the middle of a logical turn
 * because getNudgeType still requires the context threshold to be reached.
 */
function repairStaleNudgeWatermarks(branchEntries: readonly any[], state: DcpState): boolean {
  if (state.lastCompressTurn <= 0 && state.lastNudgeTurn <= 0) return false;
  if (!branchHasDcpNativeCompaction(branchEntries)) return false;
  state.lastCompressTurn = -1;
  state.lastNudgeTurn = -1;
  return true;
}

function repairOffBranchNativeCompactionState(
  branchEntries: readonly any[],
  allEntries: readonly any[],
  state: DcpState,
  config: DcpConfig
): number[] {
  const branchNativeIds = collectNativeCompactedBlockIds(branchEntries);
  const allNativeIds = collectNativeCompactedBlockIds(allEntries);
  const offBranchNativeIds = new Set(
    Array.from(allNativeIds).filter((id) => !branchNativeIds.has(id))
  );
  if (offBranchNativeIds.size === 0) return [];

  const inactiveCandidateIds = state.compressionBlocks
    .filter((block) => !block.active && offBranchNativeIds.has(block.id))
    .map((block) => block.id);
  if (inactiveCandidateIds.length === 0) return [];

  const repairedBlocks = new Map<number, CompressionBlock>();
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (!isDcpStateEntry(entry)) continue;

    const restored = restoreSinglePersistedState(entry.data, config);
    for (const block of restored.compressionBlocks) {
      if (!inactiveCandidateIds.includes(block.id)) continue;
      if (!block.active) continue;
      if (!repairedBlocks.has(block.id)) repairedBlocks.set(block.id, cloneCompressionBlock(block));
    }

    if (repairedBlocks.size === inactiveCandidateIds.length) break;
  }

  if (repairedBlocks.size === 0) return [];

  const repairedIds = Array.from(repairedBlocks.keys()).sort((a, b) => a - b);
  state.compressionBlocks = state.compressionBlocks.map((block) => {
    const repaired = repairedBlocks.get(block.id);
    return repaired ? repaired : block;
  });
  state.tokensSaved = state.compressionBlocks
    .filter((block) => block.active)
    .reduce((sum, block) => sum + (block.savedTokenEstimate ?? 0), 0);

  return repairedIds;
}

function directRestore(
  branchEntries: readonly any[],
  state: DcpState,
  config: DcpConfig,
  allEntries: readonly any[]
): {
  restoredStateEntries: number;
  repairedBlockIds: number[];
  repairedNudgeWatermarks: boolean;
  restoreOutcome: RestoreOutcome;
  restoredSchemaVersion: number | null;
} {
  resetState(state);
  initializeSessionState(state, config);

  // Latest-entry-wins: the most recent non-`unchanged` dcp-state snapshot
  // decides the resume, so a newer lossy v4 save is never silently skipped in
  // favour of older coverage. Scanning backward for the latest *coverage* entry
  // would restore stale blocks and mislabel the outcome whenever the newest
  // save was a lossy v4 written after an older v1/v5.
  const latestEntry = findLatestDcpStateEntry(branchEntries);
  let restoredStateEntries = 0;
  let restoreOutcome: RestoreOutcome = "empty";
  let restoredSchemaVersion: number | null = null;
  if (latestEntry) {
    restoredStateEntries = 1;
    restoredSchemaVersion = readPersistedSchemaVersion(latestEntry.data);
    if (isCoverageBearingDcpState(latestEntry.data)) {
      // Coverage-bearing snapshots (v1/v5) carry both block coverage and the
      // scalar bootstrap (prunedToolIds, turn watermarks, lifetime savings), so
      // a single direct restore reproduces the full runtime state.
      restorePersistedState(latestEntry.data, state);
      // Coverage entries omit schemaVersion only for legacy v1 fat snapshots.
      restoredSchemaVersion = restoredSchemaVersion ?? 1;
      restoreOutcome = `restored-v${restoredSchemaVersion}`;
    } else {
      // The latest snapshot carries no restorable coverage. A v4 entry here is a
      // lossy legacy snapshot that once held blocks we cannot restore, so this
      // resume drops them (reset-legacy-v4). A v3 entry is the normal
      // never-compressed marker with no blocks to lose. Either way we still
      // restore scalar continuity — dedup/error-purge tombstones, turn
      // watermarks, realized lifetime savings — so resume does not silently drop
      // tombstones or reset the nudge debounce. restorePersistedStateScalars
      // never resurrects blocks, so this stays safe for lossy v4 too.
      restorePersistedStateScalars(latestEntry.data, state);
      restoreOutcome =
        restoredSchemaVersion === 4
          ? "reset-legacy-v4"
          : restoredSchemaVersion === 3
            ? "scalar-v3"
            : "scalar-legacy";
    }
  }

  const repairedBlockIds = repairOffBranchNativeCompactionState(
    branchEntries,
    allEntries,
    state,
    config
  );

  const repairedNudgeWatermarks = repairStaleNudgeWatermarks(branchEntries, state);

  return {
    restoredStateEntries,
    repairedBlockIds,
    repairedNudgeWatermarks,
    restoreOutcome,
    restoredSchemaVersion,
  };
}

/**
 * Restore runtime state from the active branch.
 *
 * Direct-restore from the latest coverage-bearing persisted DCP snapshot.
 * v1/v5 entries carry enough block coverage to resume pruning immediately
 * (blocks plus scalar bootstrap). When no coverage-bearing entry exists the
 * branch never compressed, so blocks clean-reset to empty, but the latest v3
 * scalar snapshot still restores scalar continuity (tombstones, turn
 * watermarks, realized lifetime savings). Replay-on-resume is never triggered.
 */
export function restoreStateFromBranch(
  branchEntries: readonly any[],
  state: DcpState,
  config: DcpConfig,
  allEntries: readonly any[] = branchEntries
): RestoreStateFromBranchResult {
  const fallback = directRestore(branchEntries, state, config, allEntries);
  return {
    branchEntryCount: branchEntries.length,
    restoredStateEntries: fallback.restoredStateEntries,
    repairedBlockIds: fallback.repairedBlockIds,
    repairedNudgeWatermarks: fallback.repairedNudgeWatermarks,
    mode: "persisted",
    restoreOutcome: fallback.restoreOutcome,
    restoredSchemaVersion: fallback.restoredSchemaVersion,
  };
}

/**
 * Persist the current DCP runtime state as a custom session entry.
 *
 * No-op when `state.pendingSave` is false. Pi fires `agent_end` after every
 * assistant turn, and most of those turns make no material change to DCP
 * state — persisting on each one was the root cause of session JSONLs growing
 * to hundreds of MB. Mutation sites (compress success, prune tombstone
 * additions, native_compaction commit, manual mode toggle) set the dirty
 * flag; `saveState` consumes it.
 */
export function saveState(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
  reason: "session_shutdown" | "agent_end" | "native_compaction",
  sessionPayload: Record<string, unknown>
): void {
  if (!state.pendingSave) {
    appendDebugLog(config, "state_save_skipped", {
      ...sessionPayload,
      reason,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      nextBlockId: state.nextBlockId,
    });
    return;
  }

  pi.appendEntry("dcp-state", serializePersistedState(state));
  state.pendingSave = false;
  appendDebugLog(config, "state_saved", {
    ...sessionPayload,
    reason,
    activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
    nextBlockId: state.nextBlockId,
    totalPruneCount: state.totalPruneCount,
    tokensSaved: state.tokensSaved,
  });
}

/** Register DCP session lifecycle persistence handlers. */
export function registerSessionHandlers(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig
): void {
  pi.on("session_start", async (_event, ctx) => {
    const restore = restoreStateFromBranch(
      ctx.sessionManager.getBranch(),
      state,
      config,
      ctx.sessionManager.getEntries()
    );

    appendDebugLog(config, "session_start", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      branchEntryCount: restore.branchEntryCount,
      restoredStateEntries: restore.restoredStateEntries,
      repairedBlockIds: restore.repairedBlockIds,
      repairedNudgeWatermarks: restore.repairedNudgeWatermarks,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      nextBlockId: state.nextBlockId,
      restoreMode: restore.mode,
      restoreOutcome: restore.restoreOutcome,
      restoredSchemaVersion: restore.restoredSchemaVersion,
    });

    if (ctx.hasUI) updateDcpStatus(ctx, state);
  });

  pi.on("session_tree", async (event, ctx) => {
    const restore = restoreStateFromBranch(
      ctx.sessionManager.getBranch(),
      state,
      config,
      ctx.sessionManager.getEntries()
    );

    appendDebugLog(config, "session_tree_restored", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      oldLeafId: event.oldLeafId,
      newLeafId: event.newLeafId,
      branchEntryCount: restore.branchEntryCount,
      restoredStateEntries: restore.restoredStateEntries,
      repairedBlockIds: restore.repairedBlockIds,
      repairedNudgeWatermarks: restore.repairedNudgeWatermarks,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      nextBlockId: state.nextBlockId,
      restoreMode: restore.mode,
      restoreOutcome: restore.restoreOutcome,
      restoredSchemaVersion: restore.restoredSchemaVersion,
    });

    if (ctx.hasUI) updateDcpStatus(ctx, state);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    let hasUI: boolean;
    try {
      hasUI = ctx.hasUI;
    } catch {
      return;
    } // stale ctx after dispose (e.g. -p print mode)
    if (!hasUI) return;
    saveState(pi, state, config, "session_shutdown", buildSessionDebugPayload(ctx.sessionManager));
  });

  pi.on("agent_end", async (_event, ctx) => {
    let hasUI: boolean;
    try {
      hasUI = ctx.hasUI;
    } catch {
      return;
    } // stale ctx after dispose (e.g. -p print mode)
    if (!hasUI) return;
    saveState(pi, state, config, "agent_end", buildSessionDebugPayload(ctx.sessionManager));
  });
}
