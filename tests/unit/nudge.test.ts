import { describe, expect, test } from "bun:test";
import { REMINDER_UPSERT_EVENT } from "pi-reminders/src/types.js";
import type { ReminderIntent } from "pi-reminders/src/types.js";
import {
  assert,
  exceedsMaxContextLimit,
  getNudgeDecisionReason,
  getNudgeType,
  makeConfig,
  makeMessages,
  makeState,
  registerContextHandler,
} from "../helpers/dcp-test-utils.js";

type PiHandler = (event: any, ctx: any) => unknown;

function createMockPi() {
  const handlers = new Map<string, PiHandler>();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const pi = {
    events: {
      emit(name: string, payload: unknown) {
        emitted.push({ name, payload });
      },
    },
    on(name: string, handler: PiHandler) {
      handlers.set(name, handler);
    },
  };

  return { pi, handlers, emitted };
}

function createMockContext(tokens: number, contextWindow: number) {
  return {
    getContextUsage: () => ({ tokens, contextWindow }),
    sessionManager: {
      getCwd: () => process.cwd(),
      getSessionDir: () => process.cwd(),
      getSessionFile: () => undefined,
      getSessionId: () => "test-session",
      getLeafId: () => null,
    },
    ui: {
      setStatus: () => undefined,
    },
  };
}

