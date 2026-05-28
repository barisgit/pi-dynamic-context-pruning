// ---------------------------------------------------------------------------
// Unit test: scripts/vacuum-dcp-session.ts (f6).
// ---------------------------------------------------------------------------
//
// f6 retrofits the vacuum script with replay-aware semantics:
//   1. material key ignores `savedAt` so v3 snapshots can collapse to markers
//   2. branch-aware marker logic skips unrelated branches
//   3. verifyFile() asserts observables match before and after vacuum
//   4. round-trip equivalence on a fat v1 entry
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vacuumLines, verifyFile } from "../../scripts/vacuum-dcp-session.js";
import { createState } from "../../src/state.js";
import { restorePersistedState, serializePersistedState, serializeLegacyV1PersistedState } from "../../src/infrastructure/persistence.js";
import { extractObservables, isDcpStateEntry } from "../../scripts/replay-equivalence.js";
import type { CompressionBlock, DcpState } from "../../src/types/state.js";
import { createEmptyCompressionBlockMetadata } from "../../src/domain/compression/metadata.js";
import { makeState } from "../helpers/dcp-test-utils.js";

let workDir: string;
beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "dcp-vacuum-test-"));
});
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function dcpEntry(id: string, parentId: string | null, data: unknown): string {
  return JSON.stringify({ type: "custom", customType: "dcp-state", id, parentId, data });
}

function v3Payload(overrides: Partial<{
  savedAt: number;
  currentTurn: number;
  lastNudgeTurn: number;
  lastCompressTurn: number;
  prunedToolIds: string[];
  lifetimeTokensSavedRealized: number;
}> = {}): unknown {
  return {
    schemaVersion: 3,
    savedAt: overrides.savedAt ?? 1000,
    currentTurn: overrides.currentTurn ?? 5,
    lastNudgeTurn: overrides.lastNudgeTurn ?? -1,
    lastCompressTurn: overrides.lastCompressTurn ?? 3,
    prunedToolIds: overrides.prunedToolIds ?? ["tool-a"],
    lifetimeTokensSavedRealized: overrides.lifetimeTokensSavedRealized ?? 100,
  };
}

function makeFatV1Block(id: number, active: boolean): CompressionBlock {
  return {
    id,
    topic: `topic-${id}`,
    summary: "summary text for block " + id,
    startTimestamp: 1000 + id,
    endTimestamp: 2000 + id,
    anchorTimestamp: 1500 + id,
    startSourceKey: `src-${id}-start`,
    endSourceKey: `src-${id}-end`,
    anchorSourceKey: `src-${id}-anchor`,
    active,
    summaryTokenEstimate: 50,
    savedTokenEstimate: active ? 250 : 0,
    createdAt: 1000 + id,
    compressCallId: `call-${id}`,
    activityLogVersion: 1,
    activityLog: [],
    metadata: createEmptyCompressionBlockMetadata(),
  };
}

