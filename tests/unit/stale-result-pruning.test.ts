import { describe, expect, test } from "bun:test";
import { applyPruning, makeConfig, makeState } from "../helpers/dcp-test-utils.js";
import type { DcpConfig } from "../../src/types/config.js";
import type { DcpState, ToolRecord } from "../../src/types/state.js";

function staleConfig(): DcpConfig {
  const cfg = makeConfig();
  cfg.strategies.clearStaleResults = {
    enabled: true,
    minResultTokens: 300,
    clearTools: ["Read", "Bash", "Grep", "read", "bash", "grep"],
  };
  return cfg;
}

function recordTool(state: DcpState, callId: string, opts: Partial<ToolRecord>): void {
  state.toolCalls.set(callId, {
    toolCallId: callId,
    toolName: opts.toolName ?? "Read",
    inputArgs: opts.inputArgs ?? {},
    inputFingerprint: opts.inputFingerprint ?? `${opts.toolName ?? "Read"}::{}`,
    isError: opts.isError ?? false,
    turnIndex: opts.turnIndex ?? 0,
    timestamp: opts.timestamp ?? 1000,
    tokenEstimate: opts.tokenEstimate ?? 500,
  });
}

function padStandalone(count: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `u${i}` }], timestamp: 1000 + i });
  }
  return out;
}

function toolPair(
  id: string,
  opts: { role?: "toolResult" | "bashExecution"; toolName?: string; isError?: boolean } = {}
): any[] {
  const toolName = opts.toolName ?? "Read";
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: toolName, arguments: {} }],
      timestamp: 20_000,
    },
    {
      role: opts.role ?? "toolResult",
      toolCallId: id,
      toolName,
      isError: opts.isError ?? false,
      content: [{ type: "text", text: "large successful output" }],
      timestamp: 20_001,
    },
  ];
}

describe("clearStaleResults heuristic", () => {
  test("selects old large configured-tool results every cadence, regardless of context pressure", () => {
    const messages = [...padStandalone(6), ...toolPair("read_old", { toolName: "Read" })];
    const state = makeState();
    recordTool(state, "read_old", { toolName: "Read", turnIndex: 0, tokenEstimate: 500 });

    applyPruning(messages, state, staleConfig());

    expect(state.prunedToolIds.has("read_old")).toBe(true);
    expect(state.lastHeuristicPruneDecision?.staleCandidates).toBe(1);
    expect(state.lastHeuristicPruneDecision?.committedByStrategy.stale).toBe(1);
  });

  test("fires with no context-pressure signal (cadence-driven, not pressure-gated)", () => {
    const messages = [...padStandalone(6), ...toolPair("read_old", { toolName: "Read" })];
    const state = makeState();
    // lastEffectiveContext* left null, as on a fresh/low-pressure session.
    recordTool(state, "read_old", { toolName: "Read", turnIndex: 0, tokenEstimate: 50_000 });

    applyPruning(messages, state, staleConfig());

    expect(state.prunedToolIds.has("read_old")).toBe(true);
    expect(state.lastHeuristicPruneDecision?.committedByStrategy.stale).toBe(1);
  });

  test("produces nothing when disabled (replay / EQUIVALENCE_CONFIG determinism safety)", () => {
    const messages = [...padStandalone(6), ...toolPair("read_old", { toolName: "Read" })];
    const state = makeState();
    recordTool(state, "read_old", { toolName: "Read", turnIndex: 0, tokenEstimate: 50_000 });

    const cfg = staleConfig();
    cfg.strategies.clearStaleResults.enabled = false;
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("read_old")).toBe(false);
    expect(state.lastHeuristicPruneDecision).toBeNull();
  });

  test("skips results below minResultTokens", () => {
    const messages = [...padStandalone(6), ...toolPair("small", { toolName: "Read" })];
    const state = makeState();
    recordTool(state, "small", { toolName: "Read", turnIndex: 0, tokenEstimate: 299 });

    applyPruning(messages, state, staleConfig());

    expect(state.prunedToolIds.has("small")).toBe(false);
    expect(state.lastHeuristicPruneDecision).toBeNull();
  });

  test("keeps unknown and MCP tools omitted from clearTools", () => {
    const messages = [
      ...padStandalone(6),
      ...toolPair("mcp", { toolName: "mcp__auggie__codebase" }),
    ];
    const state = makeState();
    recordTool(state, "mcp", {
      toolName: "mcp__auggie__codebase",
      turnIndex: 0,
      tokenEstimate: 50_000,
    });

    applyPruning(messages, state, staleConfig());

    expect(state.prunedToolIds.has("mcp")).toBe(false);
    expect(state.lastHeuristicPruneDecision).toBeNull();
  });

  test("skips errored results", () => {
    const messages = [...padStandalone(6), ...toolPair("err", { toolName: "Read", isError: true })];
    const state = makeState();
    recordTool(state, "err", {
      toolName: "Read",
      turnIndex: 0,
      tokenEstimate: 50_000,
      isError: true,
    });

    applyPruning(messages, state, staleConfig());

    expect(state.prunedToolIds.has("err")).toBe(false);
    expect(state.lastHeuristicPruneDecision).toBeNull();
  });

  test("skips results in the protected recent tail", () => {
    const messages = [...padStandalone(6), ...toolPair("recent", { toolName: "Read" })];
    const state = makeState();
    // applyPruning counts this transcript as 7 logical turns, so default
    // protectRecentTurns=4 protects turn indexes >= 3.
    recordTool(state, "recent", { toolName: "Read", turnIndex: 3, tokenEstimate: 50_000 });

    applyPruning(messages, state, staleConfig());

    expect(state.prunedToolIds.has("recent")).toBe(false);
    expect(state.lastHeuristicPruneDecision).toBeNull();
  });

  test("handles bashExecution results in lockstep with toolResult pruning", () => {
    const messages = [
      ...padStandalone(6),
      ...toolPair("bash_old", { role: "bashExecution", toolName: "Bash" }),
    ];
    const state = makeState();
    recordTool(state, "bash_old", { toolName: "Bash", turnIndex: 0, tokenEstimate: 500 });

    const pruned = applyPruning(messages, state, staleConfig());
    const bashResult = pruned.find((message: any) => message.toolCallId === "bash_old");

    expect(state.prunedToolIds.has("bash_old")).toBe(true);
    expect(bashResult?.content?.[0]?.text).toContain("Output removed to save context");
  });
});

describe("prunedToolIds GC", () => {
  test("drops ids absent from current result messages and retains ids still present", () => {
    const messages = [...padStandalone(2), ...toolPair("present", { toolName: "Read" })];
    const state = makeState();
    state.prunedToolIds.add("present");
    state.prunedToolIds.add("absent");

    const pruned = applyPruning(messages, state, makeConfig());
    const presentResult = pruned.find((message: any) => message.toolCallId === "present");

    expect(state.prunedToolIds.has("present")).toBe(true);
    expect(state.prunedToolIds.has("absent")).toBe(false);
    expect(presentResult?.content?.[0]?.text).toContain("Output removed to save context");
  });
});
