import { describe, expect, test } from "bun:test";
import { applyPruning, makeConfig, makeState } from "../helpers/dcp-test-utils.js";
import type { DcpConfig } from "../../src/types/config.js";
import type { DcpState, ToolRecord } from "../../src/types/state.js";

// ---------------------------------------------------------------------------
// strategies.minPruneItemSavedTokens / minPruneBatchSavedTokens
//
// Net-savings gate (Anthropic clear_at_least analogue): a dedup/error tombstone
// is only worth a prefix-cache break if it saves enough tokens. Per-item drops
// tiny outputs; batch holds the whole flush until it clears the bar. Both are
// bypassed when the live effective context (prior pass) is in the red zone.
//
// Fixed tombstone token costs (o200k): error = 13, dedup/output = 15. So for an
// error result, netSaved = tokenEstimate - 13.
// ---------------------------------------------------------------------------

function recordTurn(state: DcpState, callId: string, opts: Partial<ToolRecord>) {
  state.toolCalls.set(callId, {
    toolCallId: callId,
    toolName: opts.toolName ?? "read",
    inputArgs: opts.inputArgs ?? {},
    inputFingerprint: opts.inputFingerprint ?? `${opts.toolName ?? "read"}::{}`,
    isError: opts.isError ?? false,
    turnIndex: opts.turnIndex ?? 0,
    timestamp: opts.timestamp ?? 1000,
    tokenEstimate: opts.tokenEstimate ?? 5,
  });
}

function errorPair(id: string, baseTs: number): any[] {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "read", arguments: {} }],
      timestamp: baseTs,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "boom" }],
      timestamp: baseTs + 1,
    },
  ];
}

function padStandalone(count: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ role: "user", content: [{ type: "text", text: `u${i}` }], timestamp: 1000 + i });
  }
  return out;
}

function duplicateReadMessages(): any[] {
  return [
    ...padStandalone(6),
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "old", name: "read", arguments: {} }],
      timestamp: 300_000,
    },
    {
      role: "toolResult",
      toolCallId: "old",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "old output" }],
      timestamp: 300_001,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "new", name: "read", arguments: {} }],
      timestamp: 300_002,
    },
    {
      role: "toolResult",
      toolCallId: "new",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "new output" }],
      timestamp: 300_003,
    },
  ];
}

function makeMinSavingsConfig(opts: {
  turns?: number;
  dedup?: boolean;
  purge?: boolean;
  minItem?: number;
  minBatch?: number;
}): DcpConfig {
  const cfg = makeConfig();
  cfg.strategies.pruneCadenceTurns = 1;
  cfg.strategies.purgeErrors.enabled = opts.purge ?? true;
  cfg.strategies.purgeErrors.turns = opts.turns ?? 4;
  cfg.strategies.deduplication.enabled = opts.dedup ?? false;
  cfg.strategies.minPruneItemSavedTokens = opts.minItem ?? 0;
  cfg.strategies.minPruneBatchSavedTokens = opts.minBatch ?? 0;
  return cfg;
}

describe("min-savings gate — batch threshold", () => {
  test("holds tombstones when the eligible batch saves less than minPruneBatchSavedTokens", () => {
    // One error candidate, tokenEstimate=100 → netSaved = 100 - 13 = 87.
    const messages = [...padStandalone(4), ...errorPair("err", 50_000)];
    const state = makeState();
    recordTurn(state, "err", { turnIndex: 0, isError: true, tokenEstimate: 100 });

    const cfg = makeMinSavingsConfig({ minBatch: 200 });
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("err")).toBe(false);
    expect(state.prunedToolIds.size).toBe(0);
  });

  test("flushes once the eligible batch clears minPruneBatchSavedTokens", () => {
    const messages = [...padStandalone(4), ...errorPair("err", 50_000)];
    const state = makeState();
    recordTurn(state, "err", { turnIndex: 0, isError: true, tokenEstimate: 100 });

    const cfg = makeMinSavingsConfig({ minBatch: 50 });
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("err")).toBe(true);
  });

  test("two small candidates that individually miss but jointly clear the batch all flush", () => {
    // Each error: tokenEstimate=60 → netSaved=47. Batch = 94 ≥ 80.
    const messages = [
      ...padStandalone(3),
      ...errorPair("err_a", 60_000),
      ...errorPair("err_b", 61_000),
    ];
    const state = makeState();
    recordTurn(state, "err_a", { turnIndex: 0, isError: true, tokenEstimate: 60 });
    recordTurn(state, "err_b", { turnIndex: 0, isError: true, tokenEstimate: 60 });

    const cfg = makeMinSavingsConfig({ minBatch: 80 });
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("err_a")).toBe(true);
    expect(state.prunedToolIds.has("err_b")).toBe(true);
  });
});

