import { describe, expect, test } from "bun:test";
import { applyPruning, makeConfig, makeState } from "../helpers/dcp-test-utils.js";
import type { DcpConfig } from "../../src/types/config.js";
import type { DcpState, ToolRecord } from "../../src/types/state.js";

// ---------------------------------------------------------------------------
// strategies.pruneCadenceTurns — bucketed tombstone emission
//
// These tests verify the stateless modulo-bucket gate used by
// applyDeduplication and applyErrorPurging. Eligibility is computed against
// `floor(currentTurn / cadence) * cadence` so the rendered prefix stays
// cache-stable inside a bucket.
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

function errorMsg(callId: string, ts: number, toolName = "read") {
  return {
    role: "toolResult" as const,
    toolCallId: callId,
    toolName,
    isError: true,
    content: [{ type: "text", text: "boom" }],
    timestamp: ts,
  };
}

function makeUserAssistantTurns(count: number): any[] {
  // Each pair (user + assistant text) counts as 2 logical turns under
  // countLogicalTurns (standalone visible messages). We just need
  // currentTurn to climb deterministically.
  const out: any[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      role: "user",
      content: [{ type: "text", text: `u${i}` }],
      timestamp: 1000 + i * 2,
    });
    out.push({
      role: "assistant",
      content: [{ type: "text", text: `a${i}` }],
      timestamp: 1000 + i * 2 + 1,
    });
  }
  return out;
}

function makeCadenceConfig(
  cadence: number,
  opts: { dedup?: boolean; purge?: boolean; turns?: number } = {}
): DcpConfig {
  const cfg = makeConfig();
  cfg.strategies.pruneCadenceTurns = cadence;
  cfg.strategies.deduplication.enabled = opts.dedup ?? false;
  cfg.strategies.purgeErrors.enabled = opts.purge ?? false;
  cfg.strategies.purgeErrors.turns = opts.turns ?? 4;
  return cfg;
}

describe("strategies.pruneCadenceTurns — purgeErrors bucketing", () => {
  test("cadence=1 behaves like legacy per-turn age check", () => {
    const messages: any[] = [
      ...makeUserAssistantTurns(5), // 10 standalone turns → currentTurn = 10
      errorMsg("err_old", 9500),
    ];
    // Inject an assistant tool_use to keep the pair valid for orphan repair
    messages.splice(messages.length - 1, 0, {
      role: "assistant",
      content: [{ type: "toolCall", id: "err_old", name: "read", arguments: {} }],
      timestamp: 9499,
    });

    const state = makeState();
    recordTurn(state, "err_old", { turnIndex: 0, isError: true });
    const cfg = makeCadenceConfig(1, { purge: true, turns: 4 });

    applyPruning(messages, state, cfg);
    expect(state.prunedToolIds.has("err_old")).toBe(true);
  });

  test("cadence=5 holds tombstones inside the open bucket and releases them at the next boundary", () => {
    // purgeErrors.turns = 4, err recorded at turnIndex=0.
    // Eligibility: bucketedTurn(currentTurn,5) - 0 >= 4.
    //
    // The transcript always contains the error pair, which itself counts as
    // one logical tool-exchange turn. We vary the number of leading
    // standalone visible messages so currentTurn = standaloneTurns + 1.
    //
    //   standalone=0 → currentTurn=1 → bucket=0 → 0<4 → NOT eligible
    //   standalone=3 → currentTurn=4 → bucket=0 → 0<4 → NOT eligible
    //   standalone=4 → currentTurn=5 → bucket=5 → 5≥4 → eligible
    //   standalone=8 → currentTurn=9 → bucket=5 → still eligible (same bucket)

    for (const [standaloneTurns, expected] of [
      [0, false],
      [3, false],
      [4, true],
      [8, true],
    ] as const) {
      // makeUserAssistantTurns(n) produces 2n standalone messages → 2n turns
      const pairs = Math.ceil(standaloneTurns / 2);
      const base = makeUserAssistantTurns(pairs);
      // Trim if odd number of standalone turns requested
      const standaloneMessages = base.slice(0, standaloneTurns);
      const messages: any[] = [
        ...standaloneMessages,
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "err", name: "read", arguments: {} }],
          timestamp: 50_000,
        },
        errorMsg("err", 50_001),
      ];
      const state = makeState();
      recordTurn(state, "err", { turnIndex: 0, isError: true });
      const cfg = makeCadenceConfig(5, { purge: true, turns: 4 });
      applyPruning(messages, state, cfg);
      expect(state.prunedToolIds.has("err")).toBe(expected);
    }
  });

  test("repeated applyPruning passes inside the same bucket emit no new tombstones (cache-stable)", () => {
    // 0 standalone turns + 1 tool-exchange turn → currentTurn=1 → bucket=0.
    // err.turnIndex=0 → 0 - 0 = 0 < 4 → NOT eligible.
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "err", name: "read", arguments: {} }],
        timestamp: 90_000,
      },
      errorMsg("err", 90_001),
    ];
    const state = makeState();
    recordTurn(state, "err", { turnIndex: 0, isError: true });
    const cfg = makeCadenceConfig(5, { purge: true, turns: 4 });

    applyPruning(messages, state, cfg);
    applyPruning(messages, state, cfg);
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("err")).toBe(false);
    expect(state.prunedToolIds.size).toBe(0);
  });
});

