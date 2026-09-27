import { expect, test } from "bun:test";
import {
  applyPruning,
  makeConfig,
  makeState,
  resolveAnchorSourceKey,
} from "../helpers/dcp-test-utils.js";

for (const { anchorSourceKey, anchorTimestamp } of [
  { anchorSourceKey: "raw:first-result", anchorTimestamp: 3000 },
  { anchorSourceKey: "raw:second-result", anchorTimestamp: 4000 },
  // A positional source key can become stale when the source buffer changes.
  { anchorSourceKey: "msg:3000:toolResult:call-a:9", anchorTimestamp: 4000 },
]) {
  test(`compressed summary stays before a multi-result tool exchange (${anchorSourceKey})`, () => {
    const messages: any[] = [
      {
        id: "old-user",
        role: "user",
        content: [{ type: "text", text: "old work" }],
        timestamp: 1000,
      },
      {
        id: "assistant",
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-a", name: "read", arguments: {} },
          { type: "toolCall", id: "call-b", name: "read", arguments: {} },
        ],
        timestamp: 2000,
      },
      {
        id: "first-result",
        role: "toolResult",
        toolCallId: "call-a",
        toolName: "read",
        content: [{ type: "text", text: "A" }],
        timestamp: 3000,
      },
      {
        id: "second-result",
        role: "toolResult",
        toolCallId: "call-b",
        toolName: "read",
        content: [{ type: "text", text: "B" }],
        timestamp: 4000,
      },
      {
        id: "later-user",
        role: "user",
        content: [{ type: "text", text: "continue" }],
        timestamp: 5000,
      },
    ];
    const state = makeState([
      {
        id: 1,
        topic: "old work",
        summary: "Earlier work was summarized.",
        startTimestamp: 1000,
        endTimestamp: 1000,
        anchorTimestamp,
        startSourceKey: "raw:old-user",
        endSourceKey: "raw:old-user",
        anchorSourceKey,
        active: true,
        summaryTokenEstimate: 10,
        createdAt: 1,
      },
    ]);

    if (anchorSourceKey === "raw:first-result") {
      // Assistant messages have no visible ref; the live anchor resolver sees
      // the first tool result as the next message after the compressed range.
      state.messageRefSnapshot.set("m0002", {
        ref: "m0002",
        sourceKey: "raw:first-result",
        timestamp: 3000,
        ownerKey: "s2",
      });
      expect(resolveAnchorSourceKey(1000, "raw:old-user", state)).toBe(anchorSourceKey);
    }

    const result = applyPruning(messages, state, makeConfig());
    expect(result.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(result[0].content[0].text).toContain("Earlier work was summarized.");
    expect(result[2].toolCallId).toBe("call-a");
    expect(result[3].toolCallId).toBe("call-b");
  });
}
