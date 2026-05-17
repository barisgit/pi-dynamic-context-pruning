import { describe, expect, test } from "bun:test";
import {
  allocateMessageRef,
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
  formatMessageRef,
  fs,
  getNudgeType,
  makeConfig,
  makeMessages,
  makeState,
  mapLegacyBlockToSpanRange,
  normalizeMessageAliasState,
  os,
  parseVisibleRef,
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
    assert.ok(text.includes("<activity-log>"), "FAIL — expected deterministic log wrapper");
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
    const rendered = renderCompressionPlanningHints(hints, {
      includeProtectedIdList: true,
    });
    const renderedRoutine = renderCompressionPlanningHints(hints);

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
      "FAIL — opted-in render should enumerate protected message ids"
    );
    assert.ok(
      rendered.includes("blocks b7"),
      "FAIL — opted-in render should enumerate protected block ids"
    );
    assert.ok(
      !renderedRoutine.includes("Do not use these as endId"),
      "FAIL — routine render should omit the verbose protected-id enumeration"
    );
    assert.ok(
      rendered.includes("- m001..m004"),
      "FAIL — rendered hints should suggest the largest visible safe candidate range"
    );

    console.log("  PASS: planning hints expose protected end ids and large safe ranges");
    console.log("TEST 18b PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 18c — PLANNING HINTS DO NOT FRAGMENT ACROSS PASSTHROUGH ROLES
  // ---------------------------------------------------------------------------
  test("Test 18c — PLANNING HINTS DO NOT FRAGMENT ACROSS PASSTHROUGH ROLES", () => {
    console.log("TEST 18c: passthrough roles (custom_message, etc) must not fragment safe ranges");

    // user, assistant, custom_message (reminder), user, assistant, ...hot-tail
    // Without the fix, the reminder span would flush the running candidate and
    // surface m001..m002 + m004..m005 instead of one m001..m005 range.
    const messages: any[] = [
      {
        role: "user",
        content: [{ type: "text", text: "alpha alpha alpha alpha" }],
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "beta beta beta beta" }],
        timestamp: 2000,
      },
      {
        role: "custom_message",
        content: [{ type: "text", text: "<system-reminder>compress now</system-reminder>" }],
        timestamp: 2500,
      },
      {
        role: "user",
        content: [{ type: "text", text: "gamma gamma gamma gamma" }],
        timestamp: 3000,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "delta delta delta delta" }],
        timestamp: 4000,
      },
      { role: "user", content: [{ type: "text", text: "hot tail user" }], timestamp: 5000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hot tail assistant" }],
        timestamp: 6000,
      },
    ];

    const state = makeState([]);
    // custom_message intentionally omitted from messageIdSnapshot — passthrough
    // roles never receive a visible message ref (see injectMessageIds).
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

    assert.strictEqual(
      hints.candidateRanges.length,
      1,
      "FAIL — passthrough roles should not split the safe range into multiple candidates"
    );
    assert.strictEqual(
      hints.candidateRanges[0]?.startId,
      "m001",
      "FAIL — single safe range should still start at the oldest visible id"
    );
    assert.strictEqual(
      hints.candidateRanges[0]?.endId,
      "m004",
      "FAIL — single safe range should still end at the last id before the hot tail"
    );
    assert.ok(
      hints.totalCompressibleTokens > 0,
      "FAIL — total compressible token estimate should be positive"
    );
    assert.strictEqual(
      hints.totalCandidateCount,
      1,
      "FAIL — total candidate count should match the surfaced range"
    );
    assert.ok(
      rendered.includes("1 stretch"),
      "FAIL — rendered hint should disclose the total candidate-stretch count"
    );
    assert.ok(
      !rendered.includes("1 stretches"),
      "FAIL — single stretch should use singular wording"
    );
    assert.ok(
      rendered.includes("tokens total"),
      "FAIL — rendered hint should disclose the total compressible token estimate"
    );

    console.log("  PASS: passthrough roles are transparent to candidate building");
    console.log("TEST 18c PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 18d — PLANNING HINTS DISCLOSE TRUNCATION WHEN MORE RANGES EXIST
  // ---------------------------------------------------------------------------
  test("Test 18d — PLANNING HINTS DISCLOSE TRUNCATION WHEN MORE RANGES EXIST", () => {
    console.log("TEST 18d: when surfaced ranges < total, header should say 'showing top N'");

    // Build a transcript fragmented by ALREADY-COMPRESSED older blocks so we
    // get multiple disjoint safe ranges. With the default limit of 10 a single
    // request would not be truncated, so call with an explicit small limit.
    const messages: any[] = [];
    for (let i = 0; i < 12; i++) {
      const baseTs = 1000 + i * 1000;
      messages.push({
        role: "user",
        content: [{ type: "text", text: `u${i} u${i} u${i} u${i}` }],
        timestamp: baseTs,
      });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `a${i} a${i} a${i} a${i}` }],
        timestamp: baseTs + 100,
      });
    }

    const snapshot = new Map<string, number>();
    messages.forEach((msg, idx) => {
      snapshot.set(`m${String(idx + 1).padStart(3, "0")}`, msg.timestamp);
    });

    // Drop a single covered slice in the middle so we get two safe ranges.
    const blocks = [
      {
        id: 5,
        topic: "middle",
        summary: "middle",
        startTimestamp: messages[10]!.timestamp,
        endTimestamp: messages[13]!.timestamp,
        anchorTimestamp: messages[14]!.timestamp,
        active: true,
        summaryTokenEstimate: 1,
        createdAt: 1,
      },
    ];
    const state = makeState(blocks);
    state.messageIdSnapshot = snapshot;

    const hints = buildCompressionPlanningHints(messages, state, 2, 1);
    const rendered = renderCompressionPlanningHints(hints);

    assert.strictEqual(
      hints.candidateRanges.length,
      1,
      "FAIL — explicit candidate limit of 1 should surface exactly one range"
    );
    assert.ok(
      hints.totalCandidateCount >= 2,
      `FAIL — at least 2 safe ranges should exist around the covered slice, got ${hints.totalCandidateCount}`
    );
    assert.ok(
      rendered.includes("showing top 1 by size"),
      "FAIL — rendered hint should signal that surfaced ranges are a truncation"
    );

    console.log("  PASS: truncation is disclosed when safe ranges exceed the limit");
    console.log("TEST 18d PASSED\n");
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
    state.messageIdSnapshot.set("m10000", 10000);

    assert.throws(
      () => validateCompressionRangeBoundaryIds("m10001", "m0002", state),
      /Unknown message ID: m10001/,
      "FAIL — stale wide message refs should reject"
    );
    assert.throws(
      () => validateCompressionRangeBoundaryIds("b3", "b3", state),
      /contains only compressed block b3/,
      "FAIL — bN..bN self-compression should reject"
    );
    validateCompressionRangeBoundaryIds("m0001", "b3", state);
    validateCompressionRangeBoundaryIds("m10000", "b3", state);
    state.messageIdSnapshot.delete("m10000");

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
  // Test 23c — MESSAGE REFS CONTINUE BEYOND FOUR DIGITS
  // ---------------------------------------------------------------------------
  test("Test 23c — MESSAGE REFS CONTINUE BEYOND FOUR DIGITS", () => {
    console.log("TEST 23c: message refs preserve four-digit padding then continue wider");

    assert.strictEqual(
      formatMessageRef(1),
      "m0001",
      "FAIL — low refs should keep four-digit padding"
    );
    assert.strictEqual(
      formatMessageRef(9999),
      "m9999",
      "FAIL — four-digit refs should be unchanged"
    );
    assert.strictEqual(formatMessageRef(10000), "m10000", "FAIL — refs should continue past m9999");

    assert.deepStrictEqual(
      parseVisibleRef("m10000"),
      { kind: "message", ref: "m10000", index: 10000, legacy: false },
      "FAIL — parser should accept stable refs wider than four digits"
    );

    const aliases = normalizeMessageAliasState({
      bySourceKey: { "source:9999": "m9999" },
      byRef: { m9999: "source:9999" },
      nextRef: 10000,
    });
    assert.strictEqual(
      allocateMessageRef(aliases, "source:10000"),
      "m10000",
      "FAIL — allocator should not stop at m9999"
    );
    assert.strictEqual(
      allocateMessageRef(aliases, "source:10001"),
      "m10001",
      "FAIL — allocator should continue assigning wider refs"
    );

    const inferred = normalizeMessageAliasState({
      bySourceKey: { "source:10000": "m10000" },
      byRef: { m10000: "source:10000" },
    });
    assert.strictEqual(
      allocateMessageRef(inferred, "source:10001"),
      "m10001",
      "FAIL — inferred nextRef should continue after wide persisted refs"
    );

    console.log("  PASS: message refs continue past m9999");
    console.log("TEST 23c PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 23d — COMPRESS TOOL SUPPORTS PER-RANGE TOPICS
  // ---------------------------------------------------------------------------
  test("Test 23d — COMPRESS TOOL SUPPORTS PER-RANGE TOPICS", async () => {
    console.log("TEST 23d: compress tool creates one block per range with per-range topics");

    const messages: any[] = [
      {
        role: "user",
        content: [{ type: "text", text: "first topic ".repeat(200) }],
        timestamp: 1000,
      },
      {
        role: "user",
        content: [{ type: "text", text: "second topic ".repeat(200) }],
        timestamp: 2000,
      },
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
    config.nativeCompaction.autoTriggerMessageCount = 1;
    let compactCallCount = 0;
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
      compact: () => {
        compactCallCount++;
      },
      hasUI: false,
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
    assert.strictEqual(
      result.details.nativeCompactionRequested,
      true,
      "FAIL — compress should mark native compaction requested when auto threshold is crossed"
    );
    assert.strictEqual(
      compactCallCount,
      0,
      "FAIL — auto native compaction must be queued for turn_end, not called inside compress.execute()"
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
    console.log("TEST 23d PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 23e — COMPRESS TOOL RETURNS POST-COMPRESS PLANNING HINTS
  // ---------------------------------------------------------------------------
  test("Test 23e — COMPRESS TOOL RETURNS POST-COMPRESS PLANNING HINTS", async () => {
    console.log("TEST 23e: compress tool result should surface remaining safe ranges");

    // Build a transcript with enough uncompressed slack that compressing one
    // narrow range still leaves an obvious safe candidate behind.
    const messages: any[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `user message ${i} `.repeat(80) }],
        timestamp: 1000 + i * 2000,
      });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `assistant reply ${i} `.repeat(80) }],
        timestamp: 2000 + i * 2000,
      });
    }

    const state = makeState();
    messages.forEach((msg, idx) => {
      const ref = `m${String(idx + 1).padStart(4, "0")}`;
      state.messageIdSnapshot.set(ref, msg.timestamp);
      state.messageRefSnapshot.set(ref, {
        ref,
        sourceKey: `msg:${msg.timestamp}:${msg.role}:${idx}`,
        timestamp: msg.timestamp,
        ownerKey: `source:${ref}`,
      });
    });

    const config = makeConfig();
    config.compress.protectRecentTurns = 2;
    config.nativeCompaction.autoTriggerMessageCount = 999;

    let registeredTool: any = null;
    const pi = {
      registerTool(tool: any) {
        registeredTool = tool;
      },
    };
    const ctx = {
      sessionManager: {
        getSessionId: () => "session-23e",
        getCwd: () => "/tmp/dcp-test",
        getSessionDir: () => "/tmp/dcp-test/session",
        getSessionFile: () => "/tmp/dcp-test/session.jsonl",
        getLeafId: () => null,
        getBranch: () => messages.map((message) => ({ type: "message", message })),
      },
      getContextUsage: () => ({ tokens: 200_000, contextWindow: 1_000_000 }),
      compact: () => undefined,
      hasUI: false,
      ui: { notify: () => undefined },
    };

    registerCompressTool(pi as any, state, config);

    // Compress only the first user/assistant pair, leaving a fat safe range
    // (m0003..m0008) before the protected tail (m0009..m0012).
    const result = await registeredTool.execute(
      "compress-call-23e",
      {
        topic: "opening",
        ranges: [{ startId: "m0001", endId: "m0002", summary: "opening summary" }],
      },
      undefined,
      undefined,
      ctx
    );

    const text: string = result.content[0].text;
    assert.ok(
      text.startsWith("Compressed 1 range(s)"),
      "FAIL — tool result should still lead with the compressed-count header"
    );
    assert.ok(
      text.includes("Stale and compressible now"),
      "FAIL — tool result should append updated planning hints after a successful compress"
    );
    assert.ok(
      text.includes("tokens total"),
      "FAIL — tool result hints should include the post-compress compressible-token total"
    );
    assert.ok(
      /m\d{4}\.\.m\d{4}/.test(text),
      `FAIL — tool result hints should reference the remaining safe range, got: ${text}`
    );
    assert.ok(
      result.details.postCompressHints,
      "FAIL — tool result details should include structured postCompressHints for programmatic callers"
    );
    assert.ok(
      (result.details.postCompressHints.candidateRanges?.length ?? 0) > 0,
      "FAIL — structured postCompressHints should expose the remaining candidate ranges"
    );

    console.log("  PASS: compress tool result includes refreshed planning hints");
    console.log("TEST 23e PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 23f — NATIVE-COMPACTION THRESHOLD COUNTS LLM MESSAGES, NOT PASSTHROUGH
  // ---------------------------------------------------------------------------
  test("Test 23f — NATIVE-COMPACTION THRESHOLD IGNORES PASSTHROUGH ENTRIES", async () => {
    console.log(
      "TEST 23f: autoTriggerMessageCount should count LLM turns only, not reminders / compactions"
    );

    // 4 real LLM messages + 6 passthrough housekeeping entries = 10 total
    // branch entries. Threshold is 5. Pre-fix: 10 >= 5 → fires. Post-fix:
    // only the 4 LLM messages count, 4 < 5 → must NOT fire.
    const realMessages: any[] = [
      { role: "user", content: [{ type: "text", text: "first request" }], timestamp: 1000 },
      { role: "assistant", content: [{ type: "text", text: "first reply" }], timestamp: 2000 },
      { role: "user", content: [{ type: "text", text: "second request" }], timestamp: 3000 },
      { role: "assistant", content: [{ type: "text", text: "second reply" }], timestamp: 4000 },
    ];

    const state = makeState();
    realMessages.forEach((msg, idx) => {
      const ref = `m${String(idx + 1).padStart(4, "0")}`;
      state.messageIdSnapshot.set(ref, msg.timestamp);
      state.messageRefSnapshot.set(ref, {
        ref,
        sourceKey: `msg:${msg.timestamp}:${msg.role}:${idx}`,
        timestamp: msg.timestamp,
        ownerKey: `source:${ref}`,
      });
    });

    const config = makeConfig();
    config.compress.protectRecentTurns = 0;
    config.nativeCompaction.autoTriggerMessageCount = 5;
    config.nativeCompaction.minActiveBlockCount = 1;

    // Branch entries pi would yield: 4 LLM messages + 6 housekeeping rows.
    const branchEntries = [
      { type: "message", message: realMessages[0] },
      {
        type: "custom_message",
        content: [{ type: "text", text: "reminder a" }],
        timestamp: "2026-01-01T00:00:00Z",
      },
      { type: "message", message: realMessages[1] },
      {
        type: "custom_message",
        content: [{ type: "text", text: "reminder b" }],
        timestamp: "2026-01-01T00:00:01Z",
      },
      { type: "compaction", summary: "prior compaction", timestamp: "2026-01-01T00:00:02Z" },
      { type: "message", message: realMessages[2] },
      {
        type: "custom_message",
        content: [{ type: "text", text: "reminder c" }],
        timestamp: "2026-01-01T00:00:03Z",
      },
      {
        type: "custom_message",
        content: [{ type: "text", text: "reminder d" }],
        timestamp: "2026-01-01T00:00:04Z",
      },
      { type: "branch_summary", summary: "prior branch", timestamp: "2026-01-01T00:00:05Z" },
      { type: "message", message: realMessages[3] },
    ];

    let registeredTool: any = null;
    const pi = {
      registerTool(tool: any) {
        registeredTool = tool;
      },
    };
    const ctx = {
      sessionManager: {
        getSessionId: () => "session-23f",
        getCwd: () => "/tmp/dcp-test",
        getSessionDir: () => "/tmp/dcp-test/session",
        getSessionFile: () => "/tmp/dcp-test/session.jsonl",
        getLeafId: () => null,
        getBranch: () => branchEntries,
      },
      getContextUsage: () => ({ tokens: 100_000, contextWindow: 1_000_000 }),
      compact: () => undefined,
      hasUI: false,
      ui: { notify: () => undefined },
    };

    registerCompressTool(pi as any, state, config);

    const result = await registeredTool.execute(
      "compress-call-23f",
      {
        topic: "opening",
        ranges: [{ startId: "m0001", endId: "m0002", summary: "opening summary" }],
      },
      undefined,
      undefined,
      ctx
    );

    assert.strictEqual(
      result.details.nativeCompactionRequested,
      false,
      "FAIL — native compaction threshold must ignore passthrough entries; 4 real LLM messages < threshold 5 should NOT trigger"
    );

    console.log("  PASS: passthrough entries are excluded from the auto-trigger count");
    console.log("TEST 23f PASSED\n");
  });
});
