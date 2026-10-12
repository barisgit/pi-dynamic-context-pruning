import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { DcpState } from "../types/state.js";
import { buildTranscriptSnapshot } from "../domain/transcript/index.js";

/** Keep entry provenance distinct when a host entry expands to multiple projected messages. */
export function getProjectedSourceEntryIds(
  projection: ReturnType<typeof buildSessionProjection>
): string[] {
  return projection.entries.flatMap((e) =>
    e.messages.map((_, index) =>
      e.messages.length === 1 ? e.sourceEntry.id : `${e.sourceEntry.id}:${index}`
    )
  );
}

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
  const oldEntryIds = getProjectedSourceEntryIds(oldProjection);
  const newEntryIds = getProjectedSourceEntryIds(newProjection);
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
  const legacyEntryByKey = new Map(legacyItems.map((item, i) => [item.key, lineage[i].entryId]));
  // Do not merge ordinal namespaces: repeated timestamps can make identical keys
  // name different entries. Ambiguous old aliases expire instead of targeting new source.
  const keptAliases = [...state.messageAliases.bySourceKey].flatMap(([key, ref]) => {
    const current = newKeyByOldKey.get(key);
    const legacy = newKeyByEntry.get(legacyEntryByKey.get(key) ?? "");
    if (legacyEntryByKey.has(key) && newKeyByOldKey.has(key) && legacy !== current) return [];
    const next = current ?? legacy;
    return next ? [[next, ref] as const] : [];
  });
  state.messageAliases.bySourceKey = new Map(keptAliases);
  state.messageAliases.byRef = new Map(keptAliases.map(([key, ref]) => [ref, key]));
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
    const provenance = block.metadata?.coveredSourceEntryIds;
    // Released historical coverage used full lineage; accept predecessor projected
    // keys only when no lineage key conflicts. New provenance removes this ambiguity.
    const entryIds =
      provenance ??
      covered.map((key) =>
        exact.length && legacyEntryByKey.has(key)
          ? legacyEntryByKey.get(key)
          : oldEntryIds[oldItems.findIndex((item) => item.key === key)]
      );
    const mapped = entryIds.map((id) => newKeyByEntry.get(id ?? ""));
    if (!covered.length || mapped.length !== covered.length || mapped.some((key) => !key)) {
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
      block.metadata.coveredSourceEntryIds = entryIds as string[];
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
      : ((provenance
          ? newKeyByOldKey.get(block.anchorSourceKey ?? "")
          : newKeyByEntry.get(legacyEntryByKey.get(block.anchorSourceKey ?? "") ?? "")) ??
        newItems[newItems.findIndex((i) => i.key === block.endSourceKey) + 1]?.key ??
        "tail:compaction");
  }
  state.tokensSaved = state.compressionBlocks
    .filter((b) => b.active)
    .reduce((sum, b) => sum + (b.savedTokenEstimate ?? 0), 0);
  return retired;
}
