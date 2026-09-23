import { describe, expect, test } from "bun:test";
import { registerCompressTool } from "../../src/application/compress-tool/registration.js";
import { buildDcpNativeCompactionResult } from "../../src/application/native-compaction.js";
import { applyPruning } from "../../src/domain/pruning/index.js";
import { renderCompressedBlockText } from "../../src/domain/compression/materialize.js";
import {
  restorePersistedState,
  serializePersistedState,
} from "../../src/infrastructure/persistence.js";
import { makeConfig, makeState } from "../helpers/dcp-test-utils.js";

const messages = [
  {
    role: "user",
    content: [{ type: "text", text: "Original research ".repeat(80) }],
    timestamp: 1000,
  },
  {
    role: "user",
    content: [{ type: "text", text: "Earlier decision ".repeat(80) }],
    timestamp: 2000,
  },
  { role: "user", content: [{ type: "text", text: "Current tail" }], timestamp: 3000 },
];

function harness() {
  const state = makeState();
  const config = makeConfig();
  config.compress.protectRecentTurns = 1;
  config.nativeCompaction.enabled = false;
  applyPruning(messages, state, config);
  let tool: any;
  const pi = {
    registerTool(value: any) {
      tool = value;
    },
    appendEntry() {},
  };
  const ctx = {
    sessionManager: {
      getSessionId: () => "consolidation-test",
      getCwd: () => "/tmp",
      getSessionDir: () => "/tmp",
      getSessionFile: () => "/tmp/consolidation-test.jsonl",
      getLeafId: () => null,
      getBranch: () => messages.map((message) => ({ type: "message", message })),
    },
    getContextUsage: () => ({ tokens: 0, contextWindow: 100_000 }),
    hasUI: false,
    ui: { notify() {} },
  };
  registerCompressTool(pi as any, state, config);
  const compress = (ranges: { startId: string; endId: string; summary: string }[]) =>
    tool.execute("call-consolidate", { topic: "Settled work", ranges }, undefined, undefined, ctx);
  const render = (s = state) => JSON.stringify(applyPruning(messages, s, config));
  return { state, config, compress, render };
}

describe("agent-authored block consolidation", () => {
  test("a single bN boundary rewrites the record without copying its old summary", async () => {
    const { state, config, compress, render } = harness();
    await compress([
      { startId: "m0001", endId: "m0002", summary: "OLD_RECORD_DETAIL ".repeat(60) },
    ]);
    const previous = state.compressionBlocks[0]!;
    const oldSummary = previous.summary;
    const before = render();
    await compress([
      {
        startId: "b1",
        endId: "b1",
        summary: "The decision changed; keep the revised permission boundary.",
      },
    ]);
    const next = state.compressionBlocks[1]!;
    const after = render();

    expect(previous.active).toBe(false);
    expect(previous.summary).toBe(oldSummary);
    expect(next.summary).toBe("The decision changed; keep the revised permission boundary.");
    expect(next.metadata?.supersededBlockIds).toEqual([1]);
    expect(next.metadata?.coveredSourceKeys).toEqual(previous.metadata?.coveredSourceKeys);
    expect(after).toContain("revised permission boundary");
    expect(after).not.toContain("OLD_RECORD_DETAIL");
    expect(after.length).toBeLessThan(before.length);
    expect(after).toContain("Current tail");

    const persisted = JSON.parse(JSON.stringify(serializePersistedState(state)));
    const restored = makeState();
    restorePersistedState(persisted, restored);
    expect(restored.compressionBlocks[1]?.summary).toBe(next.summary);
    expect(restored.compressionBlocks[1]?.metadata?.coveredSourceKeys).toEqual(
      next.metadata?.coveredSourceKeys
    );
    expect(render(restored)).toContain("revised permission boundary");
    expect(render(restored)).not.toContain("OLD_RECORD_DETAIL");
    expect(
      renderCompressedBlockText({ ...restored.compressionBlocks[1]!, detailLevel: "compact" })
    ).not.toContain("OLD_RECORD_DETAIL");

    config.nativeCompaction.enabled = true;
    const branchEntries: any[] = messages.map((message, index) => ({
      type: "message",
      timestamp: new Date(message.timestamp).toISOString(),
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
      message,
    }));
    const checkpoint = buildDcpNativeCompactionResult({
      state: restored,
      config,
      branchEntries,
      preparation: { firstKeptEntryId: "entry-2", tokensBefore: 10_000 },
      request: { id: "consolidated-checkpoint", reason: "host", requestedAt: 1 },
      handoff: "Continue with revised permission boundary.",
    });
    expect(checkpoint.summary).toContain("revised permission boundary");
    expect(checkpoint.summary).not.toContain("OLD_RECORD_DETAIL");
  });

  test("a range across blocks retires both children and renders only the replacement", async () => {
    const { state, compress, render } = harness();
    await compress([
      { startId: "m0001", endId: "m0001", summary: "FIRST_OLD_DETAIL ".repeat(40) },
      { startId: "m0002", endId: "m0002", summary: "SECOND_OLD_DETAIL ".repeat(40) },
    ]);
    const before = render();
    await compress([
      {
        startId: "b1",
        endId: "b2",
        summary: "Correction: use the newer verified outcome; retain permission limits.",
      },
    ]);
    const after = render();
    expect(state.compressionBlocks.map((block) => block.active)).toEqual([false, false, true]);
    expect(state.compressionBlocks[2]?.metadata?.supersededBlockIds).toEqual([1, 2]);
    expect(after).toContain("newer verified outcome");
    expect(after).not.toContain("FIRST_OLD_DETAIL");
    expect(after).not.toContain("SECOND_OLD_DETAIL");
    expect(after.length).toBeLessThan(before.length);
  });

  test("explicit inclusion requires one active fully covered block and is transactional", async () => {
    const { state, compress } = harness();
    await compress([{ startId: "m0001", endId: "m0001", summary: "First stored record" }]);
    await compress([{ startId: "m0002", endId: "m0002", summary: "Second stored record" }]);

    for (const summary of ["Missing (b999)", "Outside (b2)", "Duplicate (b1) (b1)"]) {
      await expect(compress([{ startId: "b1", endId: "b1", summary }])).rejects.toThrow(
        /must reference an active block fully covered/
      );
      expect(state.compressionBlocks.length).toBe(2);
      expect(state.compressionBlocks.every((block) => block.active)).toBe(true);
    }

    await compress([{ startId: "b1", endId: "b1", summary: "Quoted: (b1)" }]);
    expect(state.compressionBlocks[2]?.summary).toContain("First stored record");
    expect(state.compressionBlocks[2]?.summary).not.toContain("(b1)");
  });
});
