import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import type { DcpConfig } from "../types/config.js";
import type { CompressionBlock, DcpState } from "../types/state.js";
import { renderCompressedBlockText } from "../domain/compression/materialize.js";
import { estimateTokens } from "../domain/tokens/estimate.js";
import { buildTranscriptSnapshot } from "../domain/transcript/index.js";
import type { DcpMessage } from "../types/message.js";
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.js";
import { saveState } from "./session-handler.js";
import { updateDcpStatus } from "./status.js";

const DCP_NATIVE_COMPACTION_DETAILS_SOURCE = "dcp-native-compaction";
const MAX_RAW_EXCERPT_MESSAGES = 80;
const MAX_RAW_EXCERPT_CHARS = 600;
const MAX_RAW_EXCERPT_TOTAL_CHARS = 20_000;

export type DcpNativeCompactionReason = "command" | "auto" | "host";

export interface DcpNativeCompactionRequest {
  id: string;
  reason: DcpNativeCompactionReason;
  requestedAt: number;
  requestedBlockIds?: number[];
}

export interface DcpNativeCompactionDetails {
  source: typeof DCP_NATIVE_COMPACTION_DETAILS_SOURCE;
  version: 1;
  requestId: string;
  reason: DcpNativeCompactionReason;
  representedBlockIds: number[];
  requestedBlockIds: number[];
  firstKeptEntryId: string;
  hiddenMessageCount: number;
  uncoveredHiddenMessageCount: number;
  renderedUncoveredExcerptCount: number;
  truncatedUncoveredExcerptCount: number;
  readFiles: string[];
  modifiedFiles: string[];
}

interface BranchMessageRecord {
  branchIndex: number;
  entry: SessionEntry;
  message: DcpMessage;
}

interface BuildDcpNativeCompactionResultArgs {
  state: DcpState;
  config: DcpConfig;
  branchEntries: SessionEntry[];
  preparation: {
    firstKeptEntryId: string;
    tokensBefore: number;
    previousSummary?: string;
    fileOps?: unknown;
  };
  request: DcpNativeCompactionRequest;
}

interface RawExcerptResult {
  lines: string[];
  uncoveredCount: number;
  renderedCount: number;
  truncatedCount: number;
}

const pendingRequests = new WeakMap<DcpState, DcpNativeCompactionRequest>();
const pendingAutoRequests = new WeakMap<DcpState, { requestedBlockIds: number[] | undefined }>();

export function queueDcpAutoNativeCompaction(state: DcpState, requestedBlockIds: number[]): void {
  pendingAutoRequests.set(state, { requestedBlockIds });
}

export function hasPendingDcpAutoNativeCompaction(state: DcpState): boolean {
  return pendingAutoRequests.has(state);
}

export function clearPendingDcpAutoNativeCompaction(state: DcpState): void {
  pendingAutoRequests.delete(state);
}
let nextRequestId = 1;

function createRequest(
  reason: DcpNativeCompactionReason,
  requestedBlockIds?: number[]
): DcpNativeCompactionRequest {
  return {
    id: `dcp-native-${Date.now()}-${nextRequestId++}`,
    reason,
    requestedAt: Date.now(),
    requestedBlockIds,
  };
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "error" = "info"): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, type);
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

export function computeDcpHiddenCoverage(
  state: DcpState,
  branchEntries: SessionEntry[],
  firstKeptEntryId: string
): { ratio: number; hiddenMessageCount: number; coveredHiddenCount: number } {
  const records = buildBranchMessageRecords(branchEntries);
  const firstKeptBranchIndex = resolveFirstKeptBranchIndex(branchEntries, firstKeptEntryId);
  const snapshot = buildTranscriptSnapshot(records.map((record) => record.message));
  const hiddenKeys = new Set<string>();
  for (const item of snapshot.sourceItems) {
    const rec = records[item.ordinal];
    if (rec && rec.branchIndex < firstKeptBranchIndex) hiddenKeys.add(item.key);
  }
  const hiddenMessageCount = hiddenKeys.size;
  if (hiddenMessageCount === 0) {
    return { ratio: 1, hiddenMessageCount: 0, coveredHiddenCount: 0 };
  }
  const covered = new Set<string>();
  for (const block of state.compressionBlocks.filter((b) => b.active)) {
    const coveredKeys = resolveBlockCoveredSourceKeys(block, snapshot);
    for (const key of coveredKeys) {
      if (hiddenKeys.has(key)) covered.add(key);
    }
  }
  return {
    ratio: covered.size / hiddenMessageCount,
    hiddenMessageCount,
    coveredHiddenCount: covered.size,
  };
}