describe("min-savings gate — per-item threshold", () => {
  test("skips tiny outputs below minPruneItemSavedTokens but keeps large ones", () => {
    // err_small: tokenEstimate=10 → netSaved = -3 (below 20 → skip)
    // err_big:   tokenEstimate=100 → netSaved = 87 (≥ 20 → keep)
    const messages = [
      ...padStandalone(3),
      ...errorPair("err_small", 70_000),
      ...errorPair("err_big", 71_000),
    ];
    const state = makeState();
    recordTurn(state, "err_small", { turnIndex: 0, isError: true, tokenEstimate: 10 });
    recordTurn(state, "err_big", { turnIndex: 0, isError: true, tokenEstimate: 100 });

    const cfg = makeMinSavingsConfig({ minItem: 20, minBatch: 0 });
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("err_small")).toBe(false);
    expect(state.prunedToolIds.has("err_big")).toBe(true);
  });
});

describe("min-savings gate — red-zone bypass", () => {
  test("bypasses the batch gate when the prior-pass effective context is in the red zone", () => {
    const messages = [...padStandalone(4), ...errorPair("err", 80_000)];
    const state = makeState();
    recordTurn(state, "err", { turnIndex: 0, isError: true, tokenEstimate: 100 });
    // Prior-pass effective context above maxContextPercent (0.8 in makeConfig).
    state.lastEffectiveContextPercent = 0.95;
    state.lastEffectiveContextTokens = null;

    const cfg = makeMinSavingsConfig({ minBatch: 100_000, minItem: 100_000 });
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("err")).toBe(true);
  });

  test("bypasses via absolute-token red zone when the host reports no context window (null percent)", () => {
    const messages = [...padStandalone(4), ...errorPair("err", 85_000)];
    const state = makeState();
    recordTurn(state, "err", { turnIndex: 0, isError: true, tokenEstimate: 100 });
    // Host did not report a context window → percent is null, but effective
    // tokens are known and above the absolute-token red zone.
    state.lastEffectiveContextPercent = null;
    state.lastEffectiveContextTokens = 250_000;

    const cfg = makeMinSavingsConfig({ minBatch: 100_000, minItem: 100_000 });
    cfg.compress.maxContextTokens = 200_000;
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("err")).toBe(true);
  });

  test("below the red zone, the same huge batch threshold holds the tombstone", () => {
    const messages = [...padStandalone(4), ...errorPair("err", 80_000)];
    const state = makeState();
    recordTurn(state, "err", { turnIndex: 0, isError: true, tokenEstimate: 100 });
    state.lastEffectiveContextPercent = 0.5; // below maxContextPercent

    const cfg = makeMinSavingsConfig({ minBatch: 100_000 });
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("err")).toBe(false);
  });
});

describe("min-savings gate — defaults preserve legacy behavior", () => {
  test("with both thresholds 0, even a net-negative tiny output is pruned (gate off)", () => {
    // tokenEstimate=5 → netSaved = 5 - 13 = -8, but gates are off by default.
    const messages = [...padStandalone(4), ...errorPair("err", 90_000)];
    const state = makeState();
    recordTurn(state, "err", { turnIndex: 0, isError: true, tokenEstimate: 5 });

    const cfg = makeMinSavingsConfig({ minItem: 0, minBatch: 0 });
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("err")).toBe(true);
  });
});

