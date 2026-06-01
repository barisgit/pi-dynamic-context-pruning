#!/usr/bin/env bun
/**
 * Correlate DCP debug JSONL events with llm-proxy request captures.
 *
 * Usage:
 *   bun run scripts/dcp-proxy-report.ts
 *   bun run scripts/dcp-proxy-report.ts --dcp-log ~/.pi/log/dcp.jsonl --proxy-dir ~/.pi/tmp/llm-proxy
 *   bun run scripts/dcp-proxy-report.ts --out research/eval-runs/manual/report.md --csv research/eval-runs/manual/events.csv
 *
 * The script is read-only for DCP state, DCP logs, and proxy captures. It only
 * writes a fresh Markdown report and CSV summary to the requested output paths.
 */

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Provider = "anthropic" | "openai" | string;

interface CliOptions {
  readonly dcpLog: string;
  readonly proxyDir: string;
  readonly out: string;
  readonly csv: string;
}

interface UsageJson {
  readonly provider?: Provider;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_tokens?: number;
  readonly cache_write_tokens?: number | null;
  readonly raw_usage?: unknown;
}

interface MarkerCounts {
  readonly dcpTags: number;
  readonly ownerTags: number;
  readonly ownerKeys: number;
  readonly messageIds: number;
}

interface CaptureRow {
  readonly prefix: string;
  readonly usageFile: string;
  readonly requestFile: string;
  readonly instant: string;
  readonly epochMs: number;
  readonly provider: Provider;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number | null;
  readonly inputItemCount: number;
  readonly toolCount: number;
  readonly markerCounts: MarkerCounts;
  readonly markerLeakCount: number;
  deltaCacheReadTokens?: number | null;
  deltaCacheWriteTokens?: number | null;
  deltaInputTokens?: number | null;
}

interface DcpEvent {
  readonly timestamp: string;
  readonly epochMs: number;
  readonly event: string;
  readonly payload: Record<string, unknown>;
}

interface EventBuckets {
  readonly all: DcpEvent[];
  readonly context_evaluated: DcpEvent[];
  readonly compress_succeeded: DcpEvent[];
  readonly provider_payload_filtered: DcpEvent[];
  readonly heuristic_prune_evaluated: DcpEvent[];
  readonly nudge_emitted: DcpEvent[];
}

interface CsvRow {
  readonly timestamp: string;
  readonly kind: string;
  readonly provider?: string;
  readonly model?: string;
  readonly input_tokens?: number | string;
  readonly output_tokens?: number | string;
  readonly cache_read_tokens?: number | string;
  readonly cache_write_tokens?: number | string;
  readonly active_blocks?: number | string;
  readonly estimated_saved_tokens?: number | string;
  readonly input_items_before?: number | string;
  readonly input_items_after?: number | string;
  readonly removed_reasoning?: number | string;
  readonly removed_function_call?: number | string;
  readonly removed_function_call_output?: number | string;
  readonly metadata_chars?: number | string;
  readonly nudge_chars?: number | string;
  readonly marker_leak_count?: number | string;
  readonly capture_file?: string;
}

// ---------------------------------------------------------------------------
// CLI and paths
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(`Usage:
  bun run scripts/dcp-proxy-report.ts [--dcp-log <path>] [--proxy-dir <dir>] [--out <report.md>] [--csv <events.csv>]

Defaults:
  --dcp-log   ~/.pi/log/dcp.jsonl
  --proxy-dir ~/.pi/tmp/llm-proxy
  --out       research/eval-runs/<current-iso-slug>/report.md
  --csv       <out-dir>/events.csv`);
  process.exit(2);
}

function isoSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function normalizePath(path: string): string {
  return resolve(expandHome(path));
}