export function buildDcpFallbackCustomInstructions(state: DcpState): string | undefined {
  const active = state.compressionBlocks.filter((b) => b.active);
  if (active.length === 0) return undefined;
  const sections = active.map(
    (block) =>
      `<block id="b${block.id}" topic="${escapeAttr(block.topic)}">\n${renderBlockForCompaction(block)}\n</block>`
  );
  return [
    "Authoritative pre-compacted slices of the conversation (DCP). Treat these as ground truth for what already happened; do not re-derive them. Use them to inform the summary you write.",
    sections.join("\n\n"),
  ].join("\n\n");
}

function isDcpNativeCompactionDetails(value: unknown): value is DcpNativeCompactionDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { source?: unknown }).source === DCP_NATIVE_COMPACTION_DETAILS_SOURCE &&
    (value as { version?: unknown }).version === 1
  );
}

function parseEntryTimestamp(entry: { timestamp?: unknown }): number {
  if (typeof entry.timestamp === "number") return entry.timestamp;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

function entryToDcpMessage(entry: SessionEntry): DcpMessage | null {
  const candidate = entry as any;
  if (candidate.type === "message" && candidate.message) {
    return candidate.message as DcpMessage;
  }

  if (candidate.type === "custom_message") {
    return {
      role: "custom_message",
      content: candidate.content,
      timestamp: parseEntryTimestamp(candidate),
    } as DcpMessage;
  }

  if (candidate.type === "branch_summary") {
    return {
      role: "branch_summary",
      content: [{ type: "text", text: candidate.summary }],
      timestamp: parseEntryTimestamp(candidate),
    } as DcpMessage;
  }

  if (candidate.type === "compaction") {
    return {
      role: "compaction",
      content: [{ type: "text", text: candidate.summary }],
      timestamp: parseEntryTimestamp(candidate),
    } as DcpMessage;
  }

  return null;
}

function buildBranchMessageRecords(branchEntries: SessionEntry[]): BranchMessageRecord[] {
  const records: BranchMessageRecord[] = [];
  branchEntries.forEach((entry, branchIndex) => {
    const message = entryToDcpMessage(entry);
    if (message) records.push({ branchIndex, entry, message });
  });
  return records;
}

function resolveFirstKeptBranchIndex(
  branchEntries: SessionEntry[],
  firstKeptEntryId: string
): number {
  const index = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  return index >= 0 ? index : branchEntries.length;
}

function resolveNativeFirstKeptBranchIndex(
  branchEntries: SessionEntry[],
  records: BranchMessageRecord[],
  snapshot: ReturnType<typeof buildTranscriptSnapshot>,
  state: DcpState,
  preparationFirstKeptEntryId: string
): number {
  const preparedIndex = resolveFirstKeptBranchIndex(branchEntries, preparationFirstKeptEntryId);
  let latestCoveredBranchIndex = -1;

  for (const block of state.compressionBlocks.filter((candidate) => candidate.active)) {
    const coveredKeys = resolveBlockCoveredSourceKeys(block, snapshot);
    for (const sourceItem of snapshot.sourceItems) {
      if (!coveredKeys.has(sourceItem.key)) continue;
      const record = records[sourceItem.ordinal];
      if (record) latestCoveredBranchIndex = Math.max(latestCoveredBranchIndex, record.branchIndex);
    }
  }

  const afterLatestCoveredIndex = latestCoveredBranchIndex + 1;
  if (afterLatestCoveredIndex < branchEntries.length) {
    return Math.max(preparedIndex, afterLatestCoveredIndex);
  }

  return preparedIndex;
}

function resolveBlockCoveredSourceKeys(
  block: CompressionBlock,
  snapshot: ReturnType<typeof buildTranscriptSnapshot>
): Set<string> {
  const snapshotKeys = new Set(snapshot.sourceItems.map((item) => item.key));
  const exactKeys = (block.metadata?.coveredSourceKeys ?? []).filter((key) =>
    snapshotKeys.has(key)
  );
  if (exactKeys.length > 0) return new Set(exactKeys);

  const fallbackKeys = snapshot.sourceItems
    .filter(
      (item) =>
        item.timestamp !== null &&
        item.timestamp >= block.startTimestamp &&
        item.timestamp <= block.endTimestamp
    )
    .map((item) => item.key);
  return new Set(fallbackKeys);
}

function resolveRepresentedBlocks(
  state: DcpState,
  snapshot: ReturnType<typeof buildTranscriptSnapshot>,
  hiddenSourceKeys: Set<string>
): { blocks: CompressionBlock[]; coveredSourceKeys: Set<string> } {
  const coveredSourceKeys = new Set<string>();
  const blocks: CompressionBlock[] = [];

  for (const block of state.compressionBlocks.filter((candidate) => candidate.active)) {
    const blockKeys = resolveBlockCoveredSourceKeys(block, snapshot);
    if (blockKeys.size === 0) continue;

    const fullyHidden = Array.from(blockKeys).every((key) => hiddenSourceKeys.has(key));
    if (!fullyHidden) continue;

    blocks.push(block);
    for (const key of blockKeys) coveredSourceKeys.add(key);
  }

  blocks.sort((a, b) => a.startTimestamp - b.startTimestamp || a.id - b.id);
  return { blocks, coveredSourceKeys };
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as any;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "thinking" && typeof block.text === "string") {
      parts.push(`[thinking] ${block.text}`);
    } else if (block.type === "toolCall") {
      parts.push(
        `[toolCall ${block.name ?? "unknown"}${block.id ? ` ${block.id}` : ""} ${truncateText(
          stringifyJson(block.arguments ?? {}),
          240
        )}]`
      );
    } else if (block.type === "image") {
      parts.push("[image]");
    } else if (typeof block.type === "string") {
      parts.push(`[${block.type}]`);
    }
  }

  return parts.join(" ");
}

