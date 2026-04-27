import { describe, expect, test } from "bun:test";
import {
  mapLegacyBlockToSpanRange,
  migrateLegacyCompressionBlocksToV2,
} from "../../src/infrastructure/persistence.js";
import { buildTranscriptSnapshot } from "../../src/domain/transcript/index.js";
import type { CompressionBlock } from "../../src/types/state.js";
import { createEmptyCompressionBlockMetadata } from "../../src/state.js";
import { makeMessages } from "../helpers/dcp-test-utils.js";

function makeLegacyBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    id: 4,
    topic: "legacy topic",
    summary: "legacy summary",
    startTimestamp: 2000,
    endTimestamp: 3000,
    anchorTimestamp: 4000,
    active: true,
    summaryTokenEstimate: 42,
    savedTokenEstimate: 1000,
    createdAt: 123,
    activityLogVersion: 1,
    activityLog: [{ kind: "tool", text: "read output" }],
    metadata: {
      ...createEmptyCompressionBlockMetadata(),
      coveredSourceKeys: ["source-a"],
      coveredToolIds: ["toolu_abc"],
    },
    ...overrides,
  };
}

describe("persistence migration helpers", () => {
  test("maps a legacy timestamp block to the containing v2 span range", () => {
    const snapshot = buildTranscriptSnapshot(makeMessages());
    const legacyBlock = makeLegacyBlock();

    const spanRange = mapLegacyBlockToSpanRange(legacyBlock, snapshot);

    expect(spanRange).toEqual({
      startSpanKey: snapshot.spans[1]!.key,
      endSpanKey: snapshot.spans[1]!.key,
    });
  });

  test("converts legacy blocks into v2 blocks while preserving persisted fields", () => {
    const snapshot = buildTranscriptSnapshot(makeMessages());
    const legacyBlock = makeLegacyBlock();

    const migrated = migrateLegacyCompressionBlocksToV2([legacyBlock], snapshot);

    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({
      id: legacyBlock.id,
      topic: legacyBlock.topic,
      summary: legacyBlock.summary,
      startSpanKey: snapshot.spans[1]!.key,
      endSpanKey: snapshot.spans[1]!.key,
      status: "active",
      summaryTokenEstimate: legacyBlock.summaryTokenEstimate,
      createdAt: legacyBlock.createdAt,
      activityLogVersion: 1,
      activityLog: legacyBlock.activityLog,
    });
    expect(migrated[0]!.metadata.coveredSourceKeys).toEqual(["source-a"]);
    expect(migrated[0]!.metadata.coveredToolIds).toEqual(["toolu_abc"]);
    expect(migrated[0]!.metadata.coveredSpanKeys).toEqual([
      snapshot.spans[1]!.key,
      snapshot.spans[1]!.key,
    ]);
  });

  test("skips unresolved legacy blocks instead of inventing span coverage", () => {
    const snapshot = buildTranscriptSnapshot(makeMessages());
    const unresolved = makeLegacyBlock({ startTimestamp: 123456, endTimestamp: 3000 });

    expect(migrateLegacyCompressionBlocksToV2([unresolved], snapshot)).toEqual([]);
  });

  test("marks inactive legacy blocks inactive in the v2 lifecycle", () => {
    const snapshot = buildTranscriptSnapshot(makeMessages());
    const inactive = makeLegacyBlock({ active: false });

    const migrated = migrateLegacyCompressionBlocksToV2([inactive], snapshot);

    expect(migrated[0]!.status).toBe("decompressed");
  });
});
