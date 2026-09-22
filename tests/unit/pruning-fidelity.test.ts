import { describe, expect, test } from "bun:test";
import { applyPruning, makeConfig, makeState } from "../helpers/dcp-test-utils.js";
import { hydrateMissingToolRecords } from "../../src/application/tool-recording.js";
import type { DcpMessage } from "../../src/types/message.js";

function pair(
  id: string,
  text: string,
  isError = false,
  args = { path: "config.ts" },
  toolName = "read"
): DcpMessage[] {
  return [
    { role: "assistant", content: [{ type: "toolCall", id, name: toolName, arguments: args }] },
    { role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] },
  ];
}

function exercise(source: DcpMessage[], strategy: "deduplication" | "purgeErrors") {
  const messages: DcpMessage[] = [
    ...source,
    ...Array.from({ length: 12 }, (_, index) => ({ role: "user", content: `Follow-up ${index}` })),
  ];
  messages.forEach((message, index) => {
    message.timestamp = 1000 + index;
  });
  const config = makeConfig();
  config.strategies[strategy].enabled = true;
  config.strategies.pruneCadenceTurns = 1;
  config.strategies.minPruneItemSavedTokens = 0;
  config.strategies.minPruneBatchSavedTokens = 0;
  const state = makeState();
  hydrateMissingToolRecords(messages, state);
  return { state, messages, result: applyPruning(messages, state, config) };
}

describe("composite and multimodal output protection", () => {
  for (const toolName of ["run", "subagent", "workflow"]) {
    test(`${toolName} is not reduced as one generic log, including old persisted selections`, () => {
      const text = `start\n${"log line\n".repeat(40)}Unresolved: do not deploy.\n${"log line\n".repeat(40)}end`;
      const messages: DcpMessage[] = [
        ...pair("composite", text, false, { path: "config.ts" }, toolName),
        ...Array.from({ length: 30 }, () => ({ role: "user", content: "continue" })),
      ];
      messages.forEach((message, index) => {
        message.timestamp = 1000 + index;
      });
      const config = makeConfig();
      config.compress.protectRecentTurns = 1;
      config.strategies.customStrategies = {
        enabled: true,
        defaults: { minAgeTurns: 0, minResultTokens: 0 },
        rules: [{ tools: [toolName], action: "reduce", keep: { headLines: 1, tailLines: 1 } }],
      };
      const state = makeState();
      hydrateMissingToolRecords(messages, state);
      const projected = applyPruning(messages, state, config);
      expect(JSON.stringify(projected)).toContain("Unresolved: do not deploy.");
      expect(state.prunedToolIds.has("composite")).toBe(false);
      state.prunedToolIds.add("composite");
      state.prunedToolActions.set("composite", { action: "reduce", headLines: 1, tailLines: 1 });
      const restored = applyPruning(messages, state, config);
      expect(JSON.stringify(restored)).toContain("Unresolved: do not deploy.");
      expect(state.prunedToolIds.has("composite")).toBe(false);
    });
  }
});

const long = (message: string) => `${message}\n${"diagnostic detail\n".repeat(100)}`;

describe("pruning preserves distinct and unresolved evidence", () => {
  test("equal requests with different results retain both observations", () => {
    const { state, result } = exercise(
      [
        ...pair("before", long("authentication disabled")),
        ...pair("after", long("authentication enabled")),
      ],
      "deduplication"
    );
    expect(state.prunedToolIds.has("before")).toBe(false);
    expect(JSON.stringify(result)).toContain("authentication disabled");
    expect(JSON.stringify(result)).toContain("authentication enabled");
  });

  test("identical request and successful result remain eligible for dedup", () => {
    const { state } = exercise(
      [...pair("before", long("same contents")), ...pair("after", long("same contents"))],
      "deduplication"
    );
    expect(state.prunedToolIds.has("before")).toBe(true);
    expect(state.prunedToolIds.has("after")).toBe(false);
  });

  test("error status is part of result identity", () => {
    const { state } = exercise(
      [...pair("before", long("no response"), true), ...pair("after", long("no response"), false)],
      "deduplication"
    );
    expect(state.prunedToolIds.has("before")).toBe(false);
  });

  test("unresolved failure is not purged merely because it is old", () => {
    const { state, result } = exercise(
      pair("failed", long("migration failed; database untouched"), true),
      "purgeErrors"
    );
    expect(state.prunedToolIds.has("failed")).toBe(false);
    expect(JSON.stringify(result)).toContain("migration failed; database untouched");
  });

  test("legacy age-only selections automatically restore unresolved error evidence", () => {
    const { state, messages } = exercise(
      pair("failed", long("migration still blocked"), true),
      "purgeErrors"
    );
    state.prunedToolIds.add("failed");
    state.prunedToolActions.set("failed", { action: "clear" });
    const config = makeConfig();
    const result = applyPruning(messages, state, config);
    expect(JSON.stringify(result)).toContain("migration still blocked");
    expect(state.prunedToolIds.has("failed")).toBe(false);
  });

  test("unrelated success does not resolve an earlier failure", () => {
    const { state } = exercise(
      [
        ...pair("failed", long("access denied"), true),
        ...pair("unrelated", long("success"), false, { path: "other.ts" }),
      ],
      "purgeErrors"
    );
    expect(state.prunedToolIds.has("failed")).toBe(false);
  });

  test("a later matching success cannot reactivate deprecated error clearing", () => {
    const { state, result, messages } = exercise(
      [
        ...pair("failed", long("access denied"), true),
        ...pair("retry", long("file read successfully")),
      ],
      "purgeErrors"
    );
    expect(state.prunedToolIds.has("failed")).toBe(false);
    expect(JSON.stringify(result)).toContain("access denied");
    expect(JSON.stringify(result)).toContain("file read successfully");
    expect(JSON.stringify(messages)).toContain("access denied");
  });

  test("a later failed retry does not resolve the error", () => {
    const { state } = exercise(
      [
        ...pair("failed", long("access denied"), true),
        ...pair("retry", long("still denied"), true),
      ],
      "purgeErrors"
    );
    expect(state.prunedToolIds.has("failed")).toBe(false);
    expect(state.prunedToolIds.has("retry")).toBe(false);
  });

  test("nontext content is never discarded by exact-text dedup", () => {
    const source = [...pair("before", long("plot")), ...pair("after", long("plot"))];
    for (const message of source) {
      if (message.role === "toolResult")
        message.content.push({ type: "image", data: "image-bytes", mimeType: "image/png" });
    }
    const { state } = exercise(source, "deduplication");
    expect(state.prunedToolIds.has("before")).toBe(false);
  });
});
