#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createState } from "../src/state.js";
import { restorePersistedState, serializePersistedState } from "../src/infrastructure/persistence.js";

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

Default is dry-run: parses and rewrites in memory, reports savings, but does not touch the file.
With --write, creates <session.jsonl>.bak unless --no-backup is passed, then atomically replaces the file.

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

function isDcpStateEntry(entry: any): boolean {
  return entry?.type === "custom" && entry.customType === "dcp-state";
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

  const outLines: string[] = [];
  const stats: VacuumStats = {
    file: path,
    originalBytes: before.size,
    outputBytes: 0,
    savedBytes: 0,
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
      continue;
    }

    const entryId = getEntryId(entry);
    const parentId = getParentId(entry);
    if (entryId) parentById.set(entryId, parentId);

    if (!isDcpStateEntry(entry)) {
      outLines.push(line);
      continue;
    }

    try {
      stats.dcpEntries++;
      const beforeBlocks = countBlocks(entry.data);
      stats.activeBlocks += beforeBlocks.active;
      stats.inactiveBlocks += beforeBlocks.inactive;

      const vacuumedData = vacuumDcpData(entry.data);
      const materialKey = JSON.stringify(vacuumedData);
      const ancestorKey = findNearestAncestorDcpKey(parentId, parentById, dcpMaterialKeyById);
      if (entryId) dcpMaterialKeyById.set(entryId, materialKey);

      if (markers && ancestorKey === materialKey) {
        entry.data = { schemaVersion: 1, unchanged: true };
        stats.unchangedMarkers++;
      } else {
        entry.data = vacuumedData;
      }

      const nextLine = JSON.stringify(entry);
      if (nextLine.length !== line.length || nextLine !== line) stats.changedDcpEntries++;
      outLines.push(nextLine);
    } catch {
      stats.failedDcpEntries++;
      outLines.push(line);
    }
  }

  const output = outLines.join("\n") + (hadTrailingNewline ? "\n" : "");
  stats.outputBytes = Buffer.byteLength(output, "utf8");
  stats.savedBytes = stats.originalBytes - stats.outputBytes;

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

  return stats;
}

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
if (!file || args.includes("--help") || args.includes("-h")) usage();
const write = args.includes("--write");
const backup = !args.includes("--no-backup");
const markers = !args.includes("--no-markers");

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
