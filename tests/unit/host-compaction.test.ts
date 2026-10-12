import { expect, test } from "bun:test";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { registerDcpNativeCompactionBridge } from "../../src/application/native-compaction.js";
import { buildTranscriptSnapshot } from "../../src/domain/transcript/index.js";
import {
  makeConfig,
  makeState,
  buildCompressionArtifactsForRange,
} from "../helpers/dcp-test-utils.js";

const entries = Array.from({ length: 6 }, (_, i) => ({
  type: "message",
  id: `e${i}`,
  parentId: i ? `e${i - 1}` : null,
  timestamp: new Date(1000 + i).toISOString(),
  message: { role: "user", content: `source ${i}`, timestamp: 1000 + i },
})) as any[];
function block(messages: any[], lo: number, hi: number, id: number): any {
  const keys = buildTranscriptSnapshot(messages).sourceItems.map((i) => i.key);
  return {
    id,
    active: true,
    topic: "record",
    summary: "historical record",
    startTimestamp: 1000 + lo,
    endTimestamp: 1000 + hi,
    startSourceKey: keys[lo],
    endSourceKey: keys[hi],
    anchorSourceKey: keys[hi + 1],
    savedTokenEstimate: 10,
    metadata: buildCompressionArtifactsForRange(messages, makeState(), 1000 + lo, 1000 + hi)
      .metadata,
  };
}
test("Pi owns summarization; commit retires hidden and straddling blocks, rebases retained coverage", async () => {
  const state = makeState([
    block(
      entries.map((e) => e.message),
      0,
      1,
      1
    ),
    block(
      entries.map((e) => e.message),
      2,
      4,
      2
    ),
    block(
      entries.map((e) => e.message),
      4,
      4,
      3
    ),
  ]);
  const handlers = new Map<string, any>();
  const saves: any[] = [];
  registerDcpNativeCompactionBridge(
    {
      on: (name: string, handler: any) => handlers.set(name, handler),
      appendEntry: (_name: string, data: any) => saves.push(data),
    } as any,
    state,
    makeConfig()
  );
  expect(handlers.has("session_before_compact")).toBe(false);
  expect(handlers.has("turn_end")).toBe(false);
  const compaction = {
    type: "compaction",
    id: "compact",
    parentId: "e5",
    firstKeptEntryId: "e3",
    summary: "Pi summary",
    timestamp: new Date(2000).toISOString(),
  };
  const branch = [...entries, compaction];
  await handlers.get("session_compact")(
    { compactionEntry: compaction },
    {
      hasUI: false,
      sessionManager: {
        getSessionId: () => "test",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => undefined,
        getBranch: () => branch,
        getLeafId: () => "compact",
      },
    }
  );
  expect(state.compressionBlocks.map((b) => b.active)).toEqual([false, false, true]);
  const liveKeys = new Set(
    buildTranscriptSnapshot(buildSessionContext(branch).messages as any[]).sourceItems.map(
      (i) => i.key
    )
  );
  const retained = state.compressionBlocks[2];
  expect(retained.metadata!.coveredSourceKeys.every((k) => liveKeys.has(k))).toBe(true);
  expect(liveKeys.has(retained.startSourceKey!)).toBe(true);
  expect(liveKeys.has(retained.anchorSourceKey!)).toBe(true);
  expect(state.tokensSaved).toBe(10);
  expect(state.lastCompressTurn).toBe(-1);
  expect(saves.length).toBe(1);
});

test("resume repairs a host commit that happened after the last persisted DCP snapshot", async () => {
  const { restoreStateFromBranch } = await import("../../src/application/session-handler.js");
  const { serializePersistedState } = await import("../../src/infrastructure/persistence.js");
  const state = makeState([
    block(
      entries.map((e) => e.message),
      0,
      1,
      1
    ),
    block(
      entries.map((e) => e.message),
      4,
      4,
      2
    ),
  ]);
  const snapshot = {
    type: "custom",
    customType: "dcp-state",
    id: "snapshot",
    parentId: "e5",
    timestamp: new Date(1500).toISOString(),
    data: serializePersistedState(state),
  };
  const compaction = {
    type: "compaction",
    id: "compact",
    parentId: "snapshot",
    firstKeptEntryId: "e3",
    summary: "Pi summary",
    timestamp: new Date(2000).toISOString(),
  };
  const branch = [...entries, snapshot, compaction] as any[];
  const restored = makeState();
  restoreStateFromBranch(branch, restored, makeConfig());
  expect(restored.compressionBlocks.map((b) => b.active)).toEqual([false, true]);
  const liveKeys = new Set(
    buildTranscriptSnapshot(buildSessionContext(branch).messages as any[]).sourceItems.map(
      (i) => i.key
    )
  );
  expect(
    restored.compressionBlocks[1].metadata!.coveredSourceKeys.every((k) => liveKeys.has(k))
  ).toBe(true);
  expect(restored.lastNudgeTurn).toBe(-1);
});

