import { describe, expect, test } from "bun:test";
import { registerSessionHandlers, saveState } from "../../src/application/session-handler.js";
import {
  restorePersistedState,
  serializePersistedState,
  serializeLegacyV1PersistedState,
} from "../../src/infrastructure/persistence.js";
import type { CompressionBlock } from "../../src/types/state.js";
import { makeConfig, makeState } from "../helpers/dcp-test-utils.js";

function block(active: boolean): CompressionBlock {
  return {
    id: 1,
    topic: "branch block",
    summary: "branch summary",
    startTimestamp: 1000,
    endTimestamp: 1000,
    anchorTimestamp: 1001,
    active,
    summaryTokenEstimate: 10,
    savedTokenEstimate: active ? 100 : 0,
    createdAt: 1000,
  };
}

function dcpStateEntry(
  data: unknown,
  id: string = crypto.randomUUID(),
  parentId: string | null = null
): any {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType: "dcp-state",
    data,
  };
}

function nativeCompactionEntry(
  representedBlockIds: number[],
  id: string = crypto.randomUUID()
): any {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    summary: "DCP native compaction",
    firstKeptEntryId: "kept-entry",
    tokensBefore: 1000,
    fromHook: true,
    details: {
      source: "dcp-native-compaction",
      representedBlockIds,
    },
  };
}

