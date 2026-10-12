import {
  buildSessionProjection,
  type ExtensionAPI,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { DcpConfig } from "../types/config.js";
import type { DcpState } from "../types/state.js";
import { buildTranscriptSnapshot } from "../domain/transcript/index.js";
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.js";
import { saveState } from "./session-handler.js";
import { updateDcpStatus } from "./status.js";

/** Retire any block losing source at Pi's cut; rebase surviving keys into the kept projection. */
export function reconcileCompactedBlocks(
  state: DcpState,
  branch: SessionEntry[],
  compactionId: string
): number[] {
  const index = branch.findIndex((e) => e.id === compactionId);
  if (index < 0) return [];
  const before = branch.slice(0, index);
  const after = branch.slice(0, index + 1);
  const oldProjection = buildSessionProjection(before);
  const newProjection = buildSessionProjection(after);
  const oldItems = buildTranscriptSnapshot(oldProjection.messages as any[]).sourceItems;
  const newSnapshot = buildTranscriptSnapshot(newProjection.messages as any[]);
  const newItems = newSnapshot.sourceItems;
  const oldEntryIds = oldProjection.entries.flatMap((e) => e.messages.map(() => e.sourceEntry.id));
  const newEntryIds = newProjection.entries.flatMap((e) => e.messages.map(() => e.sourceEntry.id));
  const newKeyByEntry = new Map(newItems.map((item, i) => [newEntryIds[i], item.key]));
  const newKeyByOldKey = new Map(
    oldItems.map((item, i) => [item.key, newKeyByEntry.get(oldEntryIds[i])])
  );
  // Preserve visible IDs for kept messages despite ordinal-dependent source keys.
  const keptAliases = [...state.messageAliases.bySourceKey].flatMap(([key, ref]) => {
    const next = newKeyByOldKey.get(key);
    return next ? [[next, ref] as const] : [];
  });
  for (const [key, ref] of keptAliases) {
    state.messageAliases.bySourceKey.set(key, ref);
    state.messageAliases.byRef.set(ref, key);
  }
  const retired: number[] = [];
  for (const block of state.compressionBlocks) {
    if (!block.active) continue;
    const exact = block.metadata?.coveredSourceKeys ?? [];
    const covered = exact.length
      ? exact
      : oldItems
          .filter(
            (i) =>
              i.timestamp !== null &&
              i.timestamp >= block.startTimestamp &&
              i.timestamp <= block.endTimestamp
          )
          .map((i) => i.key);
    const mapped = covered.map((key) => newKeyByOldKey.get(key));
    if (!covered.length || mapped.some((key) => !key)) {
      block.active = false;
      retired.push(block.id);
      state.lifetimeTokensSavedRealized = Math.max(
        0,
        (state.lifetimeTokensSavedRealized ?? 0) + (block.savedTokenEstimate ?? 0)
      );
      continue;
    }
    if (block.metadata) {
      block.metadata.coveredSourceKeys = mapped as string[];
      const keptKeys = new Set(mapped);
      block.metadata.coveredSpanKeys = newSnapshot.spans
        .filter((span) => span.sourceKeys.every((key) => keptKeys.has(key)))
        .map((span) => span.key);
    }
    block.startSourceKey = mapped[0];
    block.endSourceKey = mapped[mapped.length - 1];
    // The insertion anchor is placement, not coverage. If it vanished, place after the retained range.
    block.anchorSourceKey = block.anchorSourceKey?.startsWith("tail:")
      ? block.anchorSourceKey
      : (newKeyByOldKey.get(block.anchorSourceKey ?? "") ??
        newItems[newItems.findIndex((i) => i.key === block.endSourceKey) + 1]?.key ??
        "tail:compaction");
  }
  state.tokensSaved = state.compressionBlocks
    .filter((b) => b.active)
    .reduce((sum, b) => sum + (b.savedTokenEstimate ?? 0), 0);
  return retired;
}

/** Pi alone summarizes; only a committed compaction mutates DCP state. */
export function registerDcpNativeCompactionBridge(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig
): void {
  pi.on("session_compact", async (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const retiredBlockIds = reconcileCompactedBlocks(state, branch, event.compactionEntry.id);
    state.lastCompressTurn = -1;
    state.lastNudgeTurn = -1;
    state.pendingSave = true;
    appendDebugLog(config, "native_compaction_committed", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      retiredBlockIds,
      firstKeptEntryId: event.compactionEntry.firstKeptEntryId,
      remainingActiveCompressionBlockCount: state.compressionBlocks.filter((b) => b.active).length,
      tokensSavedAfter: state.tokensSaved,
    });
    if (ctx.hasUI) updateDcpStatus(ctx, state);
    saveState(pi, state, config, "native_compaction", buildSessionDebugPayload(ctx.sessionManager));
  });
}