test("existing v5 full-lineage keys survive a second cut when coverage stays in the kept tail", async () => {
  const { reconcileCompactedBlocks } = await import("../../src/application/compaction-state.js");
  const previous = {
    type: "compaction",
    id: "prior",
    parentId: "e5",
    firstKeptEntryId: "e3",
    summary: "prior summary",
    timestamp: new Date(1500).toISOString(),
  };
  const branch = [
    ...entries,
    previous,
    {
      type: "message",
      id: "later",
      parentId: "prior",
      message: { role: "user", content: "later", timestamp: 1800 },
    },
    {
      type: "compaction",
      id: "next",
      parentId: "later",
      firstKeptEntryId: "e4",
      summary: "next summary",
      timestamp: new Date(2000).toISOString(),
    },
  ] as any[];
  const state = makeState([
    block(
      entries.map((e) => e.message),
      4,
      4,
      1
    ),
  ]);
  expect(reconcileCompactedBlocks(state, branch, "next")).toEqual([]);
  expect(state.compressionBlocks[0].active).toBe(true);
  const liveKeys = new Set(
    buildTranscriptSnapshot(buildSessionContext(branch).messages as any[]).sourceItems.map(
      (i) => i.key
    )
  );
  expect(state.compressionBlocks[0].metadata!.coveredSourceKeys.every((k) => liveKeys.has(k))).toBe(
    true
  );
});

test("legacy sibling repair cannot revive a block retired by this branch's host cut", async () => {
  const { restoreStateFromBranch } = await import("../../src/application/session-handler.js");
  const { serializePersistedState } = await import("../../src/infrastructure/persistence.js");
  const state = makeState([
    block(
      entries.map((e) => e.message),
      0,
      1,
      1
    ),
  ]);
  const before = {
    type: "custom",
    customType: "dcp-state",
    id: "before",
    parentId: "e5",
    data: serializePersistedState(state),
  };
  const compaction = {
    type: "compaction",
    id: "host",
    parentId: "before",
    firstKeptEntryId: "e3",
    summary: "Pi summary",
    timestamp: new Date(2000).toISOString(),
  };
  state.compressionBlocks[0].active = false;
  state.lifetimeTokensSavedRealized = 10;
  const after = {
    type: "custom",
    customType: "dcp-state",
    id: "after",
    parentId: "host",
    data: serializePersistedState(state),
  };
  const sibling = {
    type: "compaction",
    id: "sibling",
    parentId: "before",
    firstKeptEntryId: "e3",
    summary: "old DCP summary",
    details: { source: "dcp-native-compaction", representedBlockIds: [1] },
  };
  const branch = [...entries, before, compaction, after] as any[];
  const restored = makeState();
  restoreStateFromBranch(branch, restored, makeConfig(), [...branch, sibling]);
  expect(restored.compressionBlocks[0].active).toBe(false);
  expect(restored.lifetimeTokensSavedRealized).toBe(10);
});

