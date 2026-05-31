import { describe, expect, test } from "bun:test";
import {
  buildDcpFallbackCustomInstructions,
  buildDcpNativeCompactionResult,
  computeDcpHiddenCoverage,
  hasPendingDcpAutoNativeCompaction,
  queueDcpAutoNativeCompaction,
  registerDcpNativeCompactionBridge,
  triggerDcpNativeCompaction,
} from "../../src/application/native-compaction.js";
import {
  buildCompressionArtifactsForRange,
  makeConfig,
  makeState,
} from "../helpers/dcp-test-utils.js";
import type { CompressionBlock } from "../../src/types/state.js";

function messageEntry(id: string, message: any, parentId: string | null = null): any {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

describe("DCP native pi compaction bridge", () => {
  test("builds a pi compaction result from hidden DCP blocks and bounded raw gaps", () => {
    const messages: any[] = [
      {
        role: "user",
        content: [{ type: "text", text: "setup details that are already summarized" }],
        timestamp: 1000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "old uncovered note that still needs a bounded excerpt" }],
        timestamp: 2000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "recent tail stays raw" }],
        timestamp: 3000,
      },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);
    const block: CompressionBlock = {
      id: 1,
      topic: "Setup block",
      summary: "Setup summary with the durable decision.",
      startTimestamp: 1000,
      endTimestamp: 1000,
      anchorTimestamp: 1001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[1] ?? "tail:1000",
      active: true,
      summaryTokenEstimate: 12,
      savedTokenEstimate: 80,
      createdAt: 10,
      activityLogVersion: artifacts.activityLogVersion,
      activityLog: artifacts.activityLog,
      metadata: artifacts.metadata,
    };
    const state = makeState([block]);
    state.tokensSaved = 80;

    const result = buildDcpNativeCompactionResult({
      state,
      config: makeConfig(),
      branchEntries: [
        messageEntry("entry-setup", messages[0]),
        messageEntry("entry-gap", messages[1], "entry-setup"),
        messageEntry("entry-tail", messages[2], "entry-gap"),
      ],
      preparation: {
        firstKeptEntryId: "entry-tail",
        tokensBefore: 1234,
        previousSummary: "Previous pi summary.",
      },
      request: {
        id: "req-1",
        reason: "command",
        requestedAt: 42,
      },
    });

    expect(result.firstKeptEntryId).toBe("entry-tail");
    expect(result.tokensBefore).toBe(1234);
    expect(result.summary).toContain("Previous pi summary.");
    expect(result.summary).toContain('<section topic="Setup block">');
    expect(result.summary).toContain("Setup summary with the durable decision.");
    expect(result.summary).not.toContain("Uncompressed Hidden Transcript Excerpts");
    expect(result.summary).not.toContain("old uncovered note that still needs a bounded excerpt");
    expect(result.details?.representedBlockIds).toEqual([1]);
    expect(result.details?.uncoveredHiddenMessageCount).toBe(1);
  });

  test("moves firstKeptEntryId forward when pi's default cut would keep an active DCP block raw", () => {
    const messages: any[] = [
      {
        role: "user",
        content: [{ type: "text", text: "older setup" }],
        timestamp: 1000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "covered by dcp" }],
        timestamp: 2000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "tail after block" }],
        timestamp: 3000,
      },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 2000, 2000);
    const block: CompressionBlock = {
      id: 2,
      topic: "Covered middle",
      summary: "The middle message was summarized.",
      startTimestamp: 2000,
      endTimestamp: 2000,
      anchorTimestamp: 2001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[1] ?? "tail:2000",
      active: true,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 20,
      createdAt: 20,
      metadata: artifacts.metadata,
    };
    const result = buildDcpNativeCompactionResult({
      state: makeState([block]),
      config: makeConfig(),
      branchEntries: [
        messageEntry("entry-old", messages[0]),
        messageEntry("entry-covered", messages[1], "entry-old"),
        messageEntry("entry-tail", messages[2], "entry-covered"),
      ],
      preparation: {
        firstKeptEntryId: "entry-covered",
        tokensBefore: 500,
      },
      request: {
        id: "req-2",
        reason: "command",
        requestedAt: 42,
      },
    });

    expect(result.firstKeptEntryId).toBe("entry-tail");
    expect(result.summary).toContain('<section topic="Covered middle">');
    expect(result.details?.representedBlockIds).toEqual([2]);
  });

  test("handles any native compaction with DCP summaries when active DCP blocks exist", async () => {
    const messages: any[] = [
      {
        role: "user",
        content: [{ type: "text", text: "covered setup" }],
        timestamp: 1000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "raw tail" }],
        timestamp: 2000,
      },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);
    const block: CompressionBlock = {
      id: 3,
      topic: "Pending bridge",
      summary: "Covered setup summary.",
      startTimestamp: 1000,
      endTimestamp: 1000,
      anchorTimestamp: 1001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[1] ?? "tail:1000",
      active: true,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 20,
      createdAt: 30,
      metadata: artifacts.metadata,
    };
    const state = makeState([block]);
    const config = makeConfig();
    const handlers = new Map<string, any>();
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
    };
    const event = {
      branchEntries: [
        messageEntry("entry-covered", messages[0]),
        messageEntry("entry-tail", messages[1]),
      ],
      preparation: {
        firstKeptEntryId: "entry-tail",
        tokensBefore: 777,
      },
    };
    let compactCalled = false;
    const ctx = {
      hasUI: false,
      ui: { notify: () => undefined },
      compact: () => {
        compactCalled = true;
      },
      sessionManager: {
        getSessionId: () => "session-test",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/session.jsonl",
        getLeafId: () => "entry-tail",
      },
    };

    registerDcpNativeCompactionBridge(pi as any, state, config);
    const beforeCompact = handlers.get("session_before_compact");

    const hostOverride = await beforeCompact(event, ctx);
    expect(hostOverride.compaction.firstKeptEntryId).toBe("entry-tail");
    expect(hostOverride.compaction.details.reason).toBe("host");
    expect(hostOverride.compaction.details.representedBlockIds).toEqual([3]);

    triggerDcpNativeCompaction(ctx as any, state, "auto", [3]);
    expect(compactCalled).toBe(true);

    const autoOverride = await beforeCompact(event, ctx);
    expect(autoOverride.compaction.details.reason).toBe("auto");
    expect(autoOverride.compaction.details.requestedBlockIds).toEqual([3]);
  });

  test("auto native compaction fires fire-and-forget on turn_end and posts the resume prompt on session_compact", async () => {
    const messages: any[] = [
      {
        role: "user",
        content: [{ type: "text", text: "covered" }],
        timestamp: 1000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "tail" }],
        timestamp: 2000,
      },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);
    const block: CompressionBlock = {
      id: 4,
      topic: "Pending auto",
      summary: "Covered.",
      startTimestamp: 1000,
      endTimestamp: 1000,
      anchorTimestamp: 1001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[1] ?? "tail:1000",
      active: true,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 20,
      createdAt: 40,
      metadata: artifacts.metadata,
    };
    const state = makeState([block]);
    state.tokensSaved = 20;
    const config = makeConfig();
    const handlers = new Map<string, any>();
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
    };
    let compactCalled = false;
    let compactCompleteCb: any = null;
    const hasPendingMessages = false;
    const sentUserMessages: string[] = [];
    (pi as any).sendUserMessage = (content: string) => {
      sentUserMessages.push(content);
    };
    const ctx = {
      hasUI: false,
      ui: { notify: () => undefined },
      compact: (options: any) => {
        compactCalled = true;
        compactCompleteCb = options.onComplete;
      },
      hasPendingMessages: () => hasPendingMessages,
      sessionManager: {
        getSessionId: () => "s",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/s.jsonl",
        getLeafId: () => "entry-tail",
      },
    };

    registerDcpNativeCompactionBridge(pi as any, state, config);
    queueDcpAutoNativeCompaction(state, [4]);
    expect(hasPendingDcpAutoNativeCompaction(state)).toBe(true);

    const turnEnd = handlers.get("turn_end");
    const turnEndPromise = turnEnd({}, ctx);

    expect(compactCalled).toBe(true);
    expect(compactCompleteCb).not.toBeNull();
    // turn_end is fire-and-forget: it kicks compaction off and returns without
    // awaiting completion. Awaiting here would deadlock the live session, since
    // ctx.compact() can only finish after the current turn goes idle and
    // turn_end is part of that turn. The resume prompt is therefore NOT sent
    // from turn_end; firing onComplete only resolves trigger's internal promise
    // as the host eventually would.
    if (compactCompleteCb) compactCompleteCb({ firstKeptEntryId: "entry-tail" });
    await turnEndPromise;
    expect(sentUserMessages.length).toBe(0);

    // Single-shot: queue must be drained immediately so the next turn_end
    // does not re-fire compaction. This holds even before `session_compact`
    // arrives (it clears the queue redundantly as defence in depth).
    expect(hasPendingDcpAutoNativeCompaction(state)).toBe(false);

    // Simulate pre-compaction nudge watermarks; session_compact must reset them
    // so the post-compaction smaller logical-turn count does not silence nudges.
    state.lastCompressTurn = 80;
    state.lastNudgeTurn = 80;

    // session_compact event clears pending auto request
    const sessionCompact = handlers.get("session_compact");
    await sessionCompact(
      {
        compactionEntry: {
          details: {
            source: "dcp-native-compaction",
            version: 1,
            requestId: "x",
            reason: "auto",
            representedBlockIds: [4],
            requestedBlockIds: [4],
            firstKeptEntryId: "entry-tail",
            hiddenMessageCount: 0,
            uncoveredHiddenMessageCount: 0,
            renderedUncoveredExcerptCount: 0,
            truncatedUncoveredExcerptCount: 0,
            readFiles: [],
            modifiedFiles: [],
          },
        },
      },
      ctx
    );
    // The resume prompt is posted from session_compact (reason "auto"), only
    // after compaction has actually committed.
    expect(sentUserMessages.length).toBe(1);
    expect(sentUserMessages[0]).toContain("[dcp-auto-compaction]");
    expect(hasPendingDcpAutoNativeCompaction(state)).toBe(false);
    expect(state.compressionBlocks.find((b) => b.id === 4)?.active).toBe(false);
    expect(state.lastCompressTurn).toBe(-1);
    expect(state.lastNudgeTurn).toBe(-1);
    // Realized lifetime savings must absorb the represented block's estimate so
    // the displayed total does not appear to regress after compaction.
    expect(state.lifetimeTokensSavedRealized).toBe(20);
    expect(state.tokensSaved).toBe(0);
  });

  test("turn_end settles promptly even when ctx.compact never calls back (regression: uninterruptible hang)", async () => {
    // Production deadlock: pi's ctx.compact() is fire-and-forget (returns void)
    // and its internal `await session.compact()` only settles after the current
    // turn goes idle. turn_end IS the current turn, so if turn_end awaits
    // compaction completion, onComplete/onError can never fire -> the turn_end
    // promise never resolves -> Pi sits in an uninterruptible "Working...".
    // The pre-existing behavioral tests hide this by MANUALLY invoking
    // onComplete/onError. This mock NEVER calls back, mirroring the real host.
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "covered" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 2000 },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);
    const block: CompressionBlock = {
      id: 12,
      topic: "Deadlock guard",
      summary: "Covered.",
      startTimestamp: 1000,
      endTimestamp: 1000,
      anchorTimestamp: 1001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[1] ?? "tail:1000",
      active: true,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 20,
      createdAt: 40,
      metadata: artifacts.metadata,
    };
    const state = makeState([block]);
    const config = makeConfig();
    const handlers = new Map<string, any>();
    const sentUserMessages: string[] = [];
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
      sendUserMessage: (content: string) => {
        sentUserMessages.push(content);
      },
    };
    let compactCalled = false;
    const ctx = {
      hasUI: false,
      ui: { notify: () => undefined },
      // Fire-and-forget: never invokes onComplete/onError, exactly like the host
      // during an in-flight turn. A correct turn_end must NOT block on this.
      compact: () => {
        compactCalled = true;
      },
      hasPendingMessages: () => false,
      sessionManager: {
        getSessionId: () => "s",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/s.jsonl",
        getLeafId: () => "entry-tail",
      },
    };

    registerDcpNativeCompactionBridge(pi as any, state, config);
    queueDcpAutoNativeCompaction(state, [12]);

    const turnEnd = handlers.get("turn_end");
    const settled = Symbol("settled");
    const timedOut = Symbol("timedOut");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), 200);
    });
    const outcome = await Promise.race([
      Promise.resolve(turnEnd({}, ctx)).then(() => settled),
      timeoutPromise,
    ]);
    if (timer) clearTimeout(timer);

    // Compaction must still be kicked off...
    expect(compactCalled).toBe(true);
    // ...but turn_end must return without waiting for it to complete.
    expect(outcome).toBe(settled);
  });

  test("auto native compaction does NOT loop or send a resume prompt when compaction is cancelled", async () => {
    // Regression (two layered guards):
    //   1. `pendingAutoRequests` is drained up front in turn_end, so a
    //      cancelled compaction cannot leave the queue populated and re-fire on
    //      the next turn_end — the original infinite-loop bug.
    //   2. The resume prompt now lives in `session_compact`, which only fires
    //      when compaction actually COMMITS. A cancel/error never commits, so
    //      it reaches neither the prompt nor a re-trigger.
    // Lock both in: cancel must drain the queue and must not send a resume
    // prompt. (turn_end is fire-and-forget, so firing onError just resolves
    // trigger's internal promise; it does not gate any prompt here.)
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "covered" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 2000 },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);
    const block: CompressionBlock = {
      id: 5,
      topic: "Cancelled auto",
      summary: "Covered.",
      startTimestamp: 1000,
      endTimestamp: 1000,
      anchorTimestamp: 1001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[1] ?? "tail:1000",
      active: true,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 20,
      createdAt: 40,
      metadata: artifacts.metadata,
    };
    const state = makeState([block]);
    const config = makeConfig();
    const handlers = new Map<string, any>();
    const sentUserMessages: string[] = [];
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
      sendUserMessage: (content: string) => {
        sentUserMessages.push(content);
      },
    };
    let compactCallCount = 0;
    let onErrorCb: any = null;
    const ctx = {
      hasUI: false,
      ui: { notify: () => undefined },
      compact: (options: any) => {
        compactCallCount++;
        onErrorCb = options.onError;
      },
      hasPendingMessages: () => false,
      sessionManager: {
        getSessionId: () => "s",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/s.jsonl",
        getLeafId: () => "entry-tail",
      },
    };

    registerDcpNativeCompactionBridge(pi as any, state, config);
    queueDcpAutoNativeCompaction(state, [5]);

    const turnEnd = handlers.get("turn_end");
    const firstTurnEnd = turnEnd({}, ctx);
    // Simulate pi cancelling compaction.
    if (onErrorCb) onErrorCb(new Error("Compaction cancelled"));
    await firstTurnEnd;

    expect(compactCallCount).toBe(1);
    expect(sentUserMessages.length).toBe(0);
    expect(hasPendingDcpAutoNativeCompaction(state)).toBe(false);

    // The next turn_end must NOT re-fire compaction. This is the loop-bait
    // case the previous implementation was vulnerable to.
    await turnEnd({}, ctx);
    expect(compactCallCount).toBe(1);
    expect(sentUserMessages.length).toBe(0);
  });

  test("auto native compaction skips resume prompt when the user has pending input", async () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "covered" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 2000 },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);
    const block: CompressionBlock = {
      id: 9,
      topic: "Pending auto with user input",
      summary: "Covered.",
      startTimestamp: 1000,
      endTimestamp: 1000,
      anchorTimestamp: 1001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[1] ?? "tail:1000",
      active: true,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 20,
      createdAt: 40,
      metadata: artifacts.metadata,
    };
    const state = makeState([block]);
    const config = makeConfig();
    const handlers = new Map<string, any>();
    const sentUserMessages: string[] = [];
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
      sendUserMessage: (content: string) => {
        sentUserMessages.push(content);
      },
    };
    let compactCompleteCb: any = null;
    const ctx = {
      hasUI: false,
      ui: { notify: () => undefined },
      compact: (options: any) => {
        compactCompleteCb = options.onComplete;
      },
      // Simulate the user typing something while compaction was running. Pi
      // will deliver their input on the next turn, so DCP must not stack a
      // redundant continuation prompt on top of it.
      hasPendingMessages: () => true,
      sessionManager: {
        getSessionId: () => "s",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/s.jsonl",
        getLeafId: () => "entry-tail",
      },
    };

    registerDcpNativeCompactionBridge(pi as any, state, config);
    queueDcpAutoNativeCompaction(state, [9]);

    const turnEnd = handlers.get("turn_end");
    const turnEndPromise = turnEnd({}, ctx);
    if (compactCompleteCb) compactCompleteCb({ firstKeptEntryId: "entry-tail" });
    await turnEndPromise;

    // The pending-input gate now lives in session_compact, where the resume
    // prompt is posted. Drive a committed auto compaction and confirm the
    // prompt is suppressed because the user already has input queued.
    const sessionCompact = handlers.get("session_compact");
    await sessionCompact(
      {
        compactionEntry: {
          details: {
            source: "dcp-native-compaction",
            version: 1,
            requestId: "x",
            reason: "auto",
            representedBlockIds: [9],
            requestedBlockIds: [9],
            firstKeptEntryId: "entry-tail",
            hiddenMessageCount: 0,
            uncoveredHiddenMessageCount: 0,
            renderedUncoveredExcerptCount: 0,
            truncatedUncoveredExcerptCount: 0,
            readFiles: [],
            modifiedFiles: [],
          },
        },
      },
      ctx
    );

    expect(sentUserMessages.length).toBe(0);
  });

  test("manual /dcp compact does not auto-send a resume prompt", async () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "covered" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 2000 },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);
    const block: CompressionBlock = {
      id: 11,
      topic: "Manual command",
      summary: "Covered.",
      startTimestamp: 1000,
      endTimestamp: 1000,
      anchorTimestamp: 1001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[1] ?? "tail:1000",
      active: true,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 20,
      createdAt: 40,
      metadata: artifacts.metadata,
    };
    const state = makeState([block]);
    const config = makeConfig();
    const handlers = new Map<string, any>();
    const sentUserMessages: string[] = [];
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
      sendUserMessage: (content: string) => {
        sentUserMessages.push(content);
      },
    };
    let compactCompleteCb: any = null;
    const ctx = {
      hasUI: false,
      ui: { notify: () => undefined },
      compact: (options: any) => {
        compactCompleteCb = options.onComplete;
      },
      hasPendingMessages: () => false,
      sessionManager: {
        getSessionId: () => "s",
        getCwd: () => "/tmp",
        getSessionDir: () => "/tmp",
        getSessionFile: () => "/tmp/s.jsonl",
        getLeafId: () => "entry-tail",
      },
    };

    registerDcpNativeCompactionBridge(pi as any, state, config);

    // Manual `/dcp compact` triggers compaction with reason "command". The
    // resume prompt is gated on reason === "auto" in session_compact, so a
    // committed command compaction must NOT post a continuation prompt.
    const triggerPromise = triggerDcpNativeCompaction(ctx as any, state, "command");
    if (compactCompleteCb) compactCompleteCb({ firstKeptEntryId: "entry-tail" });
    await triggerPromise;

    const sessionCompact = handlers.get("session_compact");
    await sessionCompact(
      {
        compactionEntry: {
          details: {
            source: "dcp-native-compaction",
            version: 1,
            requestId: "x",
            reason: "command",
            representedBlockIds: [11],
            requestedBlockIds: [11],
            firstKeptEntryId: "entry-tail",
            hiddenMessageCount: 0,
            uncoveredHiddenMessageCount: 0,
            renderedUncoveredExcerptCount: 0,
            truncatedUncoveredExcerptCount: 0,
            readFiles: [],
            modifiedFiles: [],
          },
        },
      },
      ctx
    );

    expect(sentUserMessages.length).toBe(0);
  });

  test("session_before_compact returns undefined when hidden coverage is below the configured ratio", async () => {
    const hiddenMessages: any[] = [];
    for (let i = 0; i < 10; i++) {
      hiddenMessages.push({
        role: "user",
        content: [{ type: "text", text: `hidden ${i}` }],
        timestamp: 1000 + i,
      });
    }
    const tailMessage = {
      role: "user",
      content: [{ type: "text", text: "tail" }],
      timestamp: 2000,
    };
    // Only the first 2 hidden messages are represented by a DCP block (~20% coverage).
    const artifacts = buildCompressionArtifactsForRange(hiddenMessages, makeState(), 1000, 1001);
    const block: CompressionBlock = {
      id: 7,
      topic: "Partial coverage",
      summary: "Only the first two messages.",
      startTimestamp: 1000,
      endTimestamp: 1001,
      anchorTimestamp: 1002,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys.at(-1) ?? "",
      active: true,
      summaryTokenEstimate: 5,
      savedTokenEstimate: 20,
      createdAt: 50,
      metadata: artifacts.metadata,
    };
    const state = makeState([block]);
    const config = makeConfig();
    config.nativeCompaction.minHiddenCoverageRatio = 0.6;

    const branchEntries = [
      ...hiddenMessages.map((m, i) => messageEntry(`hidden-${i}`, m)),
      messageEntry("tail-entry", tailMessage),
    ];
    const coverage = computeDcpHiddenCoverage(state, branchEntries, "tail-entry");
    expect(coverage.hiddenMessageCount).toBe(10);
    expect(coverage.ratio).toBeLessThan(0.6);

    const handlers = new Map<string, any>();
    const pi = {
      on(event: string, handler: any) {
        handlers.set(event, handler);
      },
      appendEntry: () => undefined,
    };
    registerDcpNativeCompactionBridge(pi as any, state, config);
    const before = handlers.get("session_before_compact");
    const result = await before(
      {
        branchEntries,
        preparation: { firstKeptEntryId: "tail-entry", tokensBefore: 100 },
      },
      {
        sessionManager: {
          getSessionId: () => "s",
          getCwd: () => "/tmp",
          getSessionDir: () => "/tmp",
          getSessionFile: () => "/tmp/s.jsonl",
          getLeafId: () => "tail-entry",
        },
        hasUI: false,
        ui: { notify: () => undefined },
      }
    );
    expect(result).toBeUndefined();
  });

  test("buildDcpFallbackCustomInstructions emits authoritative block sections", () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "x" }], timestamp: 1000 },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);
    const block: CompressionBlock = {
      id: 9,
      topic: "Seed slice",
      summary: "Important seed summary text.",
      startTimestamp: 1000,
      endTimestamp: 1000,
      anchorTimestamp: 1001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[0],
      active: true,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 20,
      createdAt: 40,
      metadata: artifacts.metadata,
    };
    const state = makeState([block]);
    const text = buildDcpFallbackCustomInstructions(state);
    expect(text).toBeDefined();
    expect(text).toContain("Authoritative pre-compacted slices");
    expect(text).toContain('<block id="b9" topic="Seed slice">'); // customInstructions still uses block id for LLM seed clarity
    expect(text).toContain("Important seed summary text.");
  });

  test("tiers all blocks across compactions; suppresses DCP-shaped previousSummary; preserves non-DCP previousSummary", () => {
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "tail" }], timestamp: 2000 },
    ];
    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);
    const makeBlock = (id: number, active: boolean, createdAt: number): CompressionBlock => ({
      id,
      topic: `Topic ${id}`,
      summary: `Summary text for block ${id}. Detailed enough.`,
      startTimestamp: 1000,
      endTimestamp: 1000,
      anchorTimestamp: 1001,
      startSourceKey: artifacts.metadata.coveredSourceKeys[0],
      endSourceKey: artifacts.metadata.coveredSourceKeys.at(-1),
      anchorSourceKey: artifacts.metadata.coveredSourceKeys[0],
      active,
      summaryTokenEstimate: 10,
      savedTokenEstimate: 20,
      createdAt,
      metadata: artifacts.metadata,
    });
    // 6 historical (inactive) blocks + 1 new active covering the hidden span.
    const state = makeState([
      makeBlock(1, false, 10),
      makeBlock(2, false, 20),
      makeBlock(3, false, 30),
      makeBlock(4, false, 40),
      makeBlock(5, false, 50),
      makeBlock(6, false, 60),
      makeBlock(7, true, 70),
    ]);
    const config = makeConfig();
    config.compress.renderFullBlockCount = 2;
    config.compress.renderCompactBlockCount = 2;

    const buildArgs = (previousSummary: string | undefined) => ({
      state,
      config,
      branchEntries: [
        messageEntry("entry-old", messages[0]),
        messageEntry("entry-tail", messages[1], "entry-old"),
      ],
      preparation: {
        firstKeptEntryId: "entry-tail",
        tokensBefore: 1000,
        previousSummary,
      },
      request: { id: "req", reason: "command" as const, requestedAt: 1 },
    });

    // Case 1: DCP-shaped previous summary (inside dcp-summary envelope) should be stripped.
    const dcpPrev =
      '<dcp-summary version="1">\n<section topic="Old">old body</section>\n</dcp-summary>';
    const r1 = buildDcpNativeCompactionResult(buildArgs(dcpPrev));
    expect(r1.summary).not.toContain("old body");
    // Tier expectations: newest 2 full (b6, b7), next 2 compact (b4, b5), older archived.
    expect(r1.summary).toContain('<section topic="Topic 7">');
    expect(r1.summary).toContain('<section topic="Topic 6">');
    expect(r1.summary).toContain('<section topic="Topic 5" tier="compact">');
    expect(r1.summary).toContain('<section topic="Topic 4" tier="compact">');
    expect(r1.summary).toContain("<archived-sections>");
    expect(r1.summary).toContain("- Topic 1 ");
    expect(r1.summary).toContain("- Topic 3 ");
    // No raw block ids leaked into rendered summary.
    expect(r1.summary).not.toMatch(/<section topic=[^>]*id="b\d+"/);
    // Envelope wraps the DCP-rendered portion.
    expect(r1.summary).toContain('<dcp-summary version="1">');
    expect(r1.summary).toContain("</dcp-summary>");

    // Case 2: non-DCP previous summary should be preserved verbatim at the top.
    const proseSummary = "Plain prose summary from pi LLM fallback.";
    const r2 = buildDcpNativeCompactionResult(buildArgs(proseSummary));
    expect(r2.summary.startsWith(proseSummary)).toBe(true);

    // Case 3: mixed previous summary — prose outside envelope survives, envelope content drops.
    const mixed = `Earlier LLM-style prose.\n\n<dcp-summary version="1">\n<section topic="Old">old body</section>\n</dcp-summary>\n\nMore prose after envelope.`;
    const r3 = buildDcpNativeCompactionResult(buildArgs(mixed));
    expect(r3.summary).toContain("Earlier LLM-style prose.");
    expect(r3.summary).toContain("More prose after envelope.");
    expect(r3.summary).not.toContain("old body");
  });
});
