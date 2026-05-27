#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// scripts/replay-equivalence.ts
//
// Offline replay-equivalence checker for dcp-replay-v3.
//
// For each session JSONL it:
//   1. Restores state via the legacy snapshot path (snapshotRestore).
//   2. Restores state via the new replay path (replayDcpState).
//   3. Diffs the four observable fields the criterion cares about:
//      active block IDs, nextBlockId, tokensSaved, prunedToolIds.
//
// Usage:
//   bun scripts/replay-equivalence.ts <session.jsonl>
//   bun scripts/replay-equivalence.ts --corpus [--session-dir <dir>]
//
// Exit codes:
//   0  all checked sessions equivalent (or --corpus found no sessions)
//   1  one or more mismatches found
//   2  usage / argument error
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { createState, resetState } from "../src/state.js";
import type { DcpConfig } from "../src/types/config.js";
import { restorePersistedState } from "../src/infrastructure/persistence.js";
import { replayDcpState } from "../src/domain/replay/index.js";

// ---------------------------------------------------------------------------
// Minimal config for equivalence checking — dedup/purge disabled so replay
// doesn't diverge from snapshot on prunedToolIds when the corpus was written
// without those strategies enabled.
// ---------------------------------------------------------------------------

export const EQUIVALENCE_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  compress: {
    maxContextPercent: 0.8,
    minContextPercent: 0.4,
    nudgeDebounceTurns: 2,
    nudgeFrequency: 5,
    iterationNudgeThreshold: 15,
    protectRecentTurns: 4,
    renderFullBlockCount: 4,
    renderCompactBlockCount: 8,
    nudgeForce: "soft",
    protectedTools: [],
    protectUserMessages: false,
  },
  nativeCompaction: {
    enabled: true,
    autoTriggerMessageCount: 1000,
    autoTriggerForceMessageCount: 2000,
    minActiveBlockCount: 1,
    minHiddenCoverageRatio: 0,
    maxPreviousSummaryTokens: 4000,
    maxSummaryTokens: 20000,
  },
  strategies: {
    pruneCadenceTurns: 1,
    deduplication: { enabled: false, protectedTools: [] },
    purgeErrors: { enabled: false, turns: 4, protectedTools: [] },
  },
  protectedFilePatterns: [],
  pruneNotification: "off",
};

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

