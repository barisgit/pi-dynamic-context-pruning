import { describe, expect, test } from "bun:test";
import {
  appendDebugLogLine,
  applyPruning,
  assert,
  buildBlockOwnerKey,
  buildCompressionArtifactsForRange,
  buildCompressionPlanningHints,
  buildLiveOwnerKeys,
  buildSessionDebugPayload,
  buildSourceOwnerKey,
  buildTranscriptSnapshot,
  extractCanonicalOwnerKeyFromMessageLike,
  filterProviderPayloadInput,
  findOrphanedToolUse,
  fs,
  getNudgeType,
  injectNudge,
  makeConfig,
  makeMessages,
  makeState,
  mapLegacyBlockToSpanRange,
  os,
  path,
  registerCompressTool,
  renderCompressedBlockMessage,
  renderCompressionPlanningHints,
  resolveAnchorSourceKey,
  resolveAnchorTimestamp,
  resolveProtectedTailStartTimestamp,
  resolveSupersededBlockIdsForRange,
  restorePersistedState,
  validateCompressionRangeBoundaryIds,
} from "../helpers/dcp-test-utils.js";

describe("DCP compression.test", () => {
  // ---------------------------------------------------------------------------
  // Test 15 — V2 BLOCK RENDERER EMITS A FACTUAL CHRONOLOGICAL LOG
  // ---------------------------------------------------------------------------
  test("Test 15 — V2 BLOCK RENDERER EMITS A FACTUAL CHRONOLOGICAL LOG", () => {
    console.log("TEST 15: v2 block renderer emits summary + chronological log");

    const message = renderCompressedBlockMessage({
      id: 7,
      topic: "dogfood block format",
      summary: "Renderer work started for the new deterministic block shape.",
      activityLogVersion: 1,
      activityLog: [
        {
          kind: "user_excerpt",
          text: '"You need to remember one thing: SIMPLE... <dcp-id>m029</dcp-id> <dcp-owner>s14</dcp-owner> and keep the useful trailing context."',
        },
        {
          kind: "assistant_excerpt",
          text: '"Default answer: keep `compress` simple <dcp-block-id>b3</dcp-block-id> and preserve the useful follow-up."',
        },
        { kind: "command", text: "bun run pruner.test.ts -> ok" },
        { kind: "commit", text: 'ff104f4 "Refine DCP v2 block design"' },
      ],
    });

    const text = message.content?.[0]?.text ?? "";
    assert.ok(
      text.includes("[Compressed section: dogfood block format]"),
      "FAIL — missing compressed section header"
    );
    assert.ok(
      text.includes("<agent-summary>"),
      "FAIL — expected structured summary wrapper when activity log exists"
    );
    assert.ok(text.includes('<activity-log>'), "FAIL — expected deterministic log wrapper");
    assert.ok(
      text.includes(
        'u: "You need to remember one thing: SIMPLE... and keep the useful trailing context."'
      ),
      "FAIL — expected sanitized user excerpt log line"
    );
    assert.ok(
      text.includes(
        'a: "Default answer: keep `compress` simple and preserve the useful follow-up."'
      ),
      "FAIL — expected sanitized assistant excerpt log line"
    );
    assert.ok(
      text.includes("cmd: bun run pruner.test.ts -> ok"),
      "FAIL — expected command log line"
    );
    assert.ok(
      text.includes('commit: ff104f4 "Refine DCP v2 block design"'),
      "FAIL — expected commit log line"
    );
    assert.ok(
      !text.includes("m029"),
      "FAIL — visible message ids should not appear in normal rendered block text by default"
    );
    assert.ok(
      !text.includes("<dcp-owner>s14</dcp-owner>"),
      "FAIL — renderer should strip DCP owner tags from visible log lines"
    );
    assert.ok(
      !text.includes("<dcp-block-id>b3</dcp-block-id>"),
      "FAIL — renderer should strip stale block markers from visible log lines"
    );

    const compact =
      renderCompressedBlockMessage({
        id: 8,
        topic: "older block",
        summary:
          "A much older compressed block should still keep a bounded summary but drop the detailed chronological activity log once it is no longer one of the newest active blocks.",
        activityLogVersion: 1,
        activityLog: [{ kind: "command", text: "bun run pruner.test.ts -> ok" }],
        detailLevel: "compact",
      }).content?.[0]?.text ?? "";
    assert.ok(
      compact.includes("<agent-summary>"),
      "FAIL — compact blocks should still render an agent summary"
    );
    assert.ok(
      !compact.includes('<dcp-log v="1">'),
      "FAIL — compact blocks should omit the detailed log"
    );

    const minimal =
      renderCompressedBlockMessage({
        id: 9,
        topic: "oldest block",
        summary:
          "The oldest block in the transcript should collapse to a one-line style summary so synthetic block history does not keep expanding forever even when the compressed semantics stay the same.",
        detailLevel: "minimal",
      }).content?.[0]?.text ?? "";
    assert.ok(
      !minimal.includes("<agent-summary>"),
      "FAIL — minimal blocks should omit the structured summary wrapper"
    );
    assert.ok(
      !minimal.includes('<dcp-log v="1">'),
      "FAIL — minimal blocks should omit the detailed log"
    );
    assert.ok(
      minimal.includes("<dcp-block-id>b9</dcp-block-id>"),
      "FAIL — minimal blocks should still keep the stable block marker"
    );

    console.log("  PASS: v2 block renderer emits full, compact, and minimal deterministic forms");
    console.log("TEST 15 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 17 — LEGACY COMPRESS ARTIFACTS REUSE THE EXPANDED TOOL RANGE
  // ---------------------------------------------------------------------------
  test("Test 17 — LEGACY COMPRESS ARTIFACTS REUSE THE EXPANDED TOOL RANGE", () => {
    console.log("TEST 17: legacy compress artifacts include expanded assistant + tool metadata");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "please read the file" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll inspect it." },
          {
            type: "toolCall",
            id: "toolu_read",
            name: "read",
            arguments: { path: "src/app.ts", offset: 10, limit: 5 },
          },
        ],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_read",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 3000,
      },
      { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 4000 },
    ];

    const state = makeState();
    state.toolCalls.set("toolu_read", {
      toolCallId: "toolu_read",
      toolName: "read",
      inputArgs: { path: "src/app.ts", offset: 10, limit: 5 },
      inputFingerprint: "read::{}",
      isError: false,
      turnIndex: 0,
      timestamp: 3000,
      tokenEstimate: 10,
    });

    const artifacts = buildCompressionArtifactsForRange(messages, state, 3000, 3000);

    assert.deepStrictEqual(
      artifacts.activityLog.map((entry) => `${entry.kind}:${entry.text}`),
      ['assistant_excerpt:"I\'ll inspect it."', "read:src/app.ts#L10-L14"],
      "FAIL — activity log should include the backward-expanded assistant excerpt and deterministic read record"
    );
    assert.deepStrictEqual(
      artifacts.metadata.coveredSourceKeys,
      ["msg:2000:assistant:1", "msg:3000:toolResult:toolu_read:2"],
      "FAIL — exact covered source keys should be persisted for the expanded range"
    );
    assert.deepStrictEqual(
      artifacts.metadata.coveredSpanKeys,
      ["span:msg:2000:assistant:1..msg:3000:toolResult:toolu_read:2"],
      "FAIL — exact covered span keys should be persisted for the expanded range"
    );
    assert.deepStrictEqual(
      artifacts.metadata.coveredToolIds,
      ["toolu_read"],
      "FAIL — covered tool ids should include the read call"
    );
    assert.deepStrictEqual(
      artifacts.metadata.fileReadStats,
      [{ path: "src/app.ts", count: 1, lineSpans: ["L10-L14"] }],
      "FAIL — file read stats should be populated from tool input args"
    );

    console.log(
      "  PASS: legacy compress artifacts reuse expanded range coverage and tool metadata"
    );
    console.log("TEST 17 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 17b — TOOL METADATA FALLS BACK TO COVERED ASSISTANT TOOLCALL BLOCKS
  // ---------------------------------------------------------------------------
  test("Test 17b — TOOL METADATA FALLS BACK TO COVERED ASSISTANT TOOLCALL BLOCKS", () => {
    console.log("TEST 17b: tool metadata recovers from assistant toolCall blocks");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "run bash" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running" },
          {
            type: "toolCall",
            id: "toolu_bash",
            name: "bash",
            arguments: { command: "bun run test" },
          },
        ],
        timestamp: 2000,
      },
      {
        role: "bashExecution",
        toolCallId: "toolu_bash",
        toolName: "bash",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3000,
      },
    ];

    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 3000, 3000);

    assert.deepStrictEqual(
      artifacts.activityLog.map((entry) => `${entry.kind}:${entry.text}`),
      ['assistant_excerpt:"running"', "test:bun run test -> ok"],
      "FAIL — tool metadata should be recovered from assistant toolCall blocks even without state.toolCalls"
    );
    assert.deepStrictEqual(
      artifacts.metadata.commandStats,
      [{ command: "bun run test", status: "ok" }],
      "FAIL — command stats should be populated from assistant toolCall arguments"
    );

    console.log("  PASS: covered assistant toolCall blocks recover missing tool metadata");
    console.log("TEST 17b PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 17c — EXCERPTS STRIP DCP METADATA WHILE KEEPING USEFUL TEXT
  // ---------------------------------------------------------------------------
  test("Test 17c — EXCERPTS STRIP DCP METADATA WHILE KEEPING USEFUL TEXT", () => {
    console.log("TEST 17c: excerpts strip DCP metadata while keeping useful text");

    const messages: any[] = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "[Compressed section: older block]\n\n<agent-summary>\nKeep the useful trail <dcp-id>m001</dcp-id> <dcp-owner>s7</dcp-owner> after the tag.\n</agent-summary>\n\n<dcp-block-id>b1</dcp-block-id>",
          },
        ],
        timestamp: 1000,
      },
    ];

    const artifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 1000);

    assert.deepStrictEqual(
      artifacts.activityLog.map((entry) => `${entry.kind}:${entry.text}`),
      [
        'assistant_excerpt:"[Compressed section: older block] Keep the useful trail after the tag."',
      ],
      "FAIL — excerpt capture should strip DCP metadata tags while preserving useful surrounding text"
    );

    console.log("  PASS: excerpt capture strips DCP metadata and keeps useful context");
    console.log("TEST 17c PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 18 — RECENT TURN PROTECTION STARTS AT THE NTH-MOST-RECENT LOGICAL TURN
  // ---------------------------------------------------------------------------
  test("Test 18 — RECENT TURN PROTECTION STARTS AT THE NTH-MOST-RECENT LOGICAL TURN", () => {
    console.log("TEST 18: recent-turn protection guards the hot logical tail");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "running tool" },
          { type: "toolCall", id: "toolu_x", name: "read", arguments: {} },
        ],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "toolu_x",
        toolName: "read",
        content: [{ type: "text", text: "ignored" }],
        timestamp: 3000,
      },
      { role: "assistant", content: [{ type: "text", text: "three" }], timestamp: 4000 },
      { role: "user", content: [{ type: "text", text: "four" }], timestamp: 5000 },
    ];

    assert.strictEqual(
      resolveProtectedTailStartTimestamp(messages, 2),
      4000,
      "FAIL — protecting the last 2 logical turns should start at timestamp 4000"
    );
    assert.strictEqual(
      resolveProtectedTailStartTimestamp(messages, 3),
      2000,
      "FAIL — an assistant tool batch should count as one protected logical turn starting at the assistant timestamp"
    );
    assert.strictEqual(
      resolveProtectedTailStartTimestamp(messages, 4),
      1000,
      "FAIL — when fewer than 4 logical turns exist beyond the head, protection should extend to the earliest available turn"
    );
    assert.strictEqual(
      resolveProtectedTailStartTimestamp(messages, 0),
      null,
      "FAIL — zero protected turns should disable recent-turn protection"
    );

    console.log(
      "  PASS: recent-turn protection is deterministic and tool batches count as one turn"
    );
    console.log("TEST 18 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 18b — PLANNING HINTS SURFACE PROTECTED IDS + SAFE LARGE RANGES
  // ---------------------------------------------------------------------------
  test("Test 18b — PLANNING HINTS SURFACE PROTECTED IDS + SAFE LARGE RANGES", () => {
    console.log("TEST 18b: compression planning hints surface protected ids and large safe ranges");

    const messages: any[] = [
      {
        role: "user",
        content: [{ type: "text", text: "alpha alpha alpha alpha alpha alpha" }],
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "beta beta beta beta beta beta" }],
        timestamp: 2000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "gamma gamma gamma gamma gamma gamma" }],
        timestamp: 3000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "delta delta delta delta delta delta" }],
        timestamp: 4000,
      },
      { role: "user", content: [{ type: "text", text: "protected newer turn" }], timestamp: 5000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "protected newest turn" }],
        timestamp: 6000,
      },
    ];

    const state = makeState([
      {
        id: 7,
        topic: "protected tail",
        summary: "tail summary",
        startTimestamp: 5000,
        endTimestamp: 6000,
        anchorTimestamp: 7000,
        active: true,
        summaryTokenEstimate: 1,
        createdAt: 1,
      },
    ]);
    state.messageIdSnapshot = new Map([
      ["m001", 1000],
      ["m002", 2000],
      ["m003", 3000],
      ["m004", 4000],
      ["m005", 5000],
      ["m006", 6000],
    ]);

    const hints = buildCompressionPlanningHints(messages, state, 2);
    const rendered = renderCompressionPlanningHints(hints);

    assert.deepStrictEqual(
      hints.protectedMessageIds,
      ["m005", "m006"],
      "FAIL — protected message ids should list the visible hot-tail messages"
    );
    assert.deepStrictEqual(
      hints.protectedBlockIds,
      ["b7"],
      "FAIL — protected block ids should list active blocks whose end lies in the hot tail"
    );
    assert.strictEqual(
      hints.candidateRanges[0]?.startId,
      "m001",
      "FAIL — the largest safe range should start at the oldest visible uncompressed id"
    );
    assert.strictEqual(
      hints.candidateRanges[0]?.endId,
      "m004",
      "FAIL — the largest safe range should stop before the protected tail"
    );
    assert.ok(
      (hints.candidateRanges[0]?.tokenEstimate ?? 0) > 0,
      "FAIL — the largest safe range should report a positive token estimate"
    );
    assert.ok(
      rendered.includes("Protected hot tail starts at m005."),
      "FAIL — rendered hints should include the visible hot-tail boundary"
    );
    assert.ok(
      rendered.includes("messages m005, m006"),
      "FAIL — rendered hints should enumerate protected message ids"
    );
    assert.ok(
      rendered.includes("blocks b7"),
      "FAIL — rendered hints should enumerate protected block ids"
    );
    assert.ok(
      rendered.includes("- m001..m004"),
      "FAIL — rendered hints should suggest the largest visible safe candidate range"
    );

    console.log("  PASS: planning hints expose protected end ids and large safe ranges");
    console.log("TEST 18b PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 21 — EXACT FULL COVERAGE SUPERCEDES OLDER ACTIVE BLOCKS
  // ---------------------------------------------------------------------------
  test("Test 21 — EXACT FULL COVERAGE SUPERCEDES OLDER ACTIVE BLOCKS", () => {
    console.log("TEST 21: exact full coverage supersedes older active blocks");

    const messages = makeMessages();
    const olderArtifacts = buildCompressionArtifactsForRange(messages, makeState(), 2000, 3000);
    const newerArtifacts = buildCompressionArtifactsForRange(messages, makeState(), 1000, 3000);
    const olderBlock = {
      id: 7,
      topic: "tool exchange",
      summary: "older",
      startTimestamp: 2000,
      endTimestamp: 3000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 1,
      createdAt: 1,
      metadata: olderArtifacts.metadata,
    };

    assert.deepStrictEqual(
      resolveSupersededBlockIdsForRange(
        messages,
        [olderBlock],
        1000,
        3000,
        newerArtifacts.metadata.coveredSourceKeys,
        "m001",
        "m003"
      ),
      [7],
      "FAIL — fully covered exact old block should be superseded"
    );

    console.log("  PASS: fully covered exact old blocks are superseded");
    console.log("TEST 21 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 22 — PARTIAL EXACT OVERLAP STILL REJECTS
  // ---------------------------------------------------------------------------
  test("Test 22 — PARTIAL EXACT OVERLAP STILL REJECTS", () => {
    console.log("TEST 22: partial exact overlap still rejects");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2000 },
      { role: "user", content: [{ type: "text", text: "three" }], timestamp: 3000 },
    ];
    const snapshot = buildTranscriptSnapshot(messages);
    const olderBlock = {
      id: 8,
      topic: "older",
      summary: "older",
      startTimestamp: 1000,
      endTimestamp: 2000,
      anchorTimestamp: 3000,
      active: true,
      summaryTokenEstimate: 1,
      createdAt: 1,
      metadata: {
        coveredSourceKeys: [snapshot.sourceItems[0]!.key, snapshot.sourceItems[1]!.key],
        coveredSpanKeys: [snapshot.spans[0]!.key, snapshot.spans[1]!.key],
        coveredArtifactRefs: [],
        coveredToolIds: [],
        supersededBlockIds: [],
        fileReadStats: [],
        fileWriteStats: [],
        commandStats: [],
      },
    };

    assert.throws(
      () =>
        resolveSupersededBlockIdsForRange(
          messages,
          [olderBlock],
          2000,
          3000,
          [snapshot.sourceItems[1]!.key, snapshot.sourceItems[2]!.key],
          "m002",
          "m003"
        ),
      /Overlapping compression ranges are not supported/,
      "FAIL — partial exact overlap should still reject"
    );

    console.log("  PASS: partial exact overlap still rejects");
    console.log("TEST 22 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 23 — TIMESTAMP-ONLY LEGACY OVERLAP STAYS CONSERVATIVE
  // ---------------------------------------------------------------------------
  test("Test 23 — TIMESTAMP-ONLY LEGACY OVERLAP STAYS CONSERVATIVE", () => {
    console.log("TEST 23: timestamp-only legacy overlap stays conservative");

    const messages = makeMessages();
    const legacyBlock = {
      id: 9,
      topic: "legacy",
      summary: "legacy",
      startTimestamp: 2000,
      endTimestamp: 3000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 1,
      createdAt: 1,
    };

    assert.throws(
      () =>
        resolveSupersededBlockIdsForRange(
          messages,
          [legacyBlock],
          1000,
          3000,
          buildCompressionArtifactsForRange(messages, makeState(), 1000, 3000).metadata
            .coveredSourceKeys,
          "m001",
          "m003"
        ),
      /Overlapping compression ranges are not supported/,
      "FAIL — timestamp-only legacy overlap should still reject conservatively"
    );

    console.log("  PASS: timestamp-only legacy overlap stays conservative");
    console.log("TEST 23 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 23b — BOUNDARY VALIDATION REJECTS STALE IDS AND SELF-BLOCK RANGES
  // ---------------------------------------------------------------------------
  test("Test 23b — BOUNDARY VALIDATION REJECTS STALE IDS AND SELF-BLOCK RANGES", () => {
    console.log("TEST 23b: boundary validation rejects stale ids and self-block ranges");

    const state = makeState([
      {
        id: 3,
        topic: "old",
        summary: "old summary",
        startTimestamp: 1000,
        endTimestamp: 2000,
        anchorTimestamp: 3000,
        active: true,
        summaryTokenEstimate: 2,
        createdAt: Date.now(),
      },
    ]);
    state.messageIdSnapshot.set("m0001", 1000);
    state.messageIdSnapshot.set("m0002", 2000);

    assert.throws(
      () => validateCompressionRangeBoundaryIds("m9999", "m0002", state),
      /Unknown message ID: m9999/,
      "FAIL — stale message refs should reject"
    );
    assert.throws(
      () => validateCompressionRangeBoundaryIds("b3", "b3", state),
      /contains only compressed block b3/,
      "FAIL — bN..bN self-compression should reject"
    );
    validateCompressionRangeBoundaryIds("m0001", "b3", state);

    state.messageRefSnapshot.set("m0001", {
      ref: "m0001",
      sourceKey: "msg:1000:user:0",
      timestamp: 1000,
      ownerKey: "s0",
    });
    state.messageRefSnapshot.set("m0002", {
      ref: "m0002",
      sourceKey: "msg:2000:user:1",
      timestamp: 2000,
      ownerKey: "s1",
    });
    assert.strictEqual(
      resolveAnchorTimestamp(2000, state),
      Infinity,
      "FAIL — trailing ranges should not invent a finite numeric anchor timestamp"
    );
    assert.strictEqual(
      resolveAnchorSourceKey(2000, "msg:2000:user:1", state),
      "tail:msg:2000:user:1",
      "FAIL — trailing ranges should use a canonical tail source-key anchor"
    );

    console.log("  PASS: stale refs, self-block ranges, and trailing anchors validate clearly");
    console.log("TEST 23b PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 23c — COMPRESS TOOL SUPPORTS PER-RANGE TOPICS
  // ---------------------------------------------------------------------------
  test("Test 23c — COMPRESS TOOL SUPPORTS PER-RANGE TOPICS", async () => {
    console.log("TEST 23c: compress tool creates one block per range with per-range topics");

    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "first topic ".repeat(200) }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "second topic ".repeat(200) }], timestamp: 2000 },
      { role: "user", content: [{ type: "text", text: "anchor" }], timestamp: 3000 },
    ];
    const state = makeState();
    for (const [ref, timestamp] of [
      ["m0001", 1000],
      ["m0002", 2000],
      ["m0003", 3000],
    ] as const) {
      state.messageIdSnapshot.set(ref, timestamp);
      state.messageRefSnapshot.set(ref, {
        ref,
        sourceKey: `msg:${timestamp}:user:${Number(ref.slice(1)) - 1}`,
        timestamp,
        ownerKey: `source:${ref}`,
      });
    }

    const config = makeConfig();
    config.compress.protectRecentTurns = 0;
    let registeredTool: any = null;
    const pi = {
      registerTool(tool: any) {
        registeredTool = tool;
      },
    };
    const ctx = {
      sessionManager: {
        getSessionId: () => "session-1",
        getCwd: () => "/tmp/dcp-test",
        getSessionDir: () => "/tmp/dcp-test/session",
        getSessionFile: () => "/tmp/dcp-test/session.jsonl",
        getLeafId: () => null,
        getBranch: () => messages.map((message) => ({ type: "message", message })),
      },
      getContextUsage: () => ({ tokens: 0, contextWindow: 100_000 }),
      ui: { notify: () => undefined },
    };

    registerCompressTool(pi as any, state, config);

    const result = await registeredTool.execute(
      "compress-call-1",
      {
        topic: "Default topic",
        ranges: [
          { startId: "m0001", endId: "m0001", summary: "First summary", topic: "First block" },
          { startId: "m0002", endId: "m0002", summary: "Second summary" },
        ],
      },
      undefined,
      undefined,
      ctx
    );

    assert.deepStrictEqual(
      state.compressionBlocks.map((block) => block.topic),
      ["First block", "Default topic"],
      "FAIL — range.topic should override the top-level default per created block"
    );
    assert.deepStrictEqual(
      result.details.blocks,
      [
        { id: 1, topic: "First block" },
        { id: 2, topic: "Default topic" },
      ],
      "FAIL — tool result details should identify each created block topic"
    );
    assert.ok(
      result.content[0].text.includes("First block, Default topic"),
      "FAIL — tool result text should summarize all block topics"
    );
    assert.ok(
      state.tokensSaved > 0,
      "FAIL — successful compression should immediately populate estimated tokensSaved for /dcp stats"
    );
    assert.ok(
      state.compressionBlocks.every((block) => (block.savedTokenEstimate ?? 0) > 0),
      "FAIL — created blocks should carry an immediate creation-time saved-token estimate"
    );

    await assert.rejects(
      () =>
        registeredTool.execute(
          "compress-call-2",
          { ranges: [{ startId: "m0003", endId: "m0003", summary: "Missing topic" }] },
          undefined,
          undefined,
          ctx
        ),
      /requires a non-empty topic/,
      "FAIL — each range should require an effective range or default topic"
    );

    console.log("  PASS: per-range topics create correctly labelled compression blocks");
    console.log("TEST 23c PASSED\n");
  });
});
