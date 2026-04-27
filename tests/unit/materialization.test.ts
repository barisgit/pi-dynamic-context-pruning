import { describe, expect, test } from "bun:test";
import { materializeTranscript } from "../../src/domain/compression/materialize.js";
import { buildTranscriptSnapshot } from "../../src/domain/transcript/index.js";
import type { CompressionBlockV2 } from "../../src/types/state.js";
import { createEmptyCompressionBlockMetadata } from "../../src/state.js";
import { makeMessages } from "../helpers/dcp-test-utils.js";

function makeBlock(overrides: Partial<CompressionBlockV2>): CompressionBlockV2 {
  return {
    id: 1,
    topic: "test block",
    summary: "summary",
    startSpanKey: "",
    endSpanKey: "",
    status: "active",
    summaryTokenEstimate: 1,
    createdAt: 1,
    activityLogVersion: 1,
    activityLog: [],
    metadata: createEmptyCompressionBlockMetadata(),
    ...overrides,
  };
}

function textOf(message: any): string {
  return message.content?.[0]?.text ?? "";
}

describe("v2 materialization", () => {
  test("replaces an inclusive span range with one compressed block message", () => {
    const messages = makeMessages();
    const snapshot = buildTranscriptSnapshot(messages);
    const block = makeBlock({
      id: 7,
      topic: "tool work",
      summary: "read result summarized",
      startSpanKey: snapshot.spans[1]!.key,
      endSpanKey: snapshot.spans[1]!.key,
    });

    const materialized = materializeTranscript(snapshot, [block], { renderFullBlockCount: 1 });

    expect(materialized.renderedBlockIds).toEqual([7]);
    expect(materialized.messages).toHaveLength(3);
    expect(materialized.messages[0]).toEqual(messages[0]);
    expect(materialized.messages[0]).not.toBe(messages[0]);
    expect(materialized.messages[1]!.role).toBe("user");
    expect(textOf(materialized.messages[1])).toContain("[Compressed section: tool work]");
    expect(textOf(materialized.messages[1])).toContain("read result summarized");
    expect(materialized.messages[2]).toEqual(messages[3]);
  });

  test("skips invalid and overlapping blocks conservatively", () => {
    const messages = makeMessages();
    const snapshot = buildTranscriptSnapshot(messages);
    const firstSpan = snapshot.spans[0]!.key;
    const toolSpan = snapshot.spans[1]!.key;
    const valid = makeBlock({
      id: 1,
      topic: "valid",
      startSpanKey: firstSpan,
      endSpanKey: toolSpan,
    });
    const overlapping = makeBlock({
      id: 2,
      topic: "overlap",
      startSpanKey: toolSpan,
      endSpanKey: toolSpan,
    });
    const invalid = makeBlock({
      id: 3,
      topic: "invalid",
      startSpanKey: "missing",
      endSpanKey: toolSpan,
    });

    const materialized = materializeTranscript(snapshot, [valid, overlapping, invalid], {
      renderFullBlockCount: 1,
    });

    expect(materialized.renderedBlockIds).toEqual([1]);
    expect(materialized.messages).toHaveLength(2);
    expect(textOf(materialized.messages[0])).toContain("[Compressed section: valid]");
    expect(materialized.messages[1]).toEqual(messages[3]);
  });

  test("ages rendered block detail by newest active block first", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1000 },
      { role: "user", content: [{ type: "text", text: "two" }], timestamp: 2000 },
      { role: "user", content: [{ type: "text", text: "three" }], timestamp: 3000 },
    ];
    const snapshot = buildTranscriptSnapshot(messages);
    const longSummary = "x".repeat(500);
    const oldest = makeBlock({
      id: 1,
      topic: "oldest",
      summary: longSummary,
      startSpanKey: snapshot.spans[0]!.key,
      endSpanKey: snapshot.spans[0]!.key,
      createdAt: 1,
    });
    const compact = makeBlock({
      id: 2,
      topic: "compact",
      summary: longSummary,
      startSpanKey: snapshot.spans[1]!.key,
      endSpanKey: snapshot.spans[1]!.key,
      createdAt: 2,
    });
    const newest = makeBlock({
      id: 3,
      topic: "newest",
      summary: longSummary,
      startSpanKey: snapshot.spans[2]!.key,
      endSpanKey: snapshot.spans[2]!.key,
      createdAt: 3,
    });

    const materialized = materializeTranscript(snapshot, [oldest, compact, newest], {
      renderFullBlockCount: 1,
      renderCompactBlockCount: 1,
    });

    expect(materialized.renderedBlockIds).toEqual([1, 2, 3]);
    expect(textOf(materialized.messages[0])).not.toContain("<agent-summary>");
    expect(textOf(materialized.messages[0]).length).toBeLessThan(260);
    expect(textOf(materialized.messages[1])).toContain("<agent-summary>");
    expect(textOf(materialized.messages[1]).length).toBeLessThan(430);
    expect(textOf(materialized.messages[2])).toContain(longSummary);
  });
});
