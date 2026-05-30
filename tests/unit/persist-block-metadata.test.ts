import { describe, expect, test } from "bun:test";
import { restorePersistedState, serializePersistedState } from "../../src/infrastructure/persistence.js";
import { createEmptyCompressionBlockMetadata } from "../../src/domain/compression/metadata.js";
import type { CompressionBlock, PersistedDcpStateV5 } from "../../src/types/state.js";
import { makeState } from "../helpers/dcp-test-utils.js";

function block(overrides: Partial<CompressionBlock>): CompressionBlock {
  const id = overrides.id ?? 1;
  return {
    id,
    topic: `topic ${id}`,
    summary: `summary ${id}`,
    startTimestamp: 1000 + id,
    endTimestamp: 2000 + id,
    anchorTimestamp: 3000 + id,
    active: true,
    summaryTokenEstimate: 12 + id,
    savedTokenEstimate: 100 + id,
    createdAt: 4000 + id,
    compressCallId: `call-${id}`,
    metadata: {
      ...createEmptyCompressionBlockMetadata(),
      coveredSourceKeys: [`source-${id}`],
      coveredSpanKeys: [`span-${id}`],
      coveredArtifactRefs: [`artifact-${id}`],
      coveredToolIds: [`tool-${id}`],
      supersededBlockIds: [id - 1],
      fileReadStats: [{ path: `file-${id}.ts`, count: 1, lineSpans: ["L1-L2"] }],
      fileWriteStats: [{ path: `file-${id}.ts`, editCount: 1, addedLines: 2, removedLines: 0 }],
      commandStats: [{ command: `echo ${id}`, status: "ok" }],
    },
    ...overrides,
  };
}

describe("persisted block metadata v5", () => {
  test("round-trips mixed active and inactive block metadata", () => {
    const active = block({ id: 1, active: true, savedTokenEstimate: 250 });
    const inactive = block({ id: 2, active: false, savedTokenEstimate: 0, compressCallId: undefined });
    inactive.metadata = {
      ...createEmptyCompressionBlockMetadata(),
      supersededBlockIds: [1],
    };

    const state = makeState([active, inactive]);
    state.nextBlockId = 3;
    state.currentTurn = 42;
    state.lastNudgeTurn = 38;
    state.lastCompressTurn = 40;
    state.lifetimeTokensSavedRealized = 900;
    state.prunedToolIds.add("tool-a");

    const persisted = JSON.parse(JSON.stringify(serializePersistedState(state))) as PersistedDcpStateV5;

    expect(persisted.schemaVersion).toBe(5);
    expect(persisted.nextBlockId).toBe(3);
    expect(persisted.blocks).toHaveLength(2);
    const firstPersistedBlock = persisted.blocks[0] as unknown as Record<string, unknown>;
    expect(firstPersistedBlock.metadata).toBeDefined();
    expect(firstPersistedBlock.activityLog).toBeUndefined();
    expect((firstPersistedBlock.metadata as any).coveredSourceKeys).toEqual(["source-1"]);
    expect(persisted.blocks[0]?.metadata?.supersededBlockIds).toEqual([0]);
    expect(persisted.blocks[1]?.metadata?.supersededBlockIds).toEqual([1]);

    const restored = makeState();
    restorePersistedState(persisted, restored);

    expect(restored.nextBlockId).toBe(3);
    expect(restored.currentTurn).toBe(42);
    expect(restored.lastNudgeTurn).toBe(38);
    expect(restored.lastCompressTurn).toBe(40);
    expect(restored.lifetimeTokensSavedRealized).toBe(900);
    expect(Array.from(restored.prunedToolIds)).toEqual(["tool-a"]);
    expect(restored.tokensSaved).toBe(250);
    expect(restored.compressionBlocks).toHaveLength(2);

    for (const [index, original] of [active, inactive].entries()) {
      const actual = restored.compressionBlocks[index];
      expect(actual?.id).toBe(original.id);
      expect(actual?.topic).toBe(original.active ? original.topic : "");
      expect(actual?.summary).toBe(original.active ? original.summary : "");
      expect(actual?.active).toBe(original.active);
      expect(actual?.createdAt).toBe(original.createdAt);
      expect(actual?.savedTokenEstimate).toBe(original.savedTokenEstimate);
      expect(actual?.summaryTokenEstimate).toBe(original.summaryTokenEstimate);
      expect(actual?.compressCallId).toBe(original.active ? original.compressCallId : undefined);
      expect(actual?.metadata?.supersededBlockIds).toEqual(original.metadata?.supersededBlockIds);
      expect(actual?.metadata?.coveredSourceKeys).toEqual(original.active ? ["source-1"] : []);
      expect(actual?.metadata?.coveredSpanKeys).toEqual(original.active ? ["span-1"] : []);
      expect(actual?.metadata?.coveredArtifactRefs).toEqual(original.active ? ["artifact-1"] : []);
      expect(actual?.metadata?.coveredToolIds).toEqual(original.active ? ["tool-1"] : []);
      expect(actual?.metadata?.fileReadStats).toEqual(
        original.active ? [{ path: "file-1.ts", count: 1, lineSpans: ["L1-L2"] }] : []
      );
      expect(actual?.metadata?.fileWriteStats).toEqual(
        original.active ? [{ path: "file-1.ts", editCount: 1, addedLines: 2, removedLines: 0 }] : []
      );
      expect(actual?.metadata?.commandStats).toEqual(
        original.active ? [{ command: "echo 1", status: "ok" }] : []
      );
    }
  });

  test("empty state still serializes as the tiny v3 marker", () => {
    const state = makeState();
    const persisted = serializePersistedState(state) as { schemaVersion: number; blocks?: unknown[] };

    expect(persisted.schemaVersion).toBe(3);
    expect(persisted.blocks).toBeUndefined();
  });
});
