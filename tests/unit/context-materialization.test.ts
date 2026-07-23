import { describe, expect, test } from "bun:test";
import { materializeContextMessages } from "../../src/application/context-handler.js";
import { hydrateMissingToolRecords } from "../../src/application/tool-recording.js";
import { filterProviderPayloadInput } from "../../src/domain/provider/payload-filter.js";
import { applyPruning } from "../../src/domain/pruning/index.js";
import { buildBlockOwnerKey, buildSourceOwnerKey } from "../../src/domain/transcript/index.js";
import { createEmptyCompressionBlockMetadata } from "../../src/state.js";
import type { CompressionBlock } from "../../src/types/state.js";
import { makeConfig, makeMessages, makeState } from "../helpers/dcp-test-utils.js";

function makeLegacyToolBlock(): CompressionBlock {
  return {
    id: 4,
    topic: "legacy tool work",
    summary: "legacy summary",
    startTimestamp: 2000,
    endTimestamp: 3000,
    anchorTimestamp: 4000,
    active: true,
    summaryTokenEstimate: 5,
    savedTokenEstimate: 0,
    createdAt: 10,
    activityLogVersion: 1,
    activityLog: [],
    metadata: createEmptyCompressionBlockMetadata(),
  };
}

function textOf(message: any): string {
  return Array.isArray(message.content)
    ? message.content.map((part: any) => part?.text ?? "").join("\n")
    : String(message.content ?? "");
}

describe("context materialization routing", () => {
  test("schema v1 still uses the existing applyPruning path", () => {
    const messages = makeMessages();
    const config = makeConfig();
    const directState = makeState([makeLegacyToolBlock()]);
    const routedState = makeState([makeLegacyToolBlock()]);

    const direct = applyPruning(messages, directState, config);
    const routed = materializeContextMessages(messages, routedState, config);

    expect(routed.mode).toBe("v1");
    expect(routed.messages).toEqual(direct);
    expect(routedState.messageOwnerSnapshot).toEqual(directState.messageOwnerSnapshot);
  });

  test("v1 finalization preserves source owners for messages after a compressed range", () => {
    const messages = [
      ...makeMessages(),
      {
        role: "user",
        content: [{ type: "text", text: "continue after compression" }],
        timestamp: 5000,
      },
      { role: "assistant", content: [{ type: "text", text: "still visible" }], timestamp: 6000 },
    ];
    const state = makeState([makeLegacyToolBlock()]);

    const routed = materializeContextMessages(messages, state, makeConfig());
    const providerFiltered = filterProviderPayloadInput(
      routed.messages as any[],
      routed.liveOwnerKeys,
      state.compressionBlocks,
      state.messageOwnerSnapshot
    );

    expect(routed.liveOwnerKeys.has(buildSourceOwnerKey(4))).toBe(true);
    expect(routed.liveOwnerKeys.has(buildSourceOwnerKey(5))).toBe(true);
    expect([...state.messageOwnerSnapshot.values()]).toContain(buildSourceOwnerKey(4));
    expect([...state.messageOwnerSnapshot.values()]).not.toContain(buildSourceOwnerKey(5));
    expect(
      providerFiltered.some((message: any) =>
        textOf(message).includes("continue after compression")
      )
    ).toBe(true);
    expect(providerFiltered.some((message: any) => textOf(message).includes("still visible"))).toBe(
      true
    );
  });

  test("provider filtering retains a materialized compression block", () => {
    const state = makeState([makeLegacyToolBlock()]);
    const routed = materializeContextMessages(makeMessages(), state, makeConfig());

    const providerFiltered = filterProviderPayloadInput(
      routed.messages as any[],
      routed.liveOwnerKeys,
      state.compressionBlocks,
      state.messageOwnerSnapshot
    );

    expect(routed.liveOwnerKeys.has(buildBlockOwnerKey(4))).toBe(true);
    expect(
      providerFiltered.some((message: any) => textOf(message).includes("legacy summary"))
    ).toBe(true);
  });

  test("rebuilds missing tool records so pre-restart duplicates remain prunable", () => {
    const repeatedOutput = "same file content ".repeat(200);
    const messages: any[] = [
      { role: "user", content: [{ type: "text", text: "first read" }], timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }],
        timestamp: 2000,
      },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: repeatedOutput }],
        isError: false,
        timestamp: 3000,
      },
      { role: "user", content: [{ type: "text", text: "again" }], timestamp: 4000 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "a.ts" } }],
        timestamp: 5000,
      },
      {
        role: "toolResult",
        toolCallId: "read-2",
        toolName: "read",
        content: [{ type: "text", text: repeatedOutput }],
        isError: false,
        timestamp: 6000,
      },
      { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 7000 },
    ];
    const state = makeState();
    const config = makeConfig();
    config.strategies.deduplication.enabled = true;

    const routed = materializeContextMessages(messages, state, config);
    const firstResult = routed.messages.find((message: any) => message.toolCallId === "read-1");

    expect(state.toolCalls.has("read-1")).toBe(true);
    expect(state.toolCalls.has("read-2")).toBe(true);
    expect(state.prunedToolIds.has("read-1")).toBe(true);
    expect(textOf(firstResult)).toContain("[Output removed to save context");
  });

  test("rebuilds string-form tool arguments without collapsing distinct fingerprints", () => {
    const messages: any[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-a", name: "read", arguments: '{"path":"a.ts"}' }],
        timestamp: 1000,
      },
      {
        role: "toolResult",
        toolCallId: "read-a",
        toolName: "read",
        content: [{ type: "text", text: "a" }],
        isError: false,
        timestamp: 2000,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-b", name: "read", arguments: '{"path":"b.ts"}' }],
        timestamp: 3000,
      },
      {
        role: "toolResult",
        toolCallId: "read-b",
        toolName: "read",
        content: [{ type: "text", text: "b" }],
        isError: false,
        timestamp: 4000,
      },
    ];
    const state = makeState();

    hydrateMissingToolRecords(messages, state);

    expect(state.toolCalls.get("read-a")?.inputArgs).toEqual({ path: "a.ts" });
    expect(state.toolCalls.get("read-b")?.inputArgs).toEqual({ path: "b.ts" });
    expect(state.toolCalls.get("read-a")?.inputFingerprint).not.toBe(
      state.toolCalls.get("read-b")?.inputFingerprint
    );
  });
});