function formatMessageLabel(record: BranchMessageRecord): string {
  const role = (record.message as any).role ?? "message";
  const entryId = record.entry.id ? ` ${record.entry.id}` : "";
  return `${role}${entryId}`;
}

function buildRawExcerpts(
  records: BranchMessageRecord[],
  snapshot: ReturnType<typeof buildTranscriptSnapshot>,
  firstKeptBranchIndex: number,
  coveredSourceKeys: Set<string>
): RawExcerptResult {
  const lines: string[] = [];
  let totalChars = 0;
  let uncoveredCount = 0;
  let renderedCount = 0;
  let truncatedCount = 0;

  for (const sourceItem of snapshot.sourceItems) {
    const record = records[sourceItem.ordinal];
    if (!record || record.branchIndex >= firstKeptBranchIndex) continue;
    if (coveredSourceKeys.has(sourceItem.key)) continue;

    uncoveredCount++;
    const text = truncateText(
      contentToText((record.message as any).content),
      MAX_RAW_EXCERPT_CHARS
    );
    const line = `- ${formatMessageLabel(record)}: ${text || "(no text content)"}`;

    if (
      renderedCount >= MAX_RAW_EXCERPT_MESSAGES ||
      totalChars + line.length > MAX_RAW_EXCERPT_TOTAL_CHARS
    ) {
      truncatedCount++;
      continue;
    }

    lines.push(line);
    totalChars += line.length;
    renderedCount++;
  }

  return { lines, uncoveredCount, renderedCount, truncatedCount };
}

