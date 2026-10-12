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