describe("strategies.pruneCadenceTurns — deduplication bucketing", () => {
  test("cadence=5 does not tombstone duplicates from the open bucket", () => {
    // Two identical-fingerprint tool-exchanges produce 2 logical turns total
    // → currentTurn=2 → bucket=0 with cadence=5.
    // old.turnIndex=0 is NOT < bucket(0) → not eligible.
    const fp = "read::{}";
    const messages: any[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "dup_old", name: "read", arguments: {} }],
        timestamp: 100_000,
      },
      {
        role: "toolResult",
        toolCallId: "dup_old",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "old" }],
        timestamp: 100_001,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "dup_new", name: "read", arguments: {} }],
        timestamp: 100_002,
      },
      {
        role: "toolResult",
        toolCallId: "dup_new",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "new" }],
        timestamp: 100_003,
      },
    ];

    const state = makeState();
    recordTurn(state, "dup_old", { turnIndex: 0, inputFingerprint: fp });
    recordTurn(state, "dup_new", { turnIndex: 1, inputFingerprint: fp });

    const cfg = makeCadenceConfig(5, { dedup: true });
    applyPruning(messages, state, cfg);

    // bucket = 0 → old.turnIndex (0) NOT < 0, so no flush yet
    expect(state.prunedToolIds.has("dup_old")).toBe(false);
    expect(state.prunedToolIds.has("dup_new")).toBe(false);
  });

  test("cadence=5 tombstones duplicates once the bucket boundary passes them", () => {
    // 3 standalone visible turns + 2 tool-exchange turns → currentTurn=5 → bucket=5.
    // old.turnIndex (0) < bucket (5) → prune the old one; new survives.
    const fp = "read::{}";
    const messages: any[] = [
      ...makeUserAssistantTurns(1).slice(0, 1), // 1 standalone
      { role: "user", content: [{ type: "text", text: "u-extra-1" }], timestamp: 150_000 },
      { role: "user", content: [{ type: "text", text: "u-extra-2" }], timestamp: 150_001 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "dup_old", name: "read", arguments: {} }],
        timestamp: 200_000,
      },
      {
        role: "toolResult",
        toolCallId: "dup_old",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "old" }],
        timestamp: 200_001,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "dup_new", name: "read", arguments: {} }],
        timestamp: 200_002,
      },
      {
        role: "toolResult",
        toolCallId: "dup_new",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "new" }],
        timestamp: 200_003,
      },
    ];

    const state = makeState();
    recordTurn(state, "dup_old", { turnIndex: 0, inputFingerprint: fp });
    recordTurn(state, "dup_new", { turnIndex: 4, inputFingerprint: fp });

    const cfg = makeCadenceConfig(5, { dedup: true });
    applyPruning(messages, state, cfg);

    expect(state.prunedToolIds.has("dup_old")).toBe(true);
    expect(state.prunedToolIds.has("dup_new")).toBe(false);
  });
});

describe("strategies.pruneCadenceTurns — reload stability", () => {
  test("tombstone set is a pure function of the transcript (no persisted gate state)", () => {
    // Simulate a "reload" by rebuilding state from scratch using the same
    // tool record metadata. The resulting prunedToolIds set should match
    // the original session.
    const fp = "read::{}";
    const messages: any[] = [
      ...makeUserAssistantTurns(4), // 8 turns
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "err", name: "read", arguments: {} }],
        timestamp: 300_000,
      },
      errorMsg("err", 300_001),
    ];

    const cfg = makeCadenceConfig(5, { purge: true, turns: 4 });

    // Session A: build state, run pruning
    const stateA = makeState();
    recordTurn(stateA, "err", { turnIndex: 1, isError: true, inputFingerprint: fp });
    applyPruning(messages, stateA, cfg);

    // Session B: as if reloaded from persistence — no carryover of any
    // would-be `lastPruneTurn` field; only persisted facts (toolCalls).
    const stateB = makeState();
    recordTurn(stateB, "err", { turnIndex: 1, isError: true, inputFingerprint: fp });
    applyPruning(messages, stateB, cfg);

    expect(Array.from(stateB.prunedToolIds).sort()).toEqual(
      Array.from(stateA.prunedToolIds).sort()
    );
  });
});