describe("DCP session handler", () => {
  test("session_tree restores DCP state from the newly selected branch", async () => {
    const state = makeState([block(false)]);
    state.nextBlockId = 2;
    state.tokensSaved = 0;

    const branchState = makeState([block(true)]);
    branchState.nextBlockId = 2;
    branchState.tokensSaved = 100;

    const handlers = new Map<string, any>();
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
    };
    const ctx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [dcpStateEntry(serializeLegacyV1PersistedState(branchState))],
        getEntries: () => [dcpStateEntry(serializeLegacyV1PersistedState(branchState))],
        getSessionId: () => "session-test",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/session.jsonl",
        getLeafId: () => "leaf-before-native-compaction",
      },
    };

    registerSessionHandlers(pi as any, state, makeConfig());
    await handlers.get("session_tree")(
      {
        type: "session_tree",
        oldLeafId: "after-native-compaction",
        newLeafId: "leaf-before-native-compaction",
      },
      ctx
    );

    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.active).toBe(true);
    expect(state.tokensSaved).toBe(100);
  });

  test("session_start repairs stale inactive state saved after leaving a native compaction branch", async () => {
    const activeState = makeState([block(true)]);
    activeState.nextBlockId = 2;
    activeState.tokensSaved = 100;

    const staleInactiveState = makeState([block(false)]);
    staleInactiveState.nextBlockId = 2;
    staleInactiveState.tokensSaved = 0;

    const activeEntry = dcpStateEntry(serializeLegacyV1PersistedState(activeState), "active-state");
    const staleEntry = dcpStateEntry(
      serializeLegacyV1PersistedState(staleInactiveState),
      "stale-state",
      "active-state"
    );
    const offBranchCompaction = nativeCompactionEntry([1], "native-compaction");
    const state = makeState();
    const handlers = new Map<string, any>();
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
    };
    const ctx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [activeEntry, staleEntry],
        getEntries: () => [activeEntry, staleEntry, offBranchCompaction],
        getSessionId: () => "session-test",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/session.jsonl",
        getLeafId: () => "stale-state",
      },
    };

    registerSessionHandlers(pi as any, state, makeConfig());
    await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.active).toBe(true);
    expect(state.tokensSaved).toBe(100);
  });

  test("session_start uses scalar replay when native compaction is on the active branch", async () => {
    const inactiveState = makeState([block(false)]);
    inactiveState.nextBlockId = 2;
    inactiveState.tokensSaved = 0;

    const compaction = nativeCompactionEntry([1], "native-compaction");
    const inactiveEntry = dcpStateEntry(
      serializeLegacyV1PersistedState(inactiveState),
      "inactive-state",
      "native-compaction"
    );
    const state = makeState();
    const handlers = new Map<string, any>();
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
    };
    const ctx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [compaction, inactiveEntry],
        getEntries: () => [compaction, inactiveEntry],
        getSessionId: () => "session-test",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/session.jsonl",
        getLeafId: () => "inactive-state",
      },
    };

    registerSessionHandlers(pi as any, state, makeConfig());
    await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

    expect(state.replayPending).toBe(true);
    expect(state.compressionBlocks).toHaveLength(0);
    expect(state.tokensSaved).toBe(0);
  });

  test("session_start resets stale nudge watermarks when branch contains a DCP native compaction", async () => {
    // Simulate a session that compacted under buggy code: lastCompressTurn /
    // lastNudgeTurn were persisted at high pre-compaction values, and a DCP
    // native compaction entry sits on the active branch. Repair must reset.
    const staleState = makeState([block(false)]);
    staleState.nextBlockId = 2;
    staleState.tokensSaved = 0;
    staleState.lastCompressTurn = 80;
    staleState.lastNudgeTurn = 80;

    const compaction = nativeCompactionEntry([1], "native-compaction");
    const staleEntry = dcpStateEntry(
      serializeLegacyV1PersistedState(staleState),
      "stale-state",
      "native-compaction"
    );
    const state = makeState();
    const handlers = new Map<string, any>();
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
    };
    const ctx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [compaction, staleEntry],
        getEntries: () => [compaction, staleEntry],
        getSessionId: () => "session-test",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/session.jsonl",
        getLeafId: () => "stale-state",
      },
    };

    registerSessionHandlers(pi as any, state, makeConfig());
    await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

    expect(state.lastCompressTurn).toBe(-1);
    expect(state.lastNudgeTurn).toBe(-1);
  });

  test("session_start leaves nudge watermarks alone when branch has no DCP native compaction", async () => {
    // Pre-compaction session: watermarks set, no compaction on branch yet.
    // Should NOT be reset; debounce should keep working normally.
    const liveState = makeState([block(true)]);
    liveState.lastCompressTurn = 25;
    liveState.lastNudgeTurn = 25;

    const liveEntry = dcpStateEntry(serializeLegacyV1PersistedState(liveState), "live-state", null);
    const state = makeState();
    const handlers = new Map<string, any>();
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
    };
    const ctx = {
      hasUI: false,
      sessionManager: {
        getBranch: () => [liveEntry],
        getEntries: () => [liveEntry],
        getSessionId: () => "session-test",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/session.jsonl",
        getLeafId: () => "live-state",
      },
    };

    registerSessionHandlers(pi as any, state, makeConfig());
    await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

    expect(state.lastCompressTurn).toBe(25);
    expect(state.lastNudgeTurn).toBe(25);
  });

  test("serializeLegacyV1PersistedState slims inactive blocks", () => {
    const fatActive: CompressionBlock = {
      id: 1,
      topic: "alpha",
      summary: "long summary text",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 1500,
      startSourceKey: "src-a",
      endSourceKey: "src-b",
      anchorSourceKey: "src-c",
      active: true,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 100,
      createdAt: 1000,
      compressCallId: "call-1",
      activityLogVersion: 1,
      activityLog: [{ kind: "command", text: "echo hi" }],
      metadata: {
        coveredSourceKeys: ["src-a", "src-b"],
        coveredSpanKeys: ["span-a"],
        coveredArtifactRefs: ["art-1", "art-2"],
        coveredToolIds: ["tool-1"],
        supersededBlockIds: [],
        fileReadStats: [{ path: "a.ts", count: 1, lineSpans: ["L1-3"] }],
        fileWriteStats: [],
        commandStats: [{ command: "echo hi", status: "ok" }],
      },
    };

    const fatInactive: CompressionBlock = {
      ...fatActive,
      id: 2,
      topic: "beta",
      active: false,
      compressCallId: "call-2",
    };

    const state = makeState([fatActive, fatInactive]);
    const serialized = serializeLegacyV1PersistedState(state);

    const [serActive, serInactive] = serialized.compressionBlocks;
    if (!serActive || !serInactive) throw new Error("expected both blocks");

    // active block round-trips fully
    expect(serActive.topic).toBe("alpha");
    expect(serActive.summary).toBe("long summary text");
    expect(serActive.metadata?.coveredSourceKeys.length).toBe(2);
    expect(serActive.metadata?.coveredArtifactRefs.length).toBe(2);
    expect(serActive.activityLog?.length).toBe(1);

    // inactive block is slimmed: id + structural fields kept, fat fields dropped
    expect(serInactive.id).toBe(2);
    expect(serInactive.active).toBe(false);
    expect(serInactive.topic).toBe("");
    expect(serInactive.summary).toBe("");
    expect(serInactive.metadata?.coveredSourceKeys).toEqual([]);
    expect(serInactive.metadata?.coveredSpanKeys).toEqual([]);
    expect(serInactive.metadata?.coveredArtifactRefs).toEqual([]);
    expect(serInactive.metadata?.coveredToolIds).toEqual([]);
    expect(serInactive.metadata?.fileReadStats).toEqual([]);
    expect(serInactive.metadata?.fileWriteStats).toEqual([]);
    expect(serInactive.metadata?.commandStats).toEqual([]);
    expect(serInactive.activityLog).toBeUndefined();
    expect(serInactive.compressCallId).toBeUndefined();
  });

  test("restorePersistedState treats unchanged markers as no-ops", () => {
    const state = makeState([block(true)]);
    state.nextBlockId = 2;
    state.tokensSaved = 100;

    restorePersistedState({ schemaVersion: 1, unchanged: true }, state);

    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.active).toBe(true);
    expect(state.nextBlockId).toBe(2);
    expect(state.tokensSaved).toBe(100);
  });

  test("saveState is a no-op when pendingSave is false and consumes the flag when true", () => {
    const state = makeState([block(true)]);
    state.pendingSave = false;

    const appended: unknown[] = [];
    const pi: any = { appendEntry: (_kind: string, data: unknown) => appended.push(data) };
    const config = makeConfig();
    const debugPayload = { sessionId: "s1", leafEntryId: "l1" };

    // Clean state → skipped.
    saveState(pi, state, config, "agent_end", debugPayload);
    expect(appended.length).toBe(0);
    expect(state.pendingSave).toBe(false);

    // Mutation flips the flag.
    state.pendingSave = true;
    saveState(pi, state, config, "agent_end", debugPayload);
    expect(appended.length).toBe(1);
    expect(state.pendingSave).toBe(false);

    // Second call without further mutations is skipped again.
    saveState(pi, state, config, "agent_end", debugPayload);
    expect(appended.length).toBe(1);
  });
});
