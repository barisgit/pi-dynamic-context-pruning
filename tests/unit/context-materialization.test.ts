import { describe, expect, test } from "bun:test";
import { materializeContextMessages } from "../../src/application/context-handler.js";
import { filterProviderPayloadInput } from "../../src/domain/provider/payload-filter.js";
import { applyPruning } from "../../src/domain/pruning/index.js";
import { buildSourceOwnerKey } from "../../src/domain/transcript/index.js";
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
});