function parseArgs(argv: readonly string[]): CliOptions {
  const runId = isoSlug();
  const defaults = {
    dcpLog: "~/.pi/log/dcp.jsonl",
    proxyDir: "~/.pi/tmp/llm-proxy",
    out: `research/eval-runs/${runId}/report.md`,
    csv: "",
  };

  const values: Record<string, string> = { ...defaults };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (!["--dcp-log", "--proxy-dir", "--out", "--csv"].includes(arg)) usage();
    const value = argv[++index];
    if (!value || value.startsWith("--")) usage();
    values[arg.slice(2)] = value;
  }

  const out = normalizePath(values.out ?? defaults.out);
  const csv = normalizePath(values.csv || join(dirname(out), "events.csv"));
  return {
    dcpLog: normalizePath(values["dcp-log"] ?? defaults.dcpLog),
    proxyDir: normalizePath(values["proxy-dir"] ?? defaults.proxyDir),
    out,
    csv,
  };
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return Math.round(value).toLocaleString();
}

function markdownCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function markdownTable(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  if (rows.length === 0) {
    lines.push(`| ${headers.map((_, index) => (index === 0 ? "_none_" : "")).join(" | ")} |`);
  } else {
    for (const row of rows) lines.push(`| ${row.map(markdownCell).join(" | ")} |`);
  }
  return lines.join("\n");
}

function countMatches(text: string, regex: RegExp): number {
  return text.match(regex)?.length ?? 0;
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Proxy capture loading
// ---------------------------------------------------------------------------

function parseCaptureInstant(prefix: string): string | null {
  const tailMatch = prefix.match(/^(.*)_([^_]+)_([^_]+)$/);
  if (!tailMatch) return null;
  const timestampPart = tailMatch[1];
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(timestampPart)) return null;
  const date = timestampPart.slice(0, 10);
  const time = timestampPart.slice(11).replace(/-/g, ":");
  return `${date}T${time}Z`;
}

function scanMarkers(rawRequest: string): MarkerCounts {
  const dcpTagPattern = new RegExp("<" + "dcp-[a-z]+>", "g");
  return {
    dcpTags: countMatches(rawRequest, dcpTagPattern),
    ownerTags: countMatches(rawRequest, /<\/?owner>/g),
    ownerKeys: countMatches(rawRequest, /\bs\d{1,4}\b/g),
    messageIds: countMatches(rawRequest, /\bm\d{3,4}\b/g),
  };
}

function detectRequestShape(
  body: Record<string, unknown>,
  usageProvider: Provider
): { provider: Provider; itemCount: number; toolCount: number } {
  const hasOpenAiInput = Array.isArray(body.input) && !Array.isArray(body.messages);
  const hasAnthropicMessages = Array.isArray(body.messages);
  const provider = hasOpenAiInput ? "openai" : hasAnthropicMessages ? "anthropic" : usageProvider;
  const itemCount = hasOpenAiInput
    ? asArray(body.input).length
    : hasAnthropicMessages
      ? asArray(body.messages).length
      : 0;
  const toolCount = asArray(body.tools).length;
  return { provider, itemCount, toolCount };
}

function loadCapture(usagePath: string): CaptureRow | null {
  const usageFile = usagePath;
  const prefix = usagePath.slice(0, -".usage.json".length);
  const instant = parseCaptureInstant(prefix.split(/[\\/]/).pop() ?? "");
  if (!instant) return null;

  const epochMs = Date.parse(instant);
  if (!Number.isFinite(epochMs)) return null;

  const usage = asRecord(parseJsonFile(usagePath)) as UsageJson;
  const requestFile = `${prefix}.json`;
  let rawRequest = "";
  let body: Record<string, unknown> = {};
  if (existsSync(requestFile)) {
    rawRequest = readFileSync(requestFile, "utf8");
    body = asRecord(JSON.parse(rawRequest));
  }

  const markerCounts = scanMarkers(rawRequest);
  const shape = detectRequestShape(body, usage.provider ?? "unknown");
  const cacheWrite = usage.cache_write_tokens;
  return {
    prefix,
    usageFile,
    requestFile,
    instant,
    epochMs,
    provider: shape.provider,
    model: asString(body.model, "unknown"),
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_tokens),
    cacheWriteTokens:
      typeof cacheWrite === "number" && Number.isFinite(cacheWrite) ? cacheWrite : null,
    inputItemCount: shape.itemCount,
    toolCount: shape.toolCount,
    markerCounts,
    markerLeakCount:
      markerCounts.dcpTags +
      markerCounts.ownerTags +
      markerCounts.ownerKeys +
      markerCounts.messageIds,
  };
}