function addSetValues(target: Set<string>, values: Iterable<string> | undefined): void {
  if (!values) return;
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) target.add(value);
  }
}

function collectFileLists(
  blocks: CompressionBlock[],
  preparationFileOps: unknown
): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set<string>();
  const modified = new Set<string>();

  for (const block of blocks) {
    for (const stat of block.metadata?.fileReadStats ?? []) read.add(stat.path);
    for (const stat of block.metadata?.fileWriteStats ?? []) modified.add(stat.path);
  }

  if (preparationFileOps && typeof preparationFileOps === "object") {
    const fileOps = preparationFileOps as {
      read?: Set<string>;
      written?: Set<string>;
      edited?: Set<string>;
    };
    addSetValues(read, fileOps.read);
    addSetValues(modified, fileOps.written);
    addSetValues(modified, fileOps.edited);
  }

  for (const path of modified) read.delete(path);
  return {
    readFiles: Array.from(read).sort(),
    modifiedFiles: Array.from(modified).sort(),
  };
}

function formatFileTags(readFiles: string[], modifiedFiles: string[]): string {
  const parts: string[] = [];
  if (readFiles.length > 0) {
    parts.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    parts.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}

function renderBlockForCompaction(block: CompressionBlock): string {
  return renderCompressedBlockText({
    id: block.id,
    topic: block.topic,
    summary: block.summary,
    activityLogVersion: block.activityLogVersion,
    activityLog: block.activityLog,
    detailLevel: "full",
  }).trim();
}

const DCP_ENVELOPE_OPEN = '<dcp-summary version="1">';
const DCP_ENVELOPE_CLOSE = "</dcp-summary>";
const DCP_ENVELOPE_REGEX = /<dcp-summary version="1">[\s\S]*?<\/dcp-summary>/g;

function renderSectionFull(block: CompressionBlock): string {
  return `<section topic="${escapeAttr(block.topic)}">\n${renderBlockForCompaction(block)}\n</section>`;
}

function renderSectionCompact(block: CompressionBlock): string {
  const body = (block.summary ?? "").trim() || "(no summary)";
  return `<section topic="${escapeAttr(block.topic)}" tier="compact">\n${body}\n</section>`;
}

function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^.{0,200}?[.!?](?:\s|$)/);
  if (match) return match[0].trim();
  return trimmed.slice(0, 200);
}

function renderArchivedRollup(blocks: CompressionBlock[]): string {
  if (blocks.length === 0) return "";
  const lines = blocks.map((block) => {
    const topic = block.topic.replace(/\s+/g, " ").trim();
    const lead = firstSentence(block.summary ?? "");
    return lead ? `- ${topic} — ${lead}` : `- ${topic}`;
  });
  return `<archived-sections>\n${lines.join("\n")}\n</archived-sections>`;
}

interface TieredSummary {
  full: CompressionBlock[];
  compact: CompressionBlock[];
  archived: CompressionBlock[];
}

function splitTiers(
  blocks: CompressionBlock[],
  fullCount: number,
  compactCount: number
): TieredSummary {
  const total = blocks.length;
  const fullStart = Math.max(0, total - fullCount);
  const compactStart = Math.max(0, fullStart - compactCount);
  return {
    archived: blocks.slice(0, compactStart),
    compact: blocks.slice(compactStart, fullStart),
    full: blocks.slice(fullStart),
  };
}

function renderTieredSummary(tiers: TieredSummary): string {
  const parts: string[] = [];
  if (tiers.archived.length > 0) parts.push(renderArchivedRollup(tiers.archived));
  for (const block of tiers.compact) parts.push(renderSectionCompact(block));
  for (const block of tiers.full) parts.push(renderSectionFull(block));
  return parts.join("\n\n");
}

