import { describe, expect, test } from "bun:test";
import { registerSessionHandlers } from "../../src/application/session-handler.js";
import { serializePersistedState } from "../../src/infrastructure/persistence.js";
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
        getBranch: () => [dcpStateEntry(serializePersistedState(branchState))],
        getEntries: () => [dcpStateEntry(serializePersistedState(branchState))],
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

    const activeEntry = dcpStateEntry(serializePersistedState(activeState), "active-state");
    const staleEntry = dcpStateEntry(
      serializePersistedState(staleInactiveState),
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

  test("session_start keeps inactive blocks when the native compaction is on the active branch", async () => {
    const inactiveState = makeState([block(false)]);
    inactiveState.nextBlockId = 2;
    inactiveState.tokensSaved = 0;

    const compaction = nativeCompactionEntry([1], "native-compaction");
    const inactiveEntry = dcpStateEntry(
      serializePersistedState(inactiveState),
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

    expect(state.compressionBlocks).toHaveLength(1);
    expect(state.compressionBlocks[0]?.active).toBe(false);
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
      serializePersistedState(staleState),
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

    const liveEntry = dcpStateEntry(serializePersistedState(liveState), "live-state", null);
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
});