function loadCaptures(proxyDir: string): CaptureRow[] {
  if (!existsSync(proxyDir)) return [];
  const usageFiles = readdirSync(proxyDir)
    .filter((name) => name.endsWith(".usage.json"))
    .map((name) => join(proxyDir, name))
    .sort();

  const captures: CaptureRow[] = [];
  for (const file of usageFiles) {
    try {
      const capture = loadCapture(file);
      if (capture) captures.push(capture);
    } catch (err) {
      console.warn(`[dcp-proxy-report] Skipping malformed capture ${file}: ${err}`);
    }
  }
  captures.sort((a, b) => a.epochMs - b.epochMs || a.prefix.localeCompare(b.prefix));

  let previous: CaptureRow | undefined;
  for (const capture of captures) {
    capture.deltaCacheReadTokens = previous
      ? capture.cacheReadTokens - previous.cacheReadTokens
      : null;
    capture.deltaCacheWriteTokens = previous
      ? (capture.cacheWriteTokens ?? 0) - (previous.cacheWriteTokens ?? 0)
      : null;
    capture.deltaInputTokens = previous ? capture.inputTokens - previous.inputTokens : null;
    previous = capture;
  }

  return captures;
}

// ---------------------------------------------------------------------------
// DCP log streaming
// ---------------------------------------------------------------------------

function emptyBuckets(): EventBuckets {
  return {
    all: [],
    context_evaluated: [],
    compress_succeeded: [],
    provider_payload_filtered: [],
    heuristic_prune_evaluated: [],
    nudge_emitted: [],
  };
}

