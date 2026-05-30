#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { Glob } from "bun";
import { createState } from "../src/state.js";
import { restorePersistedState, serializePersistedState } from "../src/infrastructure/persistence.js";
import {
  EQUIVALENCE_CONFIG,
  extractObservables,
  diffObservables,
  isDcpStateEntry,
} from "./replay-equivalence.js";
import { replayDcpState } from "../src/domain/replay/index.js";

type VacuumStats = {
  file: string;
  originalBytes: number;
  outputBytes: number;
  savedBytes: number;
  totalLines: number;
  dcpEntries: number;
  changedDcpEntries: number;
  unchangedMarkers: number;
  failedDcpEntries: number;
  activeBlocks: number;
  inactiveBlocks: number;
};

function usage(): never {
  console.error(`Usage:
  bun scripts/vacuum-dcp-session.ts <session.jsonl> [--write] [--no-backup] [--no-markers]
  bun scripts/vacuum-dcp-session.ts --corpus [--session-dir <dir>] [--write] [--no-backup] [--no-markers]
  bun scripts/vacuum-dcp-session.ts --verify-corpus [--session-dir <dir>]

Default is dry-run: parses and rewrites in memory, reports savings, but does not touch the file.
With --write, creates <session.jsonl>.bak unless --no-backup is passed, then atomically replaces the file.
--verify-corpus always runs as dry-run: it vacuums each session in memory and asserts the four DCP
observables (activeBlockIds, nextBlockId, tokensSaved, prunedToolIds) match before and after.

This rewrites customType:dcp-state entries through DCP's normal restore+serialize path.
By default, redundant DCP snapshots are replaced with tiny no-op markers when they are
materially identical to the nearest ancestor DCP state on the same session branch.
Non-DCP session entries are byte-preserved.`);
  process.exit(2);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function countBlocks(data: any): { active: number; inactive: number } {
  const blocks = Array.isArray(data?.compressionBlocks)
    ? data.compressionBlocks
    : Array.isArray(data?.blocks)
      ? data.blocks
      : [];

  let active = 0;
  let inactive = 0;
  for (const block of blocks) {
    const isActive = block?.active === true || block?.status === "active";
    if (isActive) active++;
    else inactive++;
  }
  return { active, inactive };
}

function vacuumDcpData(data: unknown): unknown {
  const state = createState();
  restorePersistedState(data, state);
  return serializePersistedState(state);
}

// ---------------------------------------------------------------------------
// Material key: stable identity of a vacuumed payload, ignoring savedAt.
// Two snapshots that differ only by their write timestamp should produce the
// same key so the marker logic can collapse them. With f4 the vacuumed shape
// is the tiny v3 payload, where savedAt is the only field that legitimately
// changes per save.
// ---------------------------------------------------------------------------

function materialKeyOf(data: any): string {
  if (!data || typeof data !== "object") return JSON.stringify(data);
  const clone: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "savedAt") continue;
    clone[k] = v;
  }
  return JSON.stringify(clone);
}

function markerForSchemaVersion(version: unknown): { schemaVersion: number; unchanged: true } {
  const v =
    typeof version === "number" &&
    (version === 1 || version === 2 || version === 3 || version === 4 || version === 5)
      ? version
      : 1;
  return { schemaVersion: v, unchanged: true };
}

function getEntryId(entry: any): string | null {
  return typeof entry?.id === "string" ? entry.id : null;
}

function getParentId(entry: any): string | null {
  return typeof entry?.parentId === "string" ? entry.parentId : null;
}