describe("vacuumLines (f6)", () => {
  test("material key ignores savedAt: identical v3 payloads collapse to a marker", () => {
    // Two consecutive entries on the same branch, differing ONLY by savedAt.
    // The second must become an `unchanged` marker.
    const lines = [
      dcpEntry("a", null, v3Payload({ savedAt: 1000 })),
      dcpEntry("b", "a", v3Payload({ savedAt: 2000 })),
    ];
    const { vacuumedEntries, stats } = vacuumLines(lines, /*markers=*/ true);
    expect(stats.dcpEntries).toBe(2);
    expect(stats.unchangedMarkers).toBe(1);

    expect(vacuumedEntries[1]!.data).toEqual({ schemaVersion: 3, unchanged: true });
    // First entry is materialized fully (not a marker).
    expect(vacuumedEntries[0]!.data.unchanged).toBeUndefined();
  });

  test("material key ignores savedAt: identical v4 payloads collapse to a v4 marker", () => {
    const state = makeState([makeFatV1Block(1, true)]) as DcpState;
    state.nextBlockId = 2;
    const first = serializePersistedState(state) as any;
    const second = { ...first, savedAt: first.savedAt + 1 };

    const lines = [dcpEntry("a", null, first), dcpEntry("b", "a", second)];
    const { vacuumedEntries, stats } = vacuumLines(lines, /*markers=*/ true);
    expect(stats.dcpEntries).toBe(2);
    expect(stats.unchangedMarkers).toBe(1);
    expect(vacuumedEntries[1]!.data).toEqual({ schemaVersion: 4, unchanged: true });
  });

  test("branch isolation: a sibling on a different ancestor does NOT become a marker", () => {
    // a -> b  (same material as a's vacuumed shape)
    // a -> c  (different material from a's vacuumed shape)
    // d (no parent) with same material as a -> still no marker because no ancestor on its branch
    const lines = [
      dcpEntry("a", null, v3Payload({ savedAt: 1000, currentTurn: 5 })),
      dcpEntry("b", "a", v3Payload({ savedAt: 2000, currentTurn: 5 })), // same material -> marker
      dcpEntry("c", "a", v3Payload({ savedAt: 3000, currentTurn: 99 })), // different material -> no marker
      dcpEntry("d", null, v3Payload({ savedAt: 4000, currentTurn: 5 })), // no ancestor -> no marker
    ];
    const { vacuumedEntries, stats } = vacuumLines(lines, /*markers=*/ true);
    expect(stats.dcpEntries).toBe(4);
    expect(stats.unchangedMarkers).toBe(1);

    expect(vacuumedEntries[0]!.data.unchanged).toBeUndefined();
    expect(vacuumedEntries[1]!.data).toEqual({ schemaVersion: 3, unchanged: true });
    expect(vacuumedEntries[2]!.data.unchanged).toBeUndefined();
    expect(vacuumedEntries[3]!.data.unchanged).toBeUndefined();
  });

  test("markers disabled: identical payloads still vacuumed but never collapsed", () => {
    const lines = [
      dcpEntry("a", null, v3Payload({ savedAt: 1000 })),
      dcpEntry("b", "a", v3Payload({ savedAt: 2000 })),
    ];
    const { vacuumedEntries, stats } = vacuumLines(lines, /*markers=*/ false);
    expect(stats.unchangedMarkers).toBe(0);
    expect(vacuumedEntries[1]!.data.unchanged).toBeUndefined();
  });

  test("vacuum preserves scalar observables and converts fat v1 blocks to v4 metadata", () => {
    // v4 keeps a lightweight block list while still dropping heavyweight
    // v1 coverage/log/stat fields.
    const state = makeState() as DcpState;
    state.compressionBlocks.push(makeFatV1Block(1, true));
    state.nextBlockId = 2;
    state.tokensSaved = 250;
    state.prunedToolIds.add("call-1");
    state.currentTurn = 7;
    state.lastCompressTurn = 6;
    state.lifetimeTokensSavedRealized = 999;

    const fatV1 = serializeLegacyV1PersistedState(state);
    const lines = [dcpEntry("a", null, fatV1)];
    const { vacuumedEntries, stats } = vacuumLines(lines, /*markers=*/ true);
    expect(stats.dcpEntries).toBe(1);

    const vacuumed = createState();
    restorePersistedState(vacuumedEntries[0]!.data, vacuumed);
    const vacuumedObs = extractObservables(vacuumed);

    expect(vacuumedEntries[0]!.data.schemaVersion).toBe(4);
    expect(vacuumedEntries[0]!.data.blocks).toHaveLength(1);
    expect(vacuumedEntries[0]!.data.blocks[0].metadata).toBeUndefined();
    expect(vacuumedEntries[0]!.data.blocks[0].activityLog).toBeUndefined();

    expect(vacuumedObs.activeBlockIds).toEqual([1]);
    expect(vacuumedObs.nextBlockId).toBe(2);
    expect(vacuumedObs.tokensSaved).toBe(250);

    expect(vacuumedObs.prunedToolIds).toEqual(["call-1"]);
    expect(vacuumed.currentTurn).toBe(7);
    expect(vacuumed.lastCompressTurn).toBe(6);
    expect(vacuumed.lifetimeTokensSavedRealized).toBe(999);
  });

  test("vacuumed v4 entries are dramatically smaller than fat v1 entries", () => {
    const state = makeState() as DcpState;
    for (let i = 1; i <= 20; i++) state.compressionBlocks.push(makeFatV1Block(i, i % 2 === 0));
    state.nextBlockId = 21;

    const fatV1 = serializeLegacyV1PersistedState(state);
    const lines = [dcpEntry("a", null, fatV1)];
    const { outLines } = vacuumLines(lines, /*markers=*/ true);

    const before = Buffer.byteLength(lines[0]!, "utf8");
    const after = Buffer.byteLength(outLines[0]!, "utf8");
    expect(after).toBeLessThan(before);
    // v4 carries block metadata, but still drops fat coverage/log/stat fields.
    expect(after).toBeLessThan(10_000);
  });
});