describe("DCP nudge.test", () => {
  test("context nudges publish a pi-reminders intent without mutating rendered messages", async () => {
    const config = makeConfig();
    config.compress.minContextPercent = 0.1;
    config.compress.maxContextPercent = 0.5;
    config.compress.nudgeForce = "strong";

    const state = makeState();
    const messages = makeMessages();
    const { pi, handlers, emitted } = createMockPi();

    registerContextHandler(pi as any, state, config);
    const contextHandler = handlers.get("context");
    expect(contextHandler).toBeDefined();

    const result = await contextHandler!({ messages }, createMockContext(90_000, 100_000));

    const upserts = emitted.filter((event) => event.name === REMINDER_UPSERT_EVENT);
    expect(upserts).toHaveLength(1);

    const reminder = upserts[0]!.payload as ReminderIntent;
    expect(reminder).toMatchObject({
      source: "dcp",
      id: "nudge",
      label: "DCP",
      ttl: "once",
      priority: 100,
      display: true,
    });
    expect(reminder.metadata).toMatchObject({
      nudgeType: "context-strong",
      contextPercent: 0.9,
      contextTokens: 90_000,
      currentTurn: state.currentTurn,
    });
    expect(getNudgeDecisionReason(0.9, state, config, "context-strong", 90_000)).toBe("emitted");
    expect(state.lastNudgeTurn).toBe(state.currentTurn);

    expect(reminder.text.trim().length).toBeGreaterThan(0);
    expect(reminder.text).toContain("Compress now");
    expect(reminder.text).toContain("Protected hot tail");
    expect(reminder.text).not.toContain("dcp-system-reminder");
    expect(reminder.text).not.toContain("<");
    expect(reminder.text).not.toContain(">");

    const renderedMessages = JSON.stringify((result as { messages: unknown[] }).messages);
    expect(renderedMessages).not.toContain("<reminders>");
    expect(renderedMessages).not.toContain("<system-reminder>");
    expect(renderedMessages).not.toContain(reminder.text.trim());
  });

  // ---------------------------------------------------------------------------
  // Test 13 — TURN NUDGES SHOULD RESPECT TURN DEBOUNCE AND COMPRESS COOL-DOWN
  // ---------------------------------------------------------------------------
  test("Test 13 — TURN NUDGES SHOULD RESPECT TURN DEBOUNCE AND COMPRESS COOL-DOWN", () => {
    console.log("TEST 13: turn nudge debounce + post-compress suppression");

    const config = makeConfig();
    config.compress.minContextPercent = 0.75;
    config.compress.maxContextPercent = 0.9;
    config.compress.nudgeDebounceTurns = 2;

    const state = makeState();
    state.currentTurn = 5;
    state.lastNudgeTurn = 5;

    assert.strictEqual(
      getNudgeType(0.8, state, config, 0),
      null,
      "FAIL — should not emit a turn nudge twice in the same logical turn"
    );

    state.currentTurn = 6;
    state.lastNudgeTurn = 5;
    assert.strictEqual(
      getNudgeType(0.8, state, config, 0),
      null,
      "FAIL — should debounce for one newer logical turn when debounceTurns=2"
    );

    state.currentTurn = 7;
    state.lastNudgeTurn = 5;
    assert.strictEqual(
      getNudgeType(0.8, state, config, 0),
      "turn",
      "FAIL — should emit once enough newer logical turns have happened"
    );
    assert.strictEqual(
      getNudgeType(0.75, state, config, 0),
      "turn",
      "FAIL — hitting the exact minimum threshold should now be enough to emit a nudge"
    );

    state.currentTurn = 7;
    state.lastCompressTurn = 7;
    state.lastNudgeTurn = 7;
    assert.strictEqual(
      getNudgeType(0.95, state, config, 0),
      null,
      "FAIL — should not emit in the same logical turn that already compressed"
    );

    state.currentTurn = 8;
    assert.strictEqual(
      getNudgeType(0.95, state, config, 0),
      null,
      "FAIL — should stay quiet on the first newer logical turn after compress when debounceTurns=2"
    );

    state.currentTurn = 9;
    assert.strictEqual(
      getNudgeType(0.95, state, config, 0),
      "context-soft",
      "FAIL — should re-emit once compress cool-down and debounce are both satisfied"
    );

    console.log("  PASS: turn debounce and post-compress suppression work");
    console.log("TEST 13 PASSED\n");
  });

  test("max-token nudges use action wording even when percent is low", async () => {
    const config = makeConfig();
    config.compress.minContextPercent = 0.4;
    config.compress.maxContextPercent = 0.8;
    config.compress.minContextTokens = 120_000;
    config.compress.maxContextTokens = 200_000;
    config.compress.nudgeForce = "soft";

    const state = makeState();
    const messages = makeMessages();
    const { pi, handlers, emitted } = createMockPi();

    registerContextHandler(pi as any, state, config);
    await handlers.get("context")!({ messages }, createMockContext(203_000, 1_000_000));

    const upsert = emitted.find((event) => event.name === REMINDER_UPSERT_EVENT);
    expect(upsert).toBeDefined();
    const reminder = upsert!.payload as ReminderIntent;
    expect(reminder.metadata).toMatchObject({ nudgeType: "context-soft", contextTokens: 203_000 });
    expect(reminder.text).toContain("Compress now");
    expect(reminder.text).toContain("120k-200k tokens");
    expect(reminder.text).not.toContain("16%");
  });

  test("token thresholds are ORed with percent thresholds", () => {
    const config = makeConfig();
    config.compress.minContextPercent = 0.75;
    config.compress.maxContextPercent = 0.9;
    config.compress.minContextTokens = 150_000;
    config.compress.maxContextTokens = 200_000;

    const state = makeState();
    state.currentTurn = 5;
    state.lastNudgeTurn = -1;

    assert.strictEqual(
      getNudgeType(0.2, state, config, 0, 149_999),
      null,
      "FAIL — should stay quiet below both percent and token minimum thresholds"
    );
    assert.strictEqual(
      getNudgeType(0.2, state, config, 0, 150_000),
      "turn",
      "FAIL — absolute token minimum should allow nudges even when percent is low"
    );
    assert.strictEqual(
      getNudgeType(0.2, state, config, 0, 200_001),
      "context-soft",
      "FAIL — absolute token maximum should trigger context nudge even when percent is low"
    );
    assert.strictEqual(
      exceedsMaxContextLimit(0.2, config, 200_001),
      true,
      "FAIL — hot-tail emergency override should honor maxContextTokens"
    );
  });

  test("nudge decision reasons distinguish cache-relevant suppression paths", () => {
    const config = makeConfig();
    config.compress.minContextPercent = 0.75;
    config.compress.nudgeDebounceTurns = 2;

    const state = makeState();
    state.currentTurn = 5;

    expect(getNudgeDecisionReason(null, state, config, null, null)).toBe("no_context_usage");

    state.manualMode = true;
    expect(getNudgeDecisionReason(0.8, state, config, null, 80_000)).toBe("manual_mode");

    state.manualMode = false;
    expect(getNudgeDecisionReason(0.2, state, config, null, 20_000)).toBe("below_min_threshold");

    state.lastCompressTurn = 5;
    expect(getNudgeDecisionReason(0.8, state, config, null, 80_000)).toBe(
      "same_turn_or_post_compress_debounce"
    );

    state.currentTurn = 6;
    state.lastCompressTurn = -1;
    state.lastNudgeTurn = 5;
    expect(getNudgeDecisionReason(0.8, state, config, null, 80_000)).toBe("turn_debounce");
  });
});