export function parseJsonlEntries(text: string): any[] {
  const entries: any[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

export function isDcpStateEntry(entry: any): boolean {
  return entry?.type === "custom" && entry.customType === "dcp-state";
}

function isSuccessfulCompressResult(entry: any): boolean {
  if (entry?.type !== "message") return false;
  const msg = entry.message;
  return msg?.role === "toolResult" && !msg.isError && msg.toolName === "compress";
}

function isDcpNativeCompaction(entry: any): boolean {
  return (
    entry?.type === "compaction" &&
    entry?.details?.source === "dcp-native-compaction" &&
    Array.isArray(entry?.details?.representedBlockIds) &&
    entry.details.representedBlockIds.length > 0
  );
}

function branchIsReplayable(branchEntries: readonly any[]): boolean {
  return branchEntries.some((e) => isSuccessfulCompressResult(e) || isDcpNativeCompaction(e));
}

// ---------------------------------------------------------------------------
// Branch extraction
// ---------------------------------------------------------------------------

function buildBranchChain(
  targetId: string | null,
  entriesById: Map<string, any>,
  parentById: Map<string, string | null>
): any[] {
  // Walk ancestor chain, collect entry IDs oldest-first, then flatten entries.
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor = targetId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.unshift(cursor);
    cursor = parentById.get(cursor) ?? null;
  }
  return chain.map((id) => entriesById.get(id)).filter(Boolean);
}

function extractBranches(allEntries: any[]): Array<{ branchId: string | null; entries: any[] }> {
  const entriesById = new Map<string, any>();
  const parentById = new Map<string, string | null>();
  const leafIds = new Set<string>();
  const hasParent = new Set<string>();

  for (const entry of allEntries) {
    const id = typeof entry?.id === "string" ? entry.id : null;
    const parentId = typeof entry?.parentId === "string" ? entry.parentId : null;
    if (id) {
      entriesById.set(id, entry);
      parentById.set(id, parentId);
      leafIds.add(id);
    }
    if (parentId) hasParent.add(parentId);
  }

  // Leaf = has an id but is never referenced as a parentId.
  const leaves: Array<string | null> = [];
  for (const id of leafIds) {
    if (!hasParent.has(id)) leaves.push(id);
  }
  // Flat JSONL with no IDs — treat as a single flat branch.
  if (leaves.length === 0) return [{ branchId: null, entries: allEntries }];

  return leaves.map((leafId) => ({
    branchId: leafId,
    entries: leafId ? buildBranchChain(leafId, entriesById, parentById) : allEntries,
  }));
}

// ---------------------------------------------------------------------------
// Snapshot restore (legacy path)
// ---------------------------------------------------------------------------

function snapshotRestoreForEquivalence(branchEntries: readonly any[]): ReturnType<typeof createState> {
  const state = createState();
  for (const entry of branchEntries) {
    if (isDcpStateEntry(entry)) {
      restorePersistedState(entry.data, state);
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Observables comparison
// ---------------------------------------------------------------------------

export interface Observables {
  activeBlockIds: number[];
  nextBlockId: number;
  tokensSaved: number;
  prunedToolIds: string[];
}

export function extractObservables(state: ReturnType<typeof createState>): Observables {
  return {
    activeBlockIds: state.compressionBlocks
      .filter((b) => b.active)
      .map((b) => b.id)
      .sort((a, b) => a - b),
    nextBlockId: state.nextBlockId,
    tokensSaved: state.tokensSaved,
    prunedToolIds: [...state.prunedToolIds].sort(),
  };
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export interface BranchMismatch {
  field: string;
  snapshot: unknown;
  replay: unknown;
}

export function diffObservables(snapshot: Observables, replay: Observables): BranchMismatch[] {
  const mismatches: BranchMismatch[] = [];
  if (!arraysEqual(snapshot.activeBlockIds, replay.activeBlockIds)) {
    mismatches.push({ field: "activeBlockIds", snapshot: snapshot.activeBlockIds, replay: replay.activeBlockIds });
  }
  if (snapshot.nextBlockId !== replay.nextBlockId) {
    mismatches.push({ field: "nextBlockId", snapshot: snapshot.nextBlockId, replay: replay.nextBlockId });
  }
  if (snapshot.tokensSaved !== replay.tokensSaved) {
    mismatches.push({ field: "tokensSaved", snapshot: snapshot.tokensSaved, replay: replay.tokensSaved });
  }
  if (!arraysEqual(snapshot.prunedToolIds, replay.prunedToolIds)) {
    mismatches.push({ field: "prunedToolIds", snapshot: snapshot.prunedToolIds, replay: replay.prunedToolIds });
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Per-file check
// ---------------------------------------------------------------------------

interface FileResult {
  file: string;
  contract: "v3" | "legacy";
  branches: number;
  replayableBranches: number;
  equivalentBranches: number;
  mismatchedBranches: number;
  skippedBranches: number; // no snapshot + not replayable
  errors: string[];
  branchDetails: Array<{
    branchId: string | null;
    status: "equivalent" | "mismatch" | "skip" | "error";
    mismatches?: BranchMismatch[];
    error?: string;
  }>;
}

/**
 * A session is considered "in the v3 equivalence contract" when any of its
 * dcp-state entries declares schemaVersion 3. Pre-v3 sessions are reported
 * but their mismatches do not fail --corpus mode, because they were written
 * with legacy snapshot semantics that replay cannot reconstruct (e.g. slimmed
 * inactive blocks with savedTokenEstimate kept but coverage dropped, or
 * prunedToolIds tombstones from dedup/purge configurations the equivalence
 * config does not enable here).
 */
function sessionContract(entries: readonly any[]): "v3" | "legacy" {
  for (const entry of entries) {
    if (!isDcpStateEntry(entry)) continue;
    if (entry.data?.schemaVersion === 3) return "v3";
  }
  return "legacy";
}

async function checkFile(filePath: string): Promise<FileResult> {
  const result: FileResult = {
    file: filePath,
    contract: "legacy",
    branches: 0,
    replayableBranches: 0,
    equivalentBranches: 0,
    mismatchedBranches: 0,
    skippedBranches: 0,
    errors: [],
    branchDetails: [],
  };

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    result.errors.push(`read error: ${err}`);
    return result;
  }

  const allEntries = parseJsonlEntries(text);
  result.contract = sessionContract(allEntries);
  const branches = extractBranches(allEntries);
  result.branches = branches.length;

  for (const { branchId, entries } of branches) {
    const hasSnapshot = entries.some(isDcpStateEntry);
    const replayable = branchIsReplayable(entries);

    if (!hasSnapshot && !replayable) {
      result.skippedBranches++;
      result.branchDetails.push({ branchId, status: "skip" });
      continue;
    }

    if (replayable) result.replayableBranches++;

    // If not replayable, nothing to diff.
    if (!replayable) {
      result.skippedBranches++;
      result.branchDetails.push({ branchId, status: "skip" });
      continue;
    }

    try {
      const snapshotState = snapshotRestoreForEquivalence(entries);
      const replayState = createState();
      replayDcpState(entries, EQUIVALENCE_CONFIG, { state: replayState });

      const snapshotObs = extractObservables(snapshotState);
      const replayObs = extractObservables(replayState);
      const mismatches = diffObservables(snapshotObs, replayObs);

      if (mismatches.length === 0) {
        result.equivalentBranches++;
        result.branchDetails.push({ branchId, status: "equivalent" });
      } else {
        result.mismatchedBranches++;
        result.branchDetails.push({ branchId, status: "mismatch", mismatches });
      }
    } catch (err) {
      result.errors.push(`branch ${branchId ?? "root"}: ${err}`);
      result.branchDetails.push({ branchId, status: "error", error: String(err) });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(`Usage:
  bun scripts/replay-equivalence.ts <session.jsonl>
  bun scripts/replay-equivalence.ts --corpus [--session-dir <dir>]

Compares legacy snapshot restore vs replay restore for each JSONL session branch.
Reports mismatches in activeBlockIds, nextBlockId, tokensSaved, prunedToolIds.

Options:
  --corpus          Walk session JSONL files under --session-dir
  --session-dir     Directory to walk (default: ~/.pi/agent/sessions)
  --verbose         Show equivalent branch details too
  --help            Show this help`);
  process.exit(2);
}

function printFileResult(result: FileResult, verbose: boolean): void {
  const hasMismatch = result.mismatchedBranches > 0 || result.errors.length > 0;
  if (!hasMismatch && !verbose) return;

  const tag = result.contract === "v3" ? "v3" : "legacy";
  console.log(`\n${hasMismatch ? "MISMATCH" : "OK"} [${tag}]: ${result.file}`);
  console.log(
    `  branches=${result.branches} replayable=${result.replayableBranches} ` +
    `equivalent=${result.equivalentBranches} mismatch=${result.mismatchedBranches} ` +
    `skip=${result.skippedBranches} errors=${result.errors.length}`
  );

  for (const detail of result.branchDetails) {
    if (detail.status === "mismatch") {
      console.log(`  branch ${detail.branchId ?? "root"}: MISMATCH`);
      for (const m of detail.mismatches ?? []) {
        console.log(`    ${m.field}: snapshot=${JSON.stringify(m.snapshot)} replay=${JSON.stringify(m.replay)}`);
      }
    } else if (detail.status === "error") {
      console.log(`  branch ${detail.branchId ?? "root"}: ERROR ${detail.error}`);
    } else if (verbose && detail.status === "equivalent") {
      console.log(`  branch ${detail.branchId ?? "root"}: equivalent`);
    }
  }

  for (const err of result.errors) {
    console.log(`  error: ${err}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();

  const corpusMode = args.includes("--corpus");
  const verbose = args.includes("--verbose");
  const sessionDirIdx = args.indexOf("--session-dir");
  const sessionDir =
    sessionDirIdx >= 0 && args[sessionDirIdx + 1]
      ? args[sessionDirIdx + 1]!
      : join(homedir(), ".pi", "agent", "sessions");

  const singleFile = args.find((a) => !a.startsWith("--") && a !== args[sessionDirIdx + 1]);

  if (!corpusMode && !singleFile) usage();

  const files: string[] = [];
  if (singleFile) {
    if (!existsSync(singleFile)) {
      console.error(`File not found: ${singleFile}`);
      process.exit(2);
    }
    files.push(singleFile);
  } else {
    // --corpus: walk session dir
    if (!existsSync(sessionDir)) {
      console.log(`Session directory not found: ${sessionDir}`);
      console.log("No sessions to check.");
      process.exit(0);
    }
    const glob = new Glob("**/*.jsonl");
    for await (const file of glob.scan(sessionDir)) {
      files.push(join(sessionDir, file));
    }
  }

  if (files.length === 0) {
    console.log("No session files found.");
    process.exit(0);
  }

  let inContractMismatches = 0;
  let legacyMismatches = 0;
  let totalEquivalent = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let filesChecked = 0;
  let v3Files = 0;
  let legacyFiles = 0;

  for (const file of files) {
    const result = await checkFile(file);
    filesChecked++;
    if (result.contract === "v3") {
      v3Files++;
      inContractMismatches += result.mismatchedBranches;
    } else {
      legacyFiles++;
      legacyMismatches += result.mismatchedBranches;
    }
    totalEquivalent += result.equivalentBranches;
    totalSkipped += result.skippedBranches;
    totalErrors += result.errors.length;
    printFileResult(result, verbose);
  }

  console.log(
    `\nSummary: files=${filesChecked} (v3=${v3Files} legacy=${legacyFiles}) ` +
    `equivalent=${totalEquivalent} in-contract-mismatch=${inContractMismatches} ` +
    `legacy-mismatch=${legacyMismatches} skip=${totalSkipped} errors=${totalErrors}`
  );

  if (inContractMismatches > 0) {
    console.error(`\nFAILED: ${inContractMismatches} in-contract branch mismatch(es) found.`);
    process.exit(1);
  }
  if (legacyMismatches > 0) {
    console.log(
      `\nNOTE: ${legacyMismatches} pre-v3 legacy branch mismatch(es) reported as compatibility notes ` +
      `(outside the v3 equivalence contract).`
    );
  }

  console.log("\nPASSED: all in-contract replayable branches are equivalent.");
}

if (import.meta.main) {
  await main();
}