describe("verifyFile (f6)", () => {
  test("fat v1 session with no replay evidence is out-of-contract (ok, not mismatch)", async () => {
    // Pure-snapshot legacy sessions are out-of-contract for v3 verify: their
    // block precision lives only in the fat payload, which v3 intentionally
    // drops. Verify must report ok with outOfContractEntries > 0, not fail.
    const state = makeState() as DcpState;
    state.compressionBlocks.push(makeFatV1Block(1, true));
    state.compressionBlocks.push(makeFatV1Block(2, false));
    state.nextBlockId = 3;
    state.tokensSaved = 250;
    state.prunedToolIds.add("call-x");
    state.currentTurn = 4;

    const fatV1 = serializeLegacyV1PersistedState(state);
    const filePath = join(workDir, "fat-v1.jsonl");
    await writeFile(filePath, dcpEntry("a", null, fatV1) + "\n", "utf8");

    const result = await verifyFile(filePath);
    expect(result.ok).toBe(true);
    expect(result.dcpEntries).toBe(1);
    expect(result.outOfContractEntries).toBe(1);
    expect(result.replayableEntries).toBe(0);
    expect(result.mismatches).toEqual([]);
  });

  test("vacuum preserves observables across a v3 marker chain", async () => {
    // Same material on the same branch: the second entry becomes a marker;
    // observables (which the next snapshot restore would derive) must match.
    const filePath = join(workDir, "v3-chain.jsonl");
    await writeFile(
      filePath,
      [
        dcpEntry("a", null, v3Payload({ savedAt: 1000, currentTurn: 5, prunedToolIds: ["t1"] })),
        dcpEntry("b", "a", v3Payload({ savedAt: 2000, currentTurn: 5, prunedToolIds: ["t1"] })),
        dcpEntry("c", "b", v3Payload({ savedAt: 3000, currentTurn: 8, prunedToolIds: ["t1", "t2"] })),
      ].join("\n") + "\n",
      "utf8"
    );

    const result = await verifyFile(filePath);
    expect(result.ok).toBe(true);
    expect(result.dcpEntries).toBe(3);
  });

  test("replayable branch: native-compaction entry makes session in-contract and verifies ok", async () => {
    // A native-compaction entry makes branchIsReplayable=true. The fat-v1
    // snapshot's blocks are already represented (active=false) so replay
    // produces zero active blocks; vacuum drops the blocks but the post-
    // vacuum replay also produces zero active blocks. Observables equal.
    const filePath = join(workDir, "replayable.jsonl");
    const state = makeState() as DcpState;
    const block = makeFatV1Block(1, false);
    state.compressionBlocks.push(block);
    state.lifetimeTokensSavedRealized = 250;
    state.nextBlockId = 2;
    const fatV1 = serializeLegacyV1PersistedState(state);

    const compactionEntry = JSON.stringify({
      type: "compaction",
      id: "comp1",
      parentId: null,
      summary: "compacted",
      details: {
        source: "dcp-native-compaction",
        version: 1,
        representedBlockIds: [1],
      },
    });

    await writeFile(
      filePath,
      [compactionEntry, dcpEntry("a", "comp1", fatV1)].join("\n") + "\n",
      "utf8"
    );

    const result = await verifyFile(filePath);
    expect(result.ok).toBe(true);
    expect(result.replayableEntries).toBe(1);
    expect(result.outOfContractEntries).toBe(0);
    expect(result.mismatches).toEqual([]);
  });

  test("verifyFile on a session with no dcp-state entries succeeds with 0 entries", async () => {
    const filePath = join(workDir, "no-dcp.jsonl");
    await writeFile(filePath, JSON.stringify({ type: "session", id: "x" }) + "\n", "utf8");
    const result = await verifyFile(filePath);
    expect(result.ok).toBe(true);
    expect(result.dcpEntries).toBe(0);
  });
});

describe("vacuum CLI smoke (f6)", () => {
  test("--verify-corpus on empty dir prints message and exits 0", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "dcp-vacuum-empty-"));
    try {
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(
        "bun",
        ["run", "./scripts/vacuum-dcp-session.ts", "--verify-corpus", "--session-dir", emptyDir],
        { encoding: "utf8", cwd: process.cwd() }
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("No session files found");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("--verify-corpus on a fat v1 session exits 0", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "dcp-vacuum-sess-"));
    try {
      const state = makeState() as DcpState;
      state.compressionBlocks.push(makeFatV1Block(1, true));
      state.nextBlockId = 2;
      state.tokensSaved = 250;
      const fatV1 = serializeLegacyV1PersistedState(state);
      await writeFile(join(sessionDir, "sess.jsonl"), dcpEntry("a", null, fatV1) + "\n", "utf8");

      const { spawnSync } = await import("node:child_process");
      const r = spawnSync(
        "bun",
        ["run", "./scripts/vacuum-dcp-session.ts", "--verify-corpus", "--session-dir", sessionDir],
        { encoding: "utf8", cwd: process.cwd() }
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("mismatch=0");
      expect(r.stdout).toContain("Verify summary");
    } finally {
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