describe("min-savings gate — deduplication candidates", () => {
  test("records the per-pass heuristic pruning decision for dedup commits and batch holds", () => {
    const messages = duplicateReadMessages();
    const cfg = makeMinSavingsConfig({ purge: false, dedup: true, minBatch: 0 });

    const committedState = makeState();
    recordTurn(committedState, "old", {
      turnIndex: 0,
      inputFingerprint: "read::{same}",
      tokenEstimate: 100,
    });
    recordTurn(committedState, "new", {
      turnIndex: 1,
      inputFingerprint: "read::{same}",
      tokenEstimate: 100,
    });
    applyPruning(messages, committedState, cfg);

    expect(committedState.lastHeuristicPruneDecision).not.toBeNull();
    expect(committedState.lastHeuristicPruneDecision?.uniqueCandidates).toBe(1);
    expect(committedState.lastHeuristicPruneDecision?.committed).toBe(1);

    const heldState = makeState();
    recordTurn(heldState, "old", {
      turnIndex: 0,
      inputFingerprint: "read::{same}",
      tokenEstimate: 100,
    });
    recordTurn(heldState, "new", {
      turnIndex: 1,
      inputFingerprint: "read::{same}",
      tokenEstimate: 100,
    });
    const heldCfg = makeMinSavingsConfig({ purge: false, dedup: true, minBatch: 100_000 });
    applyPruning(messages, heldState, heldCfg);

    expect(heldState.lastHeuristicPruneDecision).not.toBeNull();
    expect(heldState.lastHeuristicPruneDecision?.heldByBatchGate).toBe(true);
    expect(heldState.lastHeuristicPruneDecision?.committed).toBe(0);
  });

  test("dedup duplicate below per-item threshold is held; large duplicate flushes", () => {
    // Dedup tombstone cost = 15. Build two separate fingerprints, each with a
    // closed-bucket old duplicate + a newer survivor.
    const fpSmall = "read::{small}";
    const fpBig = "read::{big}";
    const messages: any[] = [
      ...padStandalone(6),
      // small fingerprint: old + new
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "small_old", name: "read", arguments: {} }],
        timestamp: 200_000,
      },
      {
        role: "toolResult",
        toolCallId: "small_old",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "s" }],
        timestamp: 200_001,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "small_new", name: "read", arguments: {} }],
        timestamp: 200_002,
      },
      {
        role: "toolResult",
        toolCallId: "small_new",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "s" }],
        timestamp: 200_003,
      },
      // big fingerprint: old + new
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "big_old", name: "read", arguments: {} }],
        timestamp: 200_004,
      },
      {
        role: "toolResult",
        toolCallId: "big_old",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "b" }],
        timestamp: 200_005,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "big_new", name: "read", arguments: {} }],
        timestamp: 200_006,
      },
      {
        role: "toolResult",
        toolCallId: "big_new",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "b" }],
        timestamp: 200_007,
      },
    ];

    const state = makeState();
    // Old duplicates sit in a closed bucket (turnIndex 0); survivors newer.
    recordTurn(state, "small_old", { turnIndex: 0, inputFingerprint: fpSmall, tokenEstimate: 20 });
    recordTurn(state, "small_new", { turnIndex: 1, inputFingerprint: fpSmall, tokenEstimate: 20 });
    recordTurn(state, "big_old", { turnIndex: 0, inputFingerprint: fpBig, tokenEstimate: 100 });
    recordTurn(state, "big_new", { turnIndex: 1, inputFingerprint: fpBig, tokenEstimate: 100 });

    // small_old netSaved = 20 - 15 = 5 (below 20 → skip)
    // big_old   netSaved = 100 - 15 = 85 (≥ 20 → keep)
    const cfg = makeMinSavingsConfig({ purge: false, dedup: true, minItem: 20, minBatch: 0 });
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("small_old")).toBe(false);
    expect(state.prunedToolIds.has("big_old")).toBe(true);
    expect(state.prunedToolIds.has("small_new")).toBe(false);
    expect(state.prunedToolIds.has("big_new")).toBe(false);
  });
});
