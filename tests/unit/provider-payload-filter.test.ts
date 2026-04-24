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
  renderCompressedBlockMessage,
  renderCompressionPlanningHints,
  resolveAnchorSourceKey,
  resolveAnchorTimestamp,
  resolveProtectedTailStartTimestamp,
  resolveSupersededBlockIdsForRange,
  restorePersistedState,
  validateCompressionRangeBoundaryIds,
} from "../helpers/dcp-test-utils.js";

describe("DCP provider payload filter.test", () => {
  // ---------------------------------------------------------------------------
  // Test 19 — LIVE OWNER KEYS COME FROM SOURCE ORDINALS + ACTIVE BLOCKS
  // ---------------------------------------------------------------------------
  test("Test 19 — LIVE OWNER KEYS COME FROM SOURCE ORDINALS + ACTIVE BLOCKS", () => {
    console.log(
      "TEST 19: live owner keys are derived from the source transcript, not rendered ids"
    );

    const messages = makeMessages();
    const snapshot = buildTranscriptSnapshot(messages);
    const block = {
      id: 1,
      topic: "tool exchange",
      summary: "compressed",
      startTimestamp: 1000,
      endTimestamp: 4000,
      anchorTimestamp: 4000,
      active: true,
      summaryTokenEstimate: 1,
      createdAt: 1,
      metadata: {
        coveredSourceKeys: [snapshot.sourceItems[1]!.key, snapshot.sourceItems[2]!.key],
        coveredSpanKeys: [snapshot.spans[1]!.key],
        coveredArtifactRefs: [],
        coveredToolIds: [],
        supersededBlockIds: [],
        fileReadStats: [],
        fileWriteStats: [],
        commandStats: [],
      },
    };

    const liveOwners = buildLiveOwnerKeys(messages, [block]);

    assert.ok(
      liveOwners.has(buildSourceOwnerKey(0)),
      "FAIL — head user source owner should stay live"
    );
    assert.ok(
      !liveOwners.has(buildSourceOwnerKey(1)),
      "FAIL — compressed assistant source owner should not stay live"
    );
    assert.ok(
      !liveOwners.has(buildSourceOwnerKey(2)),
      "FAIL — compressed tool result source owner should not stay live"
    );
    assert.ok(
      liveOwners.has(buildSourceOwnerKey(3)),
      "FAIL — tail user source owner should stay live"
    );
    assert.ok(
      liveOwners.has(buildBlockOwnerKey(1)),
      "FAIL — active compressed block owner should stay live"
    );

    console.log("  PASS: live owner keys come from canonical source coverage");
    console.log("TEST 19 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 20 — PROVIDER PAYLOAD FILTER PRUNES BY CANONICAL OWNER, NOT mNNN
  // ---------------------------------------------------------------------------
  test("Test 20 — PROVIDER PAYLOAD FILTER PRUNES BY CANONICAL OWNER, NOT mNNN", () => {
    console.log("TEST 20: provider payload filter uses canonical owners instead of visible ids");

    const liveOwners = new Set([
      buildSourceOwnerKey(0),
      buildSourceOwnerKey(1),
      buildBlockOwnerKey(1),
      buildSourceOwnerKey(3),
      buildSourceOwnerKey(4),
    ]);

    const ownerByMessageRef = new Map([
      ["m001", buildSourceOwnerKey(0)],
      ["m002", buildSourceOwnerKey(1)],
      ["m003", buildSourceOwnerKey(3)],
      ["m004", buildSourceOwnerKey(4)],
      ["m020", buildSourceOwnerKey(20)],
      ["m021", buildSourceOwnerKey(21)],
    ]);

    const payloadInput: any[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: "current head\n<dcp-id>m001</dcp-id>" }],
      },
      { type: "reasoning", encrypted_content: "keep-current" },
      { role: "assistant", content: [{ type: "output_text", text: "current reply" }] },
      {
        role: "assistant",
        content: [
          { type: "output_text", text: "\n<dcp-id>m002</dcp-id>\n<dcp-owner>s1</dcp-owner>" },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "stale raw turn\n<dcp-id>m020</dcp-id>\n<dcp-owner>s20</dcp-owner>",
          },
        ],
      },
      { type: "reasoning", encrypted_content: "drop-stale" },
      { role: "assistant", content: [{ type: "output_text", text: "stale reply" }] },
      {
        role: "assistant",
        content: [
          { type: "output_text", text: "\n<dcp-id>m021</dcp-id>\n<dcp-owner>s21</dcp-owner>" },
        ],
      },
      { type: "function_call", name: "bash", call_id: "toolu_old" },
      { type: "function_call_output", call_id: "toolu_old", output: "ok" },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "The conversation history before this point was compacted into the following summary:\n\n<summary>still canonical</summary>",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "[Compressed section: archived]\n\n<agent-summary>\nquoted stale owner <dcp-owner>s20</dcp-owner> inside the summary body\n</agent-summary>\n\n<dcp-block-id>b1</dcp-block-id>",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "latest ask\n<dcp-id>m003</dcp-id>\n<dcp-owner>s3</dcp-owner>",
          },
        ],
      },
      { type: "reasoning", encrypted_content: "keep-latest" },
      { role: "assistant", content: [{ type: "output_text", text: "latest reply" }] },
      {
        role: "assistant",
        content: [
          { type: "output_text", text: "\n<dcp-id>m004</dcp-id>\n<dcp-owner>s4</dcp-owner>" },
        ],
      },
    ];

    assert.strictEqual(
      extractCanonicalOwnerKeyFromMessageLike(payloadInput[11], ownerByMessageRef),
      buildBlockOwnerKey(1),
      "FAIL — compressed block ownership should not be stolen by quoted stale dcp-owner tags inside the summary body"
    );

    const filtered = filterProviderPayloadInput(payloadInput, liveOwners, [], ownerByMessageRef);
    const serialized = JSON.stringify(filtered);

    assert.ok(
      serialized.includes("keep-current"),
      "FAIL — reasoning owned by a live assistant should stay"
    );
    assert.ok(
      serialized.includes("keep-latest"),
      "FAIL — later reasoning owned by a live assistant should stay"
    );
    assert.ok(
      !serialized.includes("drop-stale"),
      "FAIL — reasoning owned by a stale canonical owner should be pruned"
    );
    assert.ok(
      !serialized.includes("stale raw turn"),
      "FAIL — stale raw user turn should be pruned by canonical owner"
    );
    assert.ok(
      !serialized.includes("stale reply"),
      "FAIL — stale assistant message owned by a stale canonical owner should be pruned"
    );
    assert.ok(
      !serialized.includes("toolu_old"),
      "FAIL — function_call/function_call_output owned by a stale assistant should be pruned"
    );
    assert.ok(
      serialized.includes("still canonical"),
      "FAIL — compaction should stay when no removable owner is proven"
    );
    assert.ok(
      serialized.includes("b1"),
      "FAIL — current compressed block should stay in the provider payload"
    );

    console.log("  PASS: provider payload filtering prunes by canonical owner, not visible ids");
    console.log("TEST 20 PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 20b — REDUNDANT COMPRESS TOOL ARTIFACTS ARE NOT SENT TO THE MODEL
  // ---------------------------------------------------------------------------
  test("Test 20b — REDUNDANT COMPRESS TOOL ARTIFACTS ARE NOT SENT TO THE MODEL", () => {
    console.log("TEST 20b: provider payload filter drops redundant compress tool artifacts");

    const liveOwners = new Set([
      buildSourceOwnerKey(0),
      buildSourceOwnerKey(1),
      buildBlockOwnerKey(7),
      buildSourceOwnerKey(3),
      buildSourceOwnerKey(4),
    ]);

    const ownerByMessageRef = new Map([
      ["m001", buildSourceOwnerKey(0)],
      ["m002", buildSourceOwnerKey(1)],
      ["m003", buildSourceOwnerKey(3)],
      ["m004", buildSourceOwnerKey(4)],
      ["m020", buildSourceOwnerKey(20)],
      ["m021", buildSourceOwnerKey(21)],
    ]);

    const payloadInput: any[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: "current ask\n<dcp-id>m001</dcp-id>" }],
      },
      { type: "reasoning", encrypted_content: "keep-current" },
      { role: "assistant", content: [{ type: "output_text", text: "compressing now" }] },
      {
        role: "assistant",
        content: [
          { type: "output_text", text: "\n<dcp-id>m002</dcp-id>\n<dcp-owner>s1</dcp-owner>" },
        ],
      },
      {
        type: "function_call",
        name: "compress",
        call_id: "call_compress",
        arguments: '{"topic":"cleanup"}',
      },
      {
        type: "function_call_output",
        call_id: "call_compress",
        output: "Compressed 1 range(s): cleanup",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "[Compressed section: cleanup]\n\nsummary\n\n<dcp-block-id>b7</dcp-block-id>",
          },
        ],
      },
      { role: "assistant", content: [{ type: "output_text", text: "bash follow-up" }] },
      {
        role: "assistant",
        content: [
          { type: "output_text", text: "\n<dcp-id>m003</dcp-id>\n<dcp-owner>s3</dcp-owner>" },
        ],
      },
      {
        type: "function_call",
        name: "bash",
        call_id: "call_bash",
        arguments: '{"command":"echo ok"}',
      },
      { type: "function_call_output", call_id: "call_bash", output: "ok" },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "latest ask\n<dcp-id>m004</dcp-id>\n<dcp-owner>s4</dcp-owner>",
          },
        ],
      },
    ];

    const compressionBlocks = [
      {
        id: 7,
        active: true,
        compressCallId: "call_compress",
      },
    ];

    const filtered = filterProviderPayloadInput(
      payloadInput,
      liveOwners,
      compressionBlocks,
      ownerByMessageRef
    );
    const serialized = JSON.stringify(filtered);

    assert.ok(
      !serialized.includes("call_compress"),
      "FAIL — compress function call/output should be dropped only when represented by a live block"
    );
    assert.ok(
      !serialized.includes("Compressed 1 range(s): cleanup"),
      "FAIL — redundant successful compress tool result should not be forwarded"
    );
    assert.ok(
      serialized.includes("[Compressed section: cleanup]"),
      "FAIL — rendered compressed block should stay in the provider payload"
    );
    assert.ok(
      serialized.includes("call_bash"),
      "FAIL — live non-compress tool artifacts should still stay"
    );
    assert.ok(
      serialized.includes("keep-current"),
      "FAIL — neighboring live reasoning should still stay"
    );

    console.log(
      "  PASS: redundant compress tool artifacts are removed only when represented by a live block"
    );
    console.log("TEST 20b PASSED\n");
  });

  // ---------------------------------------------------------------------------
  // Test 20c — FAILED / UNREPRESENTED COMPRESS ATTEMPTS REMAIN VISIBLE
  // ---------------------------------------------------------------------------
  test("Test 20c — FAILED / UNREPRESENTED COMPRESS ATTEMPTS REMAIN VISIBLE", () => {
    console.log(
      "TEST 20c: provider payload filter preserves failed or unrepresented compress attempts"
    );

    const liveOwners = new Set([
      buildSourceOwnerKey(0),
      buildSourceOwnerKey(1),
      buildSourceOwnerKey(2),
    ]);

    const ownerByMessageRef = new Map([
      ["m001", buildSourceOwnerKey(0)],
      ["m002", buildSourceOwnerKey(1)],
      ["m003", buildSourceOwnerKey(2)],
    ]);

    const payloadInput: any[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: "current ask\n<dcp-id>m001</dcp-id>" }],
      },
      { role: "assistant", content: [{ type: "output_text", text: "trying compress" }] },
      {
        role: "assistant",
        content: [
          { type: "output_text", text: "\n<dcp-id>m002</dcp-id>\n<dcp-owner>s1</dcp-owner>" },
        ],
      },
      {
        type: "function_call",
        name: "compress",
        call_id: "call_failed_compress",
        arguments: '{"topic":"cleanup"}',
      },
      {
        type: "function_call_output",
        call_id: "call_failed_compress",
        output: "Compression ranges may not end inside the recent protected tail.",
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "latest ask\n<dcp-id>m003</dcp-id>\n<dcp-owner>s2</dcp-owner>",
          },
        ],
      },
    ];

    const filtered = filterProviderPayloadInput(payloadInput, liveOwners, [], ownerByMessageRef);
    const serialized = JSON.stringify(filtered);

    assert.ok(
      serialized.includes("call_failed_compress"),
      "FAIL — failed compress function_call should remain visible when no live block represents it"
    );
    assert.ok(
      serialized.includes("recent protected tail"),
      "FAIL — failed compress tool output should remain visible when no live block represents it"
    );

    console.log("  PASS: failed or unrepresented compress attempts stay visible");
    console.log("TEST 20c PASSED\n");
  });
});