function findNearestAncestorDcpKey(
  parentId: string | null,
  parentById: Map<string, string | null>,
  dcpMaterialKeyById: Map<string, string>
): string | null {
  const seen = new Set<string>();
  let cursor = parentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const dcpKey = dcpMaterialKeyById.get(cursor);
    if (dcpKey !== undefined) return dcpKey;
    cursor = parentById.get(cursor) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core vacuum pass: walks lines once, mutates dcp-state entries in place,
// emits new lines. Returns both stats and the rewritten lines array so the
// caller can write to disk (vacuumFile) or use the rewritten branch in memory
// (verifyFile).
// ---------------------------------------------------------------------------

export function vacuumLines(rawLines: readonly string[], markers: boolean): {
  outLines: string[];
  vacuumedEntries: any[]; // parsed view of outLines; non-parseable lines drop to null
  stats: Omit<VacuumStats, "file" | "originalBytes" | "outputBytes" | "savedBytes">;
} {
  const outLines: string[] = [];
  const vacuumedEntries: any[] = [];
  const stats = {
    totalLines: rawLines.length,
    dcpEntries: 0,
    changedDcpEntries: 0,
    unchangedMarkers: 0,
    failedDcpEntries: 0,
    activeBlocks: 0,
    inactiveBlocks: 0,
  };

  const parentById = new Map<string, string | null>();
  const dcpMaterialKeyById = new Map<string, string>();

  for (const line of rawLines) {
    let entry: any = null;
    try {
      entry = JSON.parse(line);
    } catch {
      if (line.includes('"customType":"dcp-state"')) stats.failedDcpEntries++;
      outLines.push(line);
      vacuumedEntries.push(null);
      continue;
    }

    const entryId = getEntryId(entry);
    const parentId = getParentId(entry);
    if (entryId) parentById.set(entryId, parentId);

    if (!isDcpStateEntry(entry)) {
      outLines.push(line);
      vacuumedEntries.push(entry);
      continue;
    }

    try {
      stats.dcpEntries++;
      const beforeBlocks = countBlocks(entry.data);
      stats.activeBlocks += beforeBlocks.active;
      stats.inactiveBlocks += beforeBlocks.inactive;

      const vacuumedData = vacuumDcpData(entry.data);
      const materialKey = materialKeyOf(vacuumedData);
      const ancestorKey = findNearestAncestorDcpKey(parentId, parentById, dcpMaterialKeyById);
      if (entryId) dcpMaterialKeyById.set(entryId, materialKey);

      if (markers && ancestorKey === materialKey) {
        entry.data = markerForSchemaVersion((vacuumedData as any)?.schemaVersion);
        stats.unchangedMarkers++;
      } else {
        entry.data = vacuumedData;
      }

      const nextLine = JSON.stringify(entry);
      if (nextLine.length !== line.length || nextLine !== line) stats.changedDcpEntries++;
      outLines.push(nextLine);
      vacuumedEntries.push(entry);
    } catch {
      stats.failedDcpEntries++;
      outLines.push(line);
      vacuumedEntries.push(entry);
    }
  }

  return { outLines, vacuumedEntries, stats };
}

async function vacuumFile(
  path: string,
  write: boolean,
  backup: boolean,
  markers: boolean
): Promise<VacuumStats> {
  const before = await stat(path);
  const text = await readFile(path, "utf8");
  const hadTrailingNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (hadTrailingNewline) rawLines.pop();

  const { outLines, stats: coreStats } = vacuumLines(rawLines, markers);

  const output = outLines.join("\n") + (hadTrailingNewline ? "\n" : "");
  const outputBytes = Buffer.byteLength(output, "utf8");

  // Validate generated JSONL before touching disk.
  for (const [index, line] of outLines.entries()) {
    if (line.trim() === "") continue;
    JSON.parse(line);
    if (index % 10_000 === 0) await Bun.sleep(0);
  }

  if (write) {
    if (backup) {
      const backupPath = `${path}.bak`;
      if (!existsSync(backupPath)) await copyFile(path, backupPath);
    }
    const tempPath = join(dirname(path), `.${basename(path)}.vacuum-${process.pid}.tmp`);
    await writeFile(tempPath, output, "utf8");
    await rename(tempPath, path);
  }

  return {
    file: path,
    originalBytes: before.size,
    outputBytes,
    savedBytes: before.size - outputBytes,
    ...coreStats,
  };
}

// ---------------------------------------------------------------------------
// Verify: vacuum in memory, then assert that replay over the raw append-only
// transcript yields equivalent observables before and after the rewrite. Replay
// stays an offline migration verifier; live resume restores from persisted v5.
// ---------------------------------------------------------------------------

interface VerifyResult {
  file: string;
  ok: boolean;
  dcpEntries: number;
  replayableEntries: number;
  outOfContractEntries: number;
  mismatches: Array<{ field: string; original: unknown; vacuumed: unknown }>;
  error?: string;
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

function branchIsReplayable(entries: readonly any[]): boolean {
  return entries.some((e) => isSuccessfulCompressResult(e) || isDcpNativeCompaction(e));
}

export async function verifyFile(path: string): Promise<VerifyResult> {
  const result: VerifyResult = {
    file: path,
    ok: true,
    dcpEntries: 0,
    replayableEntries: 0,
    outOfContractEntries: 0,
    mismatches: [],
  };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    result.ok = false;
    result.error = `read error: ${err}`;
    return result;
  }

  const hadTrailingNewline = text.endsWith("\n");
  const rawLines = text.split("\n");
  if (hadTrailingNewline) rawLines.pop();

  // Parse original entries once.
  const originalEntries: any[] = [];
  for (const line of rawLines) {
    try {
      originalEntries.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }

  const { vacuumedEntries, stats } = vacuumLines(rawLines, /*markers=*/ true);
  result.dcpEntries = stats.dcpEntries;

  if (stats.dcpEntries === 0) return result;

  // Non-replayable branches are out-of-contract for replay-based verify: their
  // block precision lives only in persisted snapshots, not transcript evidence.
  if (!branchIsReplayable(originalEntries)) {
    result.outOfContractEntries = stats.dcpEntries;
    return result;
  }
  result.replayableEntries = stats.dcpEntries;

  try {
    const originalState = createState();
    replayDcpState(originalEntries, EQUIVALENCE_CONFIG, { state: originalState });
    const originalObs = extractObservables(originalState);

    const vacuumedState = createState();
    replayDcpState(vacuumedEntries.filter(Boolean), EQUIVALENCE_CONFIG, { state: vacuumedState });
    const vacuumedObs = extractObservables(vacuumedState);

    const diffs = diffObservables(originalObs, vacuumedObs);
    if (diffs.length > 0) {
      result.ok = false;
      for (const d of diffs) {
        result.mismatches.push({ field: d.field, original: d.directRestore, vacuumed: d.replay });
      }
    }
  } catch (err) {
    result.ok = false;
    result.error = `replay error: ${err}`;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Corpus walk
// ---------------------------------------------------------------------------

function defaultSessionDir(): string {
  return join(homedir(), ".pi", "agent", "sessions");
}

async function listSessionFiles(sessionDir: string): Promise<string[]> {
  if (!existsSync(sessionDir)) return [];
  const glob = new Glob("**/*.jsonl");
  const files: string[] = [];
  for await (const rel of glob.scan({ cwd: sessionDir, onlyFiles: true })) {
    files.push(join(sessionDir, rel));
  }
  files.sort();
  return files;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runCli(): Promise<void> {
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) usage();

const verifyCorpus = args.includes("--verify-corpus");
const corpus = verifyCorpus || args.includes("--corpus");
const write = !verifyCorpus && args.includes("--write");
const backup = !args.includes("--no-backup");
const markers = !args.includes("--no-markers");

function extractFlagValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

if (corpus) {
  const sessionDir = extractFlagValue("--session-dir") ?? defaultSessionDir();
  if (!existsSync(sessionDir)) {
    console.log(`Session directory not found: ${sessionDir}`);
    process.exit(0);
  }
  const files = await listSessionFiles(sessionDir);
  if (files.length === 0) {
    console.log(`No session files found under: ${sessionDir}`);
    process.exit(0);
  }

  if (verifyCorpus) {
    console.log(`Verifying ${files.length} session file(s) under: ${sessionDir}`);
    let okCount = 0;
    let mismatchCount = 0;
    let errorCount = 0;
    let dcpEntries = 0;
    const failures: VerifyResult[] = [];
    for (const file of files) {
      const result = await verifyFile(file);
      dcpEntries += result.dcpEntries;
      if (result.error) {
        errorCount++;
        failures.push(result);
        continue;
      }
      if (result.ok) okCount++;
      else {
        mismatchCount++;
        failures.push(result);
      }
    }
    console.log("");
    console.log(
      `Verify summary: files=${files.length} ok=${okCount} mismatch=${mismatchCount} ` +
        `errors=${errorCount} dcp-entries=${dcpEntries}`
    );
    console.log(
      `Note: sessions with no replay evidence (compress toolResult / dcp-native-compaction) ` +
        `are out-of-contract for v3 verify and counted as ok.`
    );
    if (failures.length > 0) {
      console.log("");
      console.log(`Failures (${failures.length}):`);
      for (const f of failures.slice(0, 20)) {
        if (f.error) {
          console.log(`  ${f.file}: ${f.error}`);
        } else {
          console.log(`  ${f.file}:`);
          for (const m of f.mismatches) {
            console.log(`    ${m.field}: original=${JSON.stringify(m.original)} vacuumed=${JSON.stringify(m.vacuumed)}`);
          }
        }
      }
      if (failures.length > 20) console.log(`  ... ${failures.length - 20} more`);
    }
    process.exit(mismatchCount + errorCount === 0 ? 0 : 1);
  }

  // Corpus vacuum (write or dry-run).
  console.log(`${write ? "Vacuuming" : "Dry-run"} ${files.length} session file(s) under: ${sessionDir}`);
  let totalOriginal = 0;
  let totalOutput = 0;
  let totalDcp = 0;
  let totalChanged = 0;
  let totalMarkers = 0;
  let totalFailed = 0;
  for (const file of files) {
    try {
      const stats = await vacuumFile(file, write, backup, markers);
      totalOriginal += stats.originalBytes;
      totalOutput += stats.outputBytes;
      totalDcp += stats.dcpEntries;
      totalChanged += stats.changedDcpEntries;
      totalMarkers += stats.unchangedMarkers;
      totalFailed += stats.failedDcpEntries;
    } catch (err) {
      console.error(`  ${file}: error ${err}`);
    }
  }
  const totalSaved = totalOriginal - totalOutput;
  const pct = totalOriginal > 0 ? (totalSaved / totalOriginal) * 100 : 0;
  console.log("");
  console.log(
    `Corpus summary: files=${files.length} dcp-entries=${totalDcp} changed=${totalChanged} ` +
      `markers=${totalMarkers} failed=${totalFailed}`
  );
  console.log(
    `Size: ${formatBytes(totalOriginal)} -> ${formatBytes(totalOutput)} ` +
      `saved=${formatBytes(totalSaved)} (${pct.toFixed(1)}%)`
  );
  process.exit(0);
}

// Single-file mode.
const file = args.find((arg) => !arg.startsWith("--") && arg !== extractFlagValue("--session-dir"));
if (!file) usage();

const stats = await vacuumFile(file, write, backup, markers);
const pct = stats.originalBytes > 0 ? (stats.savedBytes / stats.originalBytes) * 100 : 0;

console.log(`${write ? "Wrote" : "Dry run"}: ${stats.file}`);
console.log(`Lines: ${stats.totalLines}`);
console.log(
  `DCP state entries: ${stats.dcpEntries} changed=${stats.changedDcpEntries} ` +
    `markers=${stats.unchangedMarkers} failed=${stats.failedDcpEntries}`
);
console.log(`Blocks seen across DCP snapshots: active=${stats.activeBlocks} inactive=${stats.inactiveBlocks}`);
console.log(
  `Size: ${formatBytes(stats.originalBytes)} -> ${formatBytes(stats.outputBytes)} ` +
    `saved=${formatBytes(stats.savedBytes)} (${pct.toFixed(1)}%)`
);
if (write && backup) console.log(`Backup: ${stats.file}.bak`);
}

if (import.meta.main) {
  await runCli();
}
