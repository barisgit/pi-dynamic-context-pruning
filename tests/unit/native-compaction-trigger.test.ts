import { describe, expect, test } from "bun:test";

import { decideNativeCompactionAutoTrigger } from "../../src/application/compress-tool/registration.js";
import { makeConfig, makeState } from "../helpers/dcp-test-utils.js";

// ---------------------------------------------------------------------------
// Native compaction auto-trigger: count the live (post-compaction) window
//
// Native compaction exists to relieve TUI render pressure, which is only the
// window the TUI actually renders: the latest `compaction` summary plus
// everything after it. Pre-compaction `message` entries stay on disk for
// lineage but are NOT rendered. The auto-trigger must measure that live window,
// not the full root->leaf lineage. Otherwise a session that already compacted
// keeps counting thousands of hidden historical messages and re-fires
// `force-threshold` against a tiny visible transcript (the observed bug:
// "2083 estimated compactable messages" / "0.04 coverage" with ~124 visible).
// ---------------------------------------------------------------------------

function userMessage(text: string, timestamp: number): any {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function compactionEntry(timestamp: number): any {
  return {
    role: "compaction",
    content: [{ type: "text", text: "prior compaction summary" }],
    timestamp,
  };
}

function activeBlock(): any {
  return {
    id: 1,
    topic: "old work",
    summary: "summary",
    startTimestamp: 1000,
    endTimestamp: 1010,
    anchorTimestamp: 1011,
    active: true,
    summaryTokenEstimate: 10,
    createdAt: 1,
  };
}

describe("native compaction auto-trigger window", () => {
  test("counts only the live window after the last compaction boundary", () => {
    const config = makeConfig();
    // Lower the thresholds so the test is about the boundary, not the numbers.
    config.nativeCompaction.autoTriggerMessageCount = 5;
    config.nativeCompaction.autoTriggerForceMessageCount = 10;
    config.nativeCompaction.minActiveBlockCount = 1;

    const messages: any[] = [];
    // 50 pre-compaction real messages (hidden lineage on disk).
    for (let i = 0; i < 50; i++) {
      messages.push(userMessage(`old ${i}`, 1000 + i));
    }
    // The compaction boundary the TUI renders from.
    messages.push(compactionEntry(2000));
    // A tiny live window after it: only 3 real messages.
    messages.push(userMessage("live 1", 3001));
    messages.push(userMessage("live 2", 3002));
    messages.push(userMessage("live 3", 3003));

    // protectRecentTurns=0 so the tail does not exclude the live window items.
    config.compress.protectRecentTurns = 0;

    const decision = decideNativeCompactionAutoTrigger(
      messages,
      makeState([activeBlock()]),
      config,
      1
    );

    // The live window has 3 compactable items, not 53.
    expect(decision.estimatedCompactableMessageCount).toBe(3);
    // 3 < lowerMessageThreshold(5) => below-lower-threshold, not force-threshold.
    expect(decision.reason).toBe("below-lower-threshold");
    expect(decision.queued).toBe(false);
  });

  test("without a compaction boundary it still counts the full lineage", () => {
    const config = makeConfig();
    config.nativeCompaction.autoTriggerMessageCount = 5;
    config.nativeCompaction.autoTriggerForceMessageCount = 10;
    config.compress.protectRecentTurns = 0;

    const messages: any[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(userMessage(`msg ${i}`, 1000 + i));
    }

    const decision = decideNativeCompactionAutoTrigger(
      messages,
      makeState([activeBlock()]),
      config,
      1
    );

    // No compaction boundary => whole lineage is the live window.
    expect(decision.estimatedCompactableMessageCount).toBe(12);
    expect(decision.reason).toBe("force-threshold");
    expect(decision.queued).toBe(true);
  });
});
