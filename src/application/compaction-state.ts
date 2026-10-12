import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DcpState } from "../types/state.js";
import { buildTranscriptSnapshot } from "../domain/transcript/index.js";

/** Reconcile a committed cut, or normalize restored coverage into the current projection. */
export function reconcileCompactedBlocks(
  state: DcpState,
  branch: SessionEntry[],
  compactionId?: string
): number[] {
  const index = compactionId ? branch.findIndex((e) => e.id === compactionId) : -1;
  if (compactionId && index < 0) return [];
  const before = index < 0 ? branch : branch.slice(0, index);
  const after = index < 0 ? branch : branch.slice(0, index + 1);
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
  // Older v5 blocks were minted from the full branch, even after prior cuts.
  // Resolve those keys through entry provenance rather than treating shifted ordinals as lost source.
  const lineage: { message: any; entryId: string }[] = [];
  for (const entry of before as any[]) {
    if (entry.type === "message") lineage.push({ message: entry.message, entryId: entry.id });
    else if (entry.type === "custom_message")
      lineage.push({
        message: {
          role: "custom_message",
          content: entry.content,
          timestamp: Date.parse(entry.timestamp),
        },
        entryId: entry.id,
      });
    else if (entry.type === "compaction" || entry.type === "branch_summary") {
      lineage.push({
        message: {
          role: entry.type,
          content: entry.summary,
          timestamp: Date.parse(entry.timestamp),
        },
        entryId: entry.id,
      });
      for (const message of entry.retainedTail ?? []) lineage.push({ message, entryId: entry.id });
    }
  }
  const legacyItems = buildTranscriptSnapshot(lineage.map((item) => item.message)).sourceItems;
  for (const [i, item] of legacyItems.entries()) {
    if (!newKeyByOldKey.has(item.key))
      newKeyByOldKey.set(item.key, newKeyByEntry.get(lineage[i].entryId));
  }
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