async function streamDcpEvents(
  dcpLog: string,
  minEpochMs: number,
  maxEpochMs: number
): Promise<EventBuckets> {
  const buckets = emptyBuckets();
  if (!existsSync(dcpLog)) return buckets;

  const rl = createInterface({
    input: createReadStream(dcpLog, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = asRecord(raw);
    const timestamp = asString(entry.timestamp);
    const epochMs = Date.parse(timestamp);
    if (!Number.isFinite(epochMs) || epochMs < minEpochMs || epochMs > maxEpochMs) continue;

    const event = asString(entry.event, "unknown");
    const dcpEvent: DcpEvent = { timestamp, epochMs, event, payload: asRecord(entry.payload) };
    buckets.all.push(dcpEvent);
    if (event in buckets) {
      (buckets[event as keyof EventBuckets] as DcpEvent[]).push(dcpEvent);
    }
  }
  for (const events of Object.values(buckets) as DcpEvent[][]) {
    events.sort((a: DcpEvent, b: DcpEvent) => a.epochMs - b.epochMs);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

function nearestCapture(captures: readonly CaptureRow[], epochMs: number): CaptureRow | null {
  let best: CaptureRow | null = null;
  let bestDistance = Infinity;
  for (const capture of captures) {
    const distance = Math.abs(capture.epochMs - epochMs);
    if (distance < bestDistance) {
      best = capture;
      bestDistance = distance;
    }
  }
  return best;
}

function precedingContext(
  contexts: readonly DcpEvent[],
  epochMs: number,
  windowMs = 10_000
): DcpEvent | null {
  let best: DcpEvent | null = null;
  for (const event of contexts) {
    if (event.epochMs <= epochMs && epochMs - event.epochMs <= windowMs) best = event;
    if (event.epochMs > epochMs) break;
  }
  return best;
}

function followingContext(
  contexts: readonly DcpEvent[],
  epochMs: number,
  windowMs = 10_000
): DcpEvent | null {
  for (const event of contexts) {
    if (event.epochMs < epochMs) continue;
    if (event.epochMs - epochMs <= windowMs) return event;
    break;
  }
  return null;
}

function eventsNear(events: readonly DcpEvent[], epochMs: number, windowMs = 10_000): DcpEvent[] {
  return events.filter((event) => Math.abs(event.epochMs - epochMs) <= windowMs);
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function providerModelCounts(captures: readonly CaptureRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const capture of captures) {
    const key = `${capture.provider}/${capture.model}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sum(captures: readonly CaptureRow[], pick: (capture: CaptureRow) => number): number {
  return captures.reduce((total, capture) => total + pick(capture), 0);
}

function maxPayloadNumber(events: readonly DcpEvent[], key: string): number {
  let max = 0;
  for (const event of events) max = Math.max(max, asNumber(event.payload[key]));
  return max;
}

function markerTotals(captures: readonly CaptureRow[]): MarkerCounts {
  return captures.reduce(
    (total, capture) => ({
      dcpTags: total.dcpTags + capture.markerCounts.dcpTags,
      ownerTags: total.ownerTags + capture.markerCounts.ownerTags,
      ownerKeys: total.ownerKeys + capture.markerCounts.ownerKeys,
      messageIds: total.messageIds + capture.markerCounts.messageIds,
    }),
    { dcpTags: 0, ownerTags: 0, ownerKeys: 0, messageIds: 0 }
  );
}

function buildSessionSummary(captures: readonly CaptureRow[], buckets: EventBuckets): string {
  const counts = [...providerModelCounts(captures).entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const cacheWriteTotal = captures.reduce(
    (total, capture) => total + (capture.cacheWriteTokens ?? 0),
    0
  );
  const lines = [
    "## Session summary",
    "",
    `- Capture count: ${captures.length}`,
    `- Provider/model counts: ${counts.length ? counts.map(([key, count]) => `${key}=${count}`).join(", ") : "none"}`,
    `- Total input tokens: ${formatNumber(sum(captures, (capture) => capture.inputTokens))}`,
    `- Total output tokens: ${formatNumber(sum(captures, (capture) => capture.outputTokens))}`,
    `- Total cache read tokens: ${formatNumber(sum(captures, (capture) => capture.cacheReadTokens))}`,
    `- Total cache write tokens: ${formatNumber(cacheWriteTotal)}`,
    `- Max estimated DCP savings observed: ${formatNumber(maxPayloadNumber(buckets.context_evaluated, "tokensSaved"))}`,
    `- Compress succeeded events in window: ${buckets.compress_succeeded.length}`,
  ];
  return lines.join("\n");
}

function buildReport(
  captures: readonly CaptureRow[],
  buckets: EventBuckets,
  options: CliOptions
): string {
  const captureRows = captures.map((capture) => [
    capture.instant,
    capture.provider,
    capture.model,
    formatNumber(capture.inputTokens),
    formatNumber(capture.outputTokens),
    formatNumber(capture.cacheReadTokens),
    formatNumber(capture.cacheWriteTokens),
    formatNumber(capture.deltaCacheReadTokens),
    formatNumber(capture.deltaCacheWriteTokens),
    capture.inputItemCount,
    capture.toolCount,
    capture.markerLeakCount,
  ]);

  const compressRows = buckets.compress_succeeded.map((event) => {
    const capture = nearestCapture(captures, event.epochMs);
    return [
      event.timestamp,
      asString(event.payload.topic),
      asArray(event.payload.blockIds).join(", "),
      formatNumber(asNumber(event.payload.contextPercent) * 100),
      capture ? formatNumber(capture.cacheWriteTokens) : "",
    ];
  });

  const filterRows = buckets.provider_payload_filtered.map((event) => {
    const before = asNumber(event.payload.inputCountBefore);
    const after = asNumber(event.payload.inputCountAfter);
    return [event.timestamp, before, after, before - after, asNumber(event.payload.liveOwnerCount)];
  });

  const pruneRows = buckets.heuristic_prune_evaluated.map((event) => [
    event.timestamp,
    asNumber(event.payload.uniqueCandidates),
    asNumber(event.payload.keptAfterItemGate),
    String(Boolean(event.payload.committed)),
    String(Boolean(event.payload.heldByBatchGate)),
    String(Boolean(event.payload.redZone)),
    asNumber(event.payload.batchSavedTokens),
  ]);

  const totals = markerTotals(captures);
  const leakingFiles = captures
    .filter((capture) => capture.markerLeakCount > 0)
    .map((capture) => [
      capture.requestFile,
      capture.markerCounts.dcpTags,
      capture.markerCounts.ownerTags,
      capture.markerCounts.ownerKeys,
      capture.markerCounts.messageIds,
    ]);

  const contextLines = captures.map((capture) => {
    const before = precedingContext(buckets.context_evaluated, capture.epochMs);
    const after = followingContext(buckets.context_evaluated, capture.epochMs);
    const nearbyCompress = eventsNear(buckets.compress_succeeded, capture.epochMs).length;
    const nearbyFilters = eventsNear(buckets.provider_payload_filtered, capture.epochMs).length;
    const nearbyPrunes = eventsNear(buckets.heuristic_prune_evaluated, capture.epochMs).length;
    return [
      capture.instant,
      before ? before.timestamp : "",
      after ? after.timestamp : "",
      nearbyCompress,
      nearbyFilters,
      nearbyPrunes,
    ];
  });

  const parts = [
    "# DCP proxy correlation report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `DCP log: ${options.dcpLog}`,
    `Proxy dir: ${options.proxyDir}`,
    "",
    buildSessionSummary(captures, buckets),
    "",
    "## Capture timeline",
    "",
    markdownTable(
      [
        "instant",
        "provider",
        "model",
        "input",
        "output",
        "cache_read",
        "cache_write",
        "d_cache_read",
        "d_cache_write",
        "items",
        "tools",
        "marker_suspects",
      ],
      captureRows
    ),
    "",
    "## Capture / DCP event correlation",
    "",
    markdownTable(
      [
        "capture",
        "prev_context<=10s",
        "next_context<=10s",
        "compress±10s",
        "payload_filter±10s",
        "heuristic_prune±10s",
      ],
      contextLines
    ),
    "",
    "## Compress events",
    "",
    markdownTable(
      ["timestamp", "topic", "blockIds", "contextPercent", "nearest_capture_cache_write"],
      compressRows
    ),
    "",
    "## Provider payload filtering",
    "",
    markdownTable(
      ["timestamp", "inputCountBefore", "inputCountAfter", "delta", "liveOwnerCount"],
      filterRows
    ),
    "",
  ];

  if (buckets.heuristic_prune_evaluated.length > 0) {
    parts.push(
      "## Heuristic prune decisions",
      "",
      markdownTable(
        [
          "timestamp",
          "uniqueCandidates",
          "kept",
          "committed",
          "heldByBatchGate",
          "redZone",
          "batchSavedTokens",
        ],
        pruneRows
      ),
      ""
    );
  }

  parts.push(
    "## Marker leakage summary",
    "",
    `- DCP tag suspects: ${totals.dcpTags}`,
    `- Owner tag suspects: ${totals.ownerTags}`,
    `- Bare owner-key suspects: ${totals.ownerKeys}`,
    `- Bare message-id suspects: ${totals.messageIds}`,
    `- Total marker suspects: ${totals.dcpTags + totals.ownerTags + totals.ownerKeys + totals.messageIds}`,
    "",
    markdownTable(
      ["request_file", "dcp_tags", "owner_tags", "owner_keys", "message_ids"],
      leakingFiles
    ),
    ""
  );

  return `${parts.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  "timestamp",
  "kind",
  "provider",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "active_blocks",
  "estimated_saved_tokens",
  "input_items_before",
  "input_items_after",
  "removed_reasoning",
  "removed_function_call",
  "removed_function_call_output",
  "metadata_chars",
  "nudge_chars",
  "marker_leak_count",
  "capture_file",
] as const;

function buildCsvRows(captures: readonly CaptureRow[], buckets: EventBuckets): CsvRow[] {
  const rows: CsvRow[] = [];

  for (const capture of captures) {
    rows.push({
      timestamp: capture.instant,
      kind: "capture",
      provider: capture.provider,
      model: capture.model,
      input_tokens: capture.inputTokens,
      output_tokens: capture.outputTokens,
      cache_read_tokens: capture.cacheReadTokens,
      cache_write_tokens: capture.cacheWriteTokens ?? "",
      input_items_before: capture.inputItemCount,
      marker_leak_count: capture.markerLeakCount,
      capture_file: capture.requestFile,
    });
  }

  for (const event of buckets.context_evaluated) {
    rows.push({
      timestamp: event.timestamp,
      kind: "context_evaluated",
      active_blocks: asNumber(event.payload.activeCompressionBlockCount),
      estimated_saved_tokens: asNumber(event.payload.tokensSaved),
      input_items_after: asNumber(event.payload.renderedMessageCount),
    });
  }

  for (const event of buckets.provider_payload_filtered) {
    rows.push({
      timestamp: event.timestamp,
      kind: "provider_payload_filtered",
      input_items_before: asNumber(event.payload.inputCountBefore),
      input_items_after: asNumber(event.payload.inputCountAfter),
    });
  }

  for (const event of buckets.compress_succeeded) {
    rows.push({
      timestamp: event.timestamp,
      kind: "compress_succeeded",
    });
  }

  for (const event of buckets.nudge_emitted) {
    rows.push({
      timestamp: event.timestamp,
      kind: "nudge_emitted",
    });
  }

  for (const event of buckets.heuristic_prune_evaluated) {
    rows.push({
      timestamp: event.timestamp,
      kind: "heuristic_prune_evaluated",
      estimated_saved_tokens: asNumber(event.payload.batchSavedTokens),
      input_items_before: asNumber(event.payload.uniqueCandidates),
      input_items_after: asNumber(event.payload.keptAfterItemGate),
    });
  }

  rows.sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.kind.localeCompare(b.kind)
  );
  return rows;
}

function writeCsv(path: string, rows: readonly CsvRow[]): void {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const record = row as unknown as Record<string, unknown>;
    lines.push(CSV_COLUMNS.map((column) => csvEscape(record[column])).join(","));
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const captures = loadCaptures(options.proxyDir);
  const minEpochMs =
    captures.length > 0 ? Math.min(...captures.map((capture) => capture.epochMs)) - 60_000 : 0;
  const maxEpochMs =
    captures.length > 0
      ? Math.max(...captures.map((capture) => capture.epochMs)) + 60_000
      : Date.now();
  const buckets = await streamDcpEvents(options.dcpLog, minEpochMs, maxEpochMs);

  mkdirSync(dirname(options.out), { recursive: true });
  mkdirSync(dirname(options.csv), { recursive: true });

  const report = buildReport(captures, buckets, options);
  writeFileSync(options.out, report);
  writeCsv(options.csv, buildCsvRows(captures, buckets));

  console.log("DCP proxy report complete");
  console.log(`captures: ${captures.length}`);
  console.log(`dcp events in window: ${buckets.all.length}`);
  console.log(`compress_succeeded: ${buckets.compress_succeeded.length}`);
  console.log(`provider_payload_filtered: ${buckets.provider_payload_filtered.length}`);
  console.log(`heuristic_prune_evaluated: ${buckets.heuristic_prune_evaluated.length}`);
  console.log(`report: ${options.out}`);
  console.log(`csv: ${options.csv}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
