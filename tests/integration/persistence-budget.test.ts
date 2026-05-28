// ---------------------------------------------------------------------------
// Integration test: dcp-state JSONL persistence budget (f4).
// ---------------------------------------------------------------------------
//
// Empty states still write the tiny v3 scalar marker. Once compression blocks
// exist, v4 persists a light block list so block records survive restarts while
// dropping heavyweight coverage/log/stat metadata.

import { describe, expect, test } from "bun:test";
import { serializePersistedState } from "../../src/infrastructure/persistence.js";
import type { CompressionBlock, DcpState } from "../../src/types/state.js";
import { createEmptyCompressionBlockMetadata } from "../../src/domain/compression/metadata.js";
import { makeState } from "../helpers/dcp-test-utils.js";

const EMPTY_STATE_BUDGET_BYTES = 4096;
const POPULATED_STATE_BUDGET_BYTES = 30_000;
const PER_BLOCK_BUDGET_BYTES = 300;

function makeFatBlock(id: number, active: boolean): CompressionBlock {
  return {
    id,
    topic: `topic ${id}`,
    summary: `summary ${id} with preserved block context`,
    startTimestamp: 1000 + id,
    endTimestamp: 2000 + id,
    anchorTimestamp: 1500 + id,
    startSourceKey: `src-${id}-start`,
    endSourceKey: `src-${id}-end`,
    anchorSourceKey: `src-${id}-anchor`,
    active,
    summaryTokenEstimate: 500,
    savedTokenEstimate: active ? 2000 : 0,
    createdAt: 1000 + id,
    compressCallId: `call-${id}`,
    activityLogVersion: 1,
    activityLog: Array.from({ length: 20 }, (_, i) => ({
      kind: "command" as const,
      text: `command ${i} for block ${id} with some descriptive content`,
    })),
    metadata: {
      ...createEmptyCompressionBlockMetadata(),
      coveredSourceKeys: Array.from({ length: 30 }, (_, i) => `src-${id}-${i}`),
      coveredSpanKeys: Array.from({ length: 10 }, (_, i) => `span-${id}-${i}`),
      coveredArtifactRefs: Array.from({ length: 15 }, (_, i) => `art-${id}-${i}`),
      coveredToolIds: Array.from({ length: 25 }, (_, i) => `tool-${id}-${i}`),
      supersededBlockIds: [],
      fileReadStats: Array.from({ length: 5 }, (_, i) => ({
        path: `/repo/file-${id}-${i}.ts`,
        count: 1,
        lineSpans: [`L${i}-L${i + 10}`],
      })),
      fileWriteStats: [],
      commandStats: Array.from({ length: 8 }, (_, i) => ({
        command: `bun run script-${id}-${i}`,
        status: "ok" as const,
      })),
    },
  };
}

function serializedByteLength(state: DcpState): number {
  return Buffer.byteLength(JSON.stringify(serializePersistedState(state)), "utf8");
}

describe("dcp-state persistence budget (f4)", () => {
  test("empty live state writes a tiny v3 marker", () => {
    const state = makeState();
    const persisted = serializePersistedState(state) as { schemaVersion: number };

    expect(persisted.schemaVersion).toBe(3);
    expect(serializedByteLength(state)).toBeLessThan(EMPTY_STATE_BUDGET_BYTES);
  });

  test("100 compression blocks persist only bounded light metadata", () => {
    const state = makeState();
    state.compressionBlocks = Array.from({ length: 100 }, (_, i) => makeFatBlock(i + 1, true));
    state.nextBlockId = 101;
    state.tokensSaved = 200_000;

    const bytes = serializedByteLength(state);
    expect(bytes).toBeLessThan(POPULATED_STATE_BUDGET_BYTES);
    expect(bytes / state.compressionBlocks.length).toBeLessThan(PER_BLOCK_BUDGET_BYTES);

    const persisted = JSON.parse(JSON.stringify(serializePersistedState(state)));
    expect(persisted.schemaVersion).toBe(4);
    expect(persisted.blocks).toHaveLength(100);
    expect(persisted.compressionBlocks).toBeUndefined();
    expect(persisted.messageAliases).toBeUndefined();
    expect(persisted.tokensSaved).toBeUndefined();

    const sample = persisted.blocks[0];
    expect(sample.id).toBe(1);
    expect(sample.topic).toBe("topic 1");
    expect(sample.summary).toBe("summary 1 with preserved block context");
    expect(sample.active).toBe(true);
    expect(sample.metadata).toBeUndefined();
    expect(sample.activityLog).toBeUndefined();
    expect(sample.coveredSourceKeys).toBeUndefined();
    expect(sample.fileReadStats).toBeUndefined();
    expect(sample.commandStats).toBeUndefined();
  });

  test("100 mixed active/inactive blocks stay under the v4 budget", () => {
    const state = makeState();
    state.compressionBlocks = Array.from({ length: 100 }, (_, i) =>
      makeFatBlock(i + 1, i % 3 === 0)
    );
    state.nextBlockId = 101;
    state.tokensSaved = 5_000_000;
    state.lifetimeTokensSavedRealized = 12_000_000;

    expect(serializedByteLength(state)).toBeLessThan(POPULATED_STATE_BUDGET_BYTES);
  });

  test("massive messageAliases registry is not persisted", () => {
    const state = makeState();
    for (let i = 0; i < 500; i++) {
      const ref = `m${String(i).padStart(4, "0")}`;
      const src = `src-key-${i}-with-some-extra-length-to-bloat-the-record`;
      state.messageAliases.bySourceKey.set(src, ref);
      state.messageAliases.byRef.set(ref, src);
    }
    state.messageAliases.nextRef = 500;

    expect(serializedByteLength(state)).toBeLessThan(EMPTY_STATE_BUDGET_BYTES);
  });

  test("scalars + modest prunedToolIds round-trip in the tiny shape", () => {
    const state = makeState();
    state.currentTurn = 175;
    state.lastNudgeTurn = 170;
    state.lastCompressTurn = 172;
    state.lifetimeTokensSavedRealized = 850_000;
    for (let i = 0; i < 50; i++) state.prunedToolIds.add(`call-${i}`);

    const persisted = serializePersistedState(state) as {
      schemaVersion: number;
      currentTurn: number;
      lastNudgeTurn: number;
      lastCompressTurn: number;
      prunedToolIds: string[];
      lifetimeTokensSavedRealized: number;
    };

    expect(persisted.schemaVersion).toBe(3);
    expect(persisted.currentTurn).toBe(175);
    expect(persisted.lastNudgeTurn).toBe(170);
    expect(persisted.lastCompressTurn).toBe(172);
    expect(persisted.prunedToolIds.length).toBe(50);
    expect(persisted.lifetimeTokensSavedRealized).toBe(850_000);
    expect(serializedByteLength(state)).toBeLessThan(EMPTY_STATE_BUDGET_BYTES);
  });

  test("prunedToolIds at realistic steady-state (~200 ids) stays under budget", () => {
    // prunedToolIds is the one persisted field that scales with session age:
    // dedup/error-purge tombstones accumulate until covered by a compression
    // block. Compression sweeps clear them by removing the underlying tool
    // result. Steady-state is well under 200 tombstones for typical sessions.
    const state = makeState();
    for (let i = 0; i < 200; i++) {
      // Tool call IDs from the host runtime are typically <= 40 chars.
      state.prunedToolIds.add(`call-${i.toString().padStart(6, "0")}`);
    }
    expect(serializedByteLength(state)).toBeLessThan(EMPTY_STATE_BUDGET_BYTES);
  });
});
