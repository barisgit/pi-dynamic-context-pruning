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

function withOwner<T extends object>(item: T, ownerKey: string): T {
  Object.defineProperty(item, "__dcpOwnerKey", {
    value: ownerKey,
    enumerable: false,
    configurable: true,
  });
  return item;
}

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
      withOwner(
        { role: "assistant", content: [{ type: "output_text", text: "current reply" }] },
        buildSourceOwnerKey(1)
      ),
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
      withOwner(
        { role: "assistant", content: [{ type: "output_text", text: "stale reply" }] },
        buildSourceOwnerKey(21)
      ),
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
      withOwner(
        { role: "assistant", content: [{ type: "output_text", text: "latest reply" }] },
        buildSourceOwnerKey(4)
      ),
    ];

    assert.strictEqual(
      extractCanonicalOwnerKeyFromMessageLike(payloadInput[9], ownerByMessageRef),
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
  // Test 20b — REPRESENTED COMPRESS TOOL ARTIFACTS BECOME A RECEIPT
  // ---------------------------------------------------------------------------
  test("Test 20b — REPRESENTED COMPRESS TOOL ARTIFACTS BECOME A RECEIPT", () => {
    console.log(
      "TEST 20b: provider payload filter keeps newest compress receipt and drops older duplicates"
    );

    const liveOwners = new Set([
      buildSourceOwnerKey(0),
      buildSourceOwnerKey(1),
      buildBlockOwnerKey(6),
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

    const blockOwnerTag = (id: number): string => `<` + `dcp-block-id>b${id}</` + `dcp-block-id>`;

    const payloadInput: any[] = [
      {
        role: "user",
        content: [{ type: "input_text", text: "current ask\n" }],
      },
      { type: "reasoning", encrypted_content: "keep-current" },
      withOwner(
        { role: "assistant", content: [{ type: "output_text", text: "compressing now" }] },
        buildSourceOwnerKey(1)
      ),
      {
        type: "function_call",
        name: "compress",
        call_id: "call_old_compress",
        arguments: '{"topic":"old cleanup"}',
      },
      {
        type: "function_call_output",
        call_id: "call_old_compress",
        output: "Compressed 1 range(s): old cleanup",
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
            text:
              "[Compressed section: old cleanup]\n\nold summary\n\n" +
              blockOwnerTag(6) +
              "\n\n[Compressed section: cleanup]\n\nsummary\n\n" +
              blockOwnerTag(7),
          },
        ],
      },
      withOwner(
        { role: "assistant", content: [{ type: "output_text", text: "bash follow-up" }] },
        buildSourceOwnerKey(4)
      ),
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
            text: "latest ask\n\n",
          },
        ],
      },
    ];

    const compressionBlocks = [
      {
        id: 6,
        topic: "old cleanup",
        active: true,
        compressCallId: "call_old_compress|fc_old_provider_item",
      },
      {
        id: 7,
        topic: "cleanup",
        active: true,
        compressCallId: "call_compress|fc_provider_item",
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
      !serialized.includes("call_old_compress"),
      "FAIL — older represented compress function call/output should be dropped"
    );
    assert.ok(
      serialized.includes("call_compress"),
      "FAIL — newest represented compress function call/output should remain as a receipt"
    );
    assert.ok(
      serialized.includes("receiptOnly"),
      "FAIL — newest represented compress function call should be minified to receipt arguments"
    );
    assert.ok(
      !serialized.includes("Compressed 1 range(s): cleanup"),
      "FAIL — raw successful compress tool result should not be forwarded"
    );
    assert.ok(
      serialized.includes("Compression succeeded. Created b7: cleanup"),
      "FAIL — newest represented compress tool output should be replaced by a success receipt"
    );
    assert.ok(
      serialized.includes("Do not call compress again in this assistant turn"),
      "FAIL — receipt should warn against same-turn repeat compression with stale ids"
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
      "  PASS: newest represented compress artifacts are receipts and older duplicates are removed"
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
      withOwner(
        { role: "assistant", content: [{ type: "output_text", text: "trying compress" }] },
        buildSourceOwnerKey(1)
      ),
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

  // ---------------------------------------------------------------------------
  // Test 20d — NEVER DROP PI NATIVE COMPACTION SUMMARY USER MESSAGE
  // ---------------------------------------------------------------------------
  test("Test 20d — NEVER DROP PI NATIVE COMPACTION SUMMARY USER MESSAGE", () => {
    // Reproduce: post-compaction, blocks bN are deactivated; the converted
    // compactionSummary user message contains DCP markers from materialized
    // block bodies. The filter must NOT use those markers to drop it.
    const liveOwners = new Set<string>(["source:msg-tail"]);
    const ownerByMessageRef = new Map<string, string>();

    const payloadInput: any[] = [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: 'The conversation history before this point was compacted into the following summary:\n\n<dcp-summary version="1">\n<section topic="Sample">\n[Compressed section: Sample]\n<agent-summary>\nbody\n</agent-summary>\n<activity-log>\nu: hi\n<dcp-block-id>b7</dcp-block-id>\n</activity-log>\n</section>\n</dcp-summary>',
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "recent live ask\n" }],
      },
    ];

    const filtered = filterProviderPayloadInput(payloadInput, liveOwners, [], ownerByMessageRef);
    const serialized = JSON.stringify(filtered);

    assert.strictEqual(
      filtered.length,
      2,
      "FAIL — compaction summary user message must survive even when its block markers reference deactivated blocks"
    );
    assert.ok(
      serialized.includes("into the following summary"),
      "FAIL — compaction summary text must reach the provider payload"
    );

    console.log("  PASS: native compaction summary user message survives filter");
    console.log("TEST 20d PASSED\n");
  });
});
