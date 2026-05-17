import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DcpConfig } from "../types/config.js";
import type { CompressionBlock, DcpState } from "../types/state.js";
import { createState, resetState } from "../state.js";
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.js";
import { restorePersistedState, serializePersistedState } from "../infrastructure/persistence.js";
import { updateDcpStatus } from "./status.js";

/** Apply config-derived baseline state before session hooks run. */
export function initializeSessionState(state: DcpState, config: DcpConfig): void {
  if (config.manualMode.enabled) {
    state.manualMode = true;
  }
}

interface RestoreStateFromBranchResult {
  branchEntryCount: number;
  restoredStateEntries: number;
  repairedBlockIds: number[];
  repairedNudgeWatermarks: boolean;
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

/** Restore runtime state from the active branch's persisted DCP entries. */
export function restoreStateFromBranch(
  branchEntries: readonly any[],
  state: DcpState,
  config: DcpConfig,
  allEntries: readonly any[] = branchEntries
): RestoreStateFromBranchResult {
  resetState(state);
  initializeSessionState(state, config);

  let restoredStateEntries = 0;
  for (const entry of branchEntries) {
    if (isDcpStateEntry(entry)) {
      restorePersistedState(entry.data, state);
      restoredStateEntries++;
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
    branchEntryCount: branchEntries.length,
    restoredStateEntries,
    repairedBlockIds,
    repairedNudgeWatermarks,
  };
}

/** Persist the current DCP runtime state as a custom session entry. */
export function saveState(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
  reason: "session_shutdown" | "agent_end" | "native_compaction",
  sessionPayload: Record<string, unknown>
): void {
  pi.appendEntry("dcp-state", serializePersistedState(state));
  appendDebugLog(config, "state_saved", {
    ...sessionPayload,
    reason,
    manualMode: state.manualMode,
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
      manualMode: state.manualMode,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      nextBlockId: state.nextBlockId,
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
      manualMode: state.manualMode,
      activeCompressionBlockCount: state.compressionBlocks.filter((block) => block.active).length,
      nextBlockId: state.nextBlockId,
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