function demoteOnce(tiers: TieredSummary): boolean {
  // Demote oldest full -> compact, oldest compact -> archived, oldest archived -> dropped.
  if (tiers.full.length > 0) {
    const oldest = tiers.full.shift();
    if (oldest) tiers.compact.push(oldest);
    // keep compact sorted asc by createdAt
    tiers.compact.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return true;
  }
  if (tiers.compact.length > 0) {
    const oldest = tiers.compact.shift();
    if (oldest) tiers.archived.push(oldest);
    tiers.archived.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return true;
  }
  if (tiers.archived.length > 0) {
    tiers.archived.shift();
    return true;
  }
  return false;
}

function renderWithBudget(
  blocks: CompressionBlock[],
  fullCount: number,
  compactCount: number,
  maxTokens: number
): string {
  const tiers = splitTiers(blocks, fullCount, compactCount);
  let rendered = renderTieredSummary(tiers);
  if (maxTokens <= 0) return rendered;
  while (estimateTokens(rendered) > maxTokens && demoteOnce(tiers)) {
    rendered = renderTieredSummary(tiers);
  }
  return rendered;
}

function stripDcpEnvelope(previous: string): string {
  return previous.replace(DCP_ENVELOPE_REGEX, "").trim();
}

function truncateByTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return text;
  const total = estimateTokens(text);
  if (total <= maxTokens) return text;
  // Head-keep by character ratio (gpt-tokenizer doesn't expose slicing here).
  const ratio = maxTokens / total;
  const sliceLen = Math.max(0, Math.floor(text.length * ratio));
  const head = text.slice(0, sliceLen).trimEnd();
  const dropped = total - estimateTokens(head);
  return `${head}\n[truncated ~${dropped} tokens of previous summary]`;
}