test("shared timestamps cannot make a legacy hidden record delete unrelated kept source", async () => {
  const { restoreStateFromBranch } = await import("../../src/application/session-handler.js");
  const { serializePersistedState } = await import("../../src/infrastructure/persistence.js");
  const { applyPruning } = await import("../../src/domain/pruning/index.js");
  const raw = entries.map((entry, i) => ({
    ...entry,
    message: { role: "user", content: `SOURCE_${i}`, timestamp: 1000 },
  }));
  const snapshot = buildTranscriptSnapshot(raw.map((e) => e.message));
  const exactBlock = (index: number, id: number) => ({
    ...block(
      raw.map((e) => e.message),
      index,
      index,
      id
    ),
    startTimestamp: 1000,
    endTimestamp: 1000,
    summary: id === 1 ? "HIDDEN RECORD" : "KEPT RECORD",
    metadata: {
      ...block(
        raw.map((e) => e.message),
        index,
        index,
        id
      ).metadata,
      coveredSourceKeys: [snapshot.sourceItems[index].key],
      coveredSpanKeys: [snapshot.spans[index].key],
    },
  });
  const state = makeState([exactBlock(1, 1), exactBlock(3, 2)]);
  const cut = {
    type: "compaction",
    id: "cut",
    parentId: "e5",
    firstKeptEntryId: "e3",
    summary: "Pi summary",
    timestamp: new Date(2000).toISOString(),
  };
  const persisted = {
    type: "custom",
    customType: "dcp-state",
    id: "saved",
    parentId: "cut",
    data: serializePersistedState(state),
  };
  const branch = [...raw, cut, persisted] as any[];
  const restored = makeState();
  restoreStateFromBranch(branch, restored, makeConfig());
  expect(restored.compressionBlocks[0].active).toBe(false);
  expect(restored.compressionBlocks[1].active).toBe(true);
  const rendered = JSON.stringify(
    applyPruning(buildSessionContext(branch).messages as any[], restored, makeConfig())
  );
  expect(rendered).toContain("SOURCE_4");
  expect(rendered).toContain("SOURCE_5");
  expect(rendered).not.toContain("SOURCE_3");
  expect(rendered).not.toContain("HIDDEN RECORD");
  expect(rendered).toContain("KEPT RECORD");
});

test("new entry provenance survives serialization and repeated same-timestamp cuts without alias collisions", async () => {
  const { reconcileCompactedBlocks } = await import("../../src/application/compaction-state.js");
  const { serializePersistedState, restorePersistedState } =
    await import("../../src/infrastructure/persistence.js");
  const raw = entries.map((entry, i) => ({
    ...entry,
    message: { role: "user", content: `SOURCE_${i}`, timestamp: 1000 },
  }));
  const first = {
    type: "compaction",
    id: "first",
    parentId: "e5",
    firstKeptEntryId: "e3",
    summary: "Pi summary",
    timestamp: new Date(2000).toISOString(),
  };
  const before = [...raw, first] as any[];
  const snapshot = buildTranscriptSnapshot(buildSessionContext(before).messages as any[]);
  const currentBlock = block(
    raw.map((e) => e.message),
    5,
    5,
    1
  );
  currentBlock.startTimestamp = currentBlock.endTimestamp = 1000;
  currentBlock.metadata.coveredSourceKeys = [snapshot.sourceItems[3].key];
  currentBlock.metadata.coveredSpanKeys = [snapshot.spans[3].key];
  currentBlock.metadata.coveredSourceEntryIds = ["e5"];
  const state = makeState([currentBlock]);
  const restored = makeState();
  restorePersistedState(serializePersistedState(state), restored);
  expect(restored.compressionBlocks[0].metadata!.coveredSourceEntryIds).toEqual(["e5"]);
  restored.messageAliases.bySourceKey.set(snapshot.sourceItems[1].key, "m0002");
  restored.messageAliases.byRef.set("m0002", snapshot.sourceItems[1].key);
  const next = {
    type: "compaction",
    id: "next",
    parentId: "first",
    firstKeptEntryId: "e4",
    summary: "next Pi summary",
    timestamp: new Date(3000).toISOString(),
  };
  const after = [...before, next] as any[];
  expect(reconcileCompactedBlocks(restored, after, "next")).toEqual([]);
  expect(restored.compressionBlocks[0].active).toBe(true);
  expect(restored.compressionBlocks[0].metadata!.coveredSourceEntryIds).toEqual(["e5"]);
  expect(restored.compressionBlocks[0].metadata!.coveredSourceKeys).toEqual([
    buildTranscriptSnapshot(buildSessionContext(after).messages as any[]).sourceItems[2].key,
  ]);
  expect(restored.messageAliases.byRef.has("m0002")).toBe(false);
});
