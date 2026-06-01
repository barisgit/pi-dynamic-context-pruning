import { describe, expect, test } from "bun:test";

import {
  decideNativeCompactionAutoTrigger,
  resolveLiveCompactionWindowStartOrdinal,
} from "../../src/application/compress-tool/registration.js";
import { makeConfig, makeState } from "../helpers/dcp-test-utils.js";

// ---------------------------------------------------------------------------
// Native compaction auto-trigger: count the live (post-compaction) window
//
// Native compaction exists to relieve TUI render pressure, which is only the
// window the TUI actually renders. Mirroring pi's buildSessionContext, when a
// compaction is on the branch the rendered window is: the compaction summary,
// then the KEPT-TAIL (entries from firstKeptEntryId UP TO the compaction
// entry, i.e. before it in lineage), then everything after the compaction
// entry. Entries before firstKeptEntryId stay on disk for lineage but are NOT
// rendered. The auto-trigger must measure that live window, not the full
// root->leaf lineage. Otherwise a session that already compacted keeps counting
// thousands of hidden historical messages and re-fires `force-threshold`
// against a tiny visible transcript (the observed bug: "2083 estimated
// compactable messages" / "0.04 coverage" with ~124 visible).
//
// The window boundary is an ORDINAL (index in the flattened branch message
// array), not a timestamp: pi finds the boundary by entry id in branch order,
// so two entries sharing a millisecond timestamp must not be mis-windowed.
// ---------------------------------------------------------------------------

function userMessage(text: string, timestamp: number): any {
  return { role: "user", content: [{ type: "text", text }], timestamp };
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

// Build a fake ReadonlySessionManager-ish ctx over branch ENTRIES (with ids),
// reproducing the real lineage shape:
//   [hidden old..., firstKept...kept-tail, compaction entry, new-tail...]
// firstKeptEntryId points at an entry BEFORE the compaction entry.
function ctxWithBranch(entries: any[], leafId: string): any {
  return {
    sessionManager: {
      getLeafId: () => leafId,
      getBranch: (_leaf?: string) => entries,
    },
  };
}

function messageEntry(id: string, parentId: string | null, isoTs: string): any {
  return {
    type: "message",
    id,
    parentId,
    timestamp: isoTs,
    message: { role: "user", content: [{ type: "text", text: id }], timestamp: Date.parse(isoTs) },
  };
}

describe("resolveLiveCompactionWindowStartOrdinal", () => {
  test("returns the flattened ordinal of the firstKeptEntryId entry (kept-tail start)", () => {
    const entries: any[] = [];
    // Hidden old lineage (before firstKeptEntryId) => ordinals 0,1.
    entries.push(messageEntry("h0", null, "2020-01-01T00:00:00.000Z"));
    entries.push(messageEntry("h1", "h0", "2020-01-01T00:00:01.000Z"));
    // Kept-tail begins here (BEFORE the compaction entry in lineage) => ordinal 2.
    entries.push(messageEntry("k0", "h1", "2020-01-01T00:00:05.000Z"));
    entries.push(messageEntry("k1", "k0", "2020-01-01T00:00:06.000Z"));
    // Compaction entry references firstKeptEntryId = "k0".
    entries.push({
      type: "compaction",
      id: "c0",
      parentId: "k1",
      timestamp: "2020-01-01T00:00:07.000Z",
      summary: "compacted",
      firstKeptEntryId: "k0",
      tokensBefore: 12345,
    });
    // New-tail after the compaction entry.
    entries.push(messageEntry("n0", "c0", "2020-01-01T00:00:08.000Z"));

    // k0 is the 3rd flattened message => ordinal 2.
    expect(resolveLiveCompactionWindowStartOrdinal(ctxWithBranch(entries, "n0"))).toBe(2);
  });

  test("picks the LATEST compaction when several exist", () => {
    const entries: any[] = [
      messageEntry("a0", null, "2020-01-01T00:00:00.000Z"),
      {
        type: "compaction",
        id: "c0",
        parentId: "a0",
        timestamp: "2020-01-01T00:00:01.000Z",
        summary: "first",
        firstKeptEntryId: "a0",
        tokensBefore: 1,
      },
      messageEntry("b0", "c0", "2020-01-01T00:00:02.000Z"),
      messageEntry("b1", "b0", "2020-01-01T00:00:03.000Z"),
      {
        type: "compaction",
        id: "c1",
        parentId: "b1",
        timestamp: "2020-01-01T00:00:04.000Z",
        summary: "second",
        firstKeptEntryId: "b1",
        tokensBefore: 2,
      },
      messageEntry("n0", "c1", "2020-01-01T00:00:05.000Z"),
    ];
    // Flattened ordinals: a0=0, c0(compaction)=1, b0=2, b1=3, c1=4, n0=5.
    // Latest compaction c1.firstKeptEntryId = "b1" => ordinal 3.
    expect(resolveLiveCompactionWindowStartOrdinal(ctxWithBranch(entries, "n0"))).toBe(3);
  });

  test("returns null when there is no compaction entry on the branch", () => {
    const entries = [
      messageEntry("a0", null, "2020-01-01T00:00:00.000Z"),
      messageEntry("a1", "a0", "2020-01-01T00:00:01.000Z"),
    ];
    expect(resolveLiveCompactionWindowStartOrdinal(ctxWithBranch(entries, "a1"))).toBeNull();
  });
});

describe("native compaction auto-trigger window", () => {
  test("drops hidden pre-window history by ordinal, even with same-timestamp items", () => {
    const config = makeConfig();
    // Lower the thresholds so the test is about the boundary, not the numbers.
    config.nativeCompaction.autoTriggerMessageCount = 5;
    config.nativeCompaction.autoTriggerForceMessageCount = 10;
    config.nativeCompaction.minActiveBlockCount = 1;
    // protectRecentTurns=0 so the tail does not exclude the live window items.
    config.compress.protectRecentTurns = 0;

    const messages: any[] = [];
    // 50 hidden pre-window messages — ALL sharing one timestamp to prove the
    // ordinal boundary (not a timestamp filter) excludes them precisely.
    for (let i = 0; i < 50; i++) {
      messages.push(userMessage(`old ${i}`, 3000));
    }
    // The live window starts at ordinal 50 (3 messages, also same timestamp).
    messages.push(userMessage("live 1", 3000));
    messages.push(userMessage("live 2", 3000));
    messages.push(userMessage("live 3", 3000));

    const decision = decideNativeCompactionAutoTrigger(
      messages,
      makeState([activeBlock()]),
      config,
      1,
      50 // windowStartOrdinal: drop ordinals 0..49 (hidden), keep 50..52
    );

    // The live window has 3 compactable items, not 53 — same-ms collisions do
    // not leak into the count because the boundary is an ordinal.
    expect(decision.estimatedCompactableMessageCount).toBe(3);
    // 3 < lowerMessageThreshold(5) => below-lower-threshold, not force-threshold.
    expect(decision.reason).toBe("below-lower-threshold");
    expect(decision.queued).toBe(false);
  });

  test("without a window boundary it counts the full lineage", () => {
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
      1,
      null // no compaction boundary => whole lineage is the live window
    );

    expect(decision.estimatedCompactableMessageCount).toBe(12);
    expect(decision.reason).toBe("force-threshold");
    expect(decision.queued).toBe(true);
  });
});