export function buildDcpNativeCompactionResult({
  state,
  config: _config,
  branchEntries,
  preparation,
  request,
}: BuildDcpNativeCompactionResultArgs): CompactionResult<DcpNativeCompactionDetails> {
  const records = buildBranchMessageRecords(branchEntries);
  const snapshot = buildTranscriptSnapshot(records.map((record) => record.message));
  const firstKeptBranchIndex = resolveNativeFirstKeptBranchIndex(
    branchEntries,
    records,
    snapshot,
    state,
    preparation.firstKeptEntryId
  );
  const firstKeptEntryId = branchEntries[firstKeptBranchIndex]?.id ?? preparation.firstKeptEntryId;
  const hiddenSourceKeys = new Set(
    snapshot.sourceItems
      .filter((item) => records[item.ordinal]?.branchIndex < firstKeptBranchIndex)
      .map((item) => item.key)
  );
  const hiddenMessageCount = hiddenSourceKeys.size;
  const represented = resolveRepresentedBlocks(state, snapshot, hiddenSourceKeys);
  const rawExcerpts = buildRawExcerpts(
    records,
    snapshot,
    firstKeptBranchIndex,
    represented.coveredSourceKeys
  );
  // Render ALL DCP blocks (active + previously deactivated) tiered by recency.
  const allBlocks = [...state.compressionBlocks].sort(
    (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
  );
  const { readFiles, modifiedFiles } = collectFileLists(allBlocks, preparation.fileOps);
  const representedBlockIds = represented.blocks.map((block) => block.id);
  const requestedBlockIds = request.requestedBlockIds ?? [];
  const summaryParts: string[] = [];

  // Strip any prior DCP envelope from previousSummary so we don't nest. Keep
  // anything outside the envelope (LLM-fallback prose, user notes). Cap residue
  // by tokens to keep it bounded.
  const previousRaw = preparation.previousSummary?.trim() ?? "";
  if (previousRaw.length > 0) {
    const residue = stripDcpEnvelope(previousRaw);
    if (residue.length > 0) {
      const capped = truncateByTokens(residue, _config.nativeCompaction.maxPreviousSummaryTokens);
      if (capped.length > 0) summaryParts.push(capped);
    }
  }

  if (allBlocks.length > 0) {
    const dcpBody = renderWithBudget(
      allBlocks,
      _config.compress.renderFullBlockCount,
      _config.compress.renderCompactBlockCount,
      _config.nativeCompaction.maxSummaryTokens
    );
    if (dcpBody.length > 0) {
      summaryParts.push(`${DCP_ENVELOPE_OPEN}\n${dcpBody}\n${DCP_ENVELOPE_CLOSE}`);
    }
  }

  const summary = `${summaryParts.join("\n\n")}${formatFileTags(readFiles, modifiedFiles)}`;

  return {
    summary,
    firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: {
      source: DCP_NATIVE_COMPACTION_DETAILS_SOURCE,
      version: 1,
      requestId: request.id,
      reason: request.reason,
      representedBlockIds,
      requestedBlockIds,
      firstKeptEntryId,
      hiddenMessageCount,
      uncoveredHiddenMessageCount: rawExcerpts.uncoveredCount,
      renderedUncoveredExcerptCount: rawExcerpts.renderedCount,
      truncatedUncoveredExcerptCount: rawExcerpts.truncatedCount,
      readFiles,
      modifiedFiles,
    },
  };
}

export function triggerDcpNativeCompaction(
  ctx: ExtensionContext,
  state: DcpState,
  reason: DcpNativeCompactionReason = "command",
  requestOrRequestedBlockIds: DcpNativeCompactionRequest | number[] | undefined = undefined
): Promise<{ started: boolean; completed: boolean }> {
  if (!state.compressionBlocks.some((block) => block.active)) {
    notify(ctx, "DCP native compaction skipped: no active compression blocks.", "info");
    return Promise.resolve({ started: false, completed: false });
  }

  const request = Array.isArray(requestOrRequestedBlockIds)
    ? createRequest(reason, requestOrRequestedBlockIds)
    : (requestOrRequestedBlockIds ?? createRequest(reason));

  pendingRequests.set(state, request);
  notify(ctx, "DCP native compaction queued", "info");
  const customInstructions = buildDcpFallbackCustomInstructions(state);
  return new Promise((resolve) => {
    ctx.compact({
      customInstructions,
      onComplete: (result) => {
        const pending = pendingRequests.get(state);
        if (pending?.id === request.id) pendingRequests.delete(state);
        notify(ctx, `DCP native compaction complete: kept from ${result.firstKeptEntryId}`, "info");
        resolve({ started: true, completed: true });
      },
      onError: (error) => {
        const pending = pendingRequests.get(state);
        if (pending?.id === request.id) pendingRequests.delete(state);
        notify(ctx, `DCP native compaction failed: ${error.message}`, "error");
        resolve({ started: true, completed: false });
      },
    });
  });
}

export function registerDcpNativeCompactionBridge(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig
): void {
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
    if (!state.compressionBlocks.some((block) => block.active)) return;

    const coverage = computeDcpHiddenCoverage(
      state,
      event.branchEntries,
      event.preparation.firstKeptEntryId
    );
    const minRatio = config.nativeCompaction.minHiddenCoverageRatio ?? 0;
    if (coverage.ratio < minRatio) {
      appendDebugLog(config, "native_compaction_skipped_low_coverage", {
        ...buildSessionDebugPayload(ctx.sessionManager),
        coverageRatio: coverage.ratio,
        minHiddenCoverageRatio: minRatio,
        hiddenMessageCount: coverage.hiddenMessageCount,
        coveredHiddenCount: coverage.coveredHiddenCount,
      });
      return;
    }

    const request = pendingRequests.get(state) ?? createRequest("host");

    const result = buildDcpNativeCompactionResult({
      state,
      config,
      branchEntries: event.branchEntries,
      preparation: event.preparation,
      request,
    });

    appendDebugLog(config, "native_compaction_prepared", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      request,
      representedBlockIds: result.details?.representedBlockIds ?? [],
      firstKeptEntryId: result.firstKeptEntryId,
      hiddenMessageCount: result.details?.hiddenMessageCount ?? 0,
      coverageRatio: coverage.ratio,
      uncoveredHiddenMessageCount: result.details?.uncoveredHiddenMessageCount ?? 0,
    });

    return { compaction: result };
  });

  pi.on("session_compact", async (event, ctx) => {
    const details = event.compactionEntry.details;
    if (!isDcpNativeCompactionDetails(details)) return;

    const representedBlockIds = new Set(details.representedBlockIds);
    // Native compaction permanently bakes represented blocks' coverage into
    // the rebuilt transcript. Move their estimated savings into the lifetime
    // counter BEFORE deactivating them, so the footer total does not appear
    // to regress immediately after a compaction.
    let realizedDelta = 0;
    for (const block of state.compressionBlocks) {
      if (!representedBlockIds.has(block.id)) continue;
      if (!block.active) continue;
      realizedDelta += block.savedTokenEstimate ?? 0;
      block.active = false;
    }
    state.lifetimeTokensSavedRealized = Math.max(
      0,
      (state.lifetimeTokensSavedRealized ?? 0) + realizedDelta
    );
    state.tokensSaved = state.compressionBlocks
      .filter((block) => block.active)
      .reduce((sum, block) => sum + (block.savedTokenEstimate ?? 0), 0);
    // Pi rebuilds agent.state.messages as [compactionSummary, ...keptTail], so the
    // next context event will compute a much smaller logical-turn count than
    // before compaction. Without resetting these turn watermarks, the
    // currentTurn <= lastCompressTurn debounce silences nudges for many
    // post-compaction turns. Reset them to -1 so the next nudge can fire freely.
    state.lastCompressTurn = -1;
    state.lastNudgeTurn = -1;
    pendingRequests.delete(state);
    pendingAutoRequests.delete(state);

    appendDebugLog(config, "native_compaction_committed", {
      ...buildSessionDebugPayload(ctx.sessionManager),
      requestId: details.requestId,
      representedBlockIds: details.representedBlockIds,
      firstKeptEntryId: details.firstKeptEntryId,
      remainingActiveCompressionBlockCount: state.compressionBlocks.filter((block) => block.active)
        .length,
      tokensSavedAfter: state.tokensSaved,
    });

    if (ctx.hasUI) updateDcpStatus(ctx, state);
    saveState(pi, state, config, "native_compaction", buildSessionDebugPayload(ctx.sessionManager));
  });

  pi.on("turn_end", async (_event, ctx) => {
    const pending = pendingAutoRequests.get(state);
    if (!pending) return;

    // Consume the queue entry up front, BEFORE the await. This is single-shot
    // semantics: a successful `compress` queues exactly one native compaction
    // attempt. Whether that attempt succeeds, errors, or gets cancelled, the
    // queue must drain so the next turn_end does not re-fire compaction in a
    // loop. The previous design only cleared it on `session_compact` (success
    // path), which combined with the auto-resume prompt below produced an
    // infinite cancel/retry loop when compaction was cancelled.
    pendingAutoRequests.delete(state);

    if (!state.compressionBlocks.some((block) => block.active)) return;

    const result = await triggerDcpNativeCompaction(ctx, state, "auto", pending.requestedBlockIds);

    // Only post a continuation prompt when compaction actually completed.
    // Cancellation / error paths must not stack a follow-up turn, because:
    //   - the user may have cancelled deliberately
    //   - the next turn would just re-trigger the same failure if state was
    //     somehow re-queued by other code
    //   - chaining "continue" prompts after every failure is loop bait
    // Also skip when the user already typed something during compaction; pi
    // will deliver their input on the next turn on its own.
    if (!result.started || !result.completed) return;
    if (ctx.hasPendingMessages()) return;

    try {
      pi.sendUserMessage(
        "[dcp-auto-compaction] Session was just compacted to free context. Continue with the task you were working on, using the compaction summary and active DCP blocks as ground truth for prior work."
      );
      appendDebugLog(config, "native_compaction_auto_resume_sent", {
        ...buildSessionDebugPayload(ctx.sessionManager),
      });
    } catch (error) {
      appendDebugLog(config, "native_compaction_auto_resume_failed", {
        ...buildSessionDebugPayload(ctx.sessionManager),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
