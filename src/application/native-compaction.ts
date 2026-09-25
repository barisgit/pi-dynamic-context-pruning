import {
  generateCheckpointHandoff,
  type CheckpointHandoffGenerator,
} from "./checkpoint-handoff.js";
import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { DcpConfig } from "../types/config.js";
import type { CompressionBlock, DcpState } from "../types/state.js";
import { renderCompressedBlockText } from "../domain/compression/materialize.js";
import { estimateTokens } from "../domain/tokens/estimate.js";
import { buildTranscriptSnapshot } from "../domain/transcript/index.js";
import type { DcpMessage } from "../types/message.js";
import { appendDebugLog, buildSessionDebugPayload } from "../infrastructure/debug-log.js";
import { saveState } from "./session-handler.js";
import { updateDcpStatus } from "./status.js";

import { selectRetainedCompressionBlockDetails } from "../domain/pruning/index.js";

const DCP_NATIVE_COMPACTION_DETAILS_SOURCE = "dcp-native-compaction";

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
  handoff?: string;
}

const pendingRequests = new WeakMap<DcpState, DcpNativeCompactionRequest>();
// Pi may complete an in-flight compact after reload or branch replacement.
// Callback contexts then belong to the old runtime and must not be accessed.
const sessionGeneration = new WeakMap<DcpState, number>();
// Host-generated checkpoints have host details; retain commit bookkeeping only
// for the in-flight fallback, without changing the persisted checkpoint schema.
const pendingFallbackDetails = new WeakMap<DcpState, DcpNativeCompactionDetails>();
const pendingAutoRequests = new WeakMap<DcpState, { requestedBlockIds: number[] | undefined }>();

export function queueDcpAutoNativeCompaction(state: DcpState, requestedBlockIds: number[]): void {
  pendingAutoRequests.set(state, { requestedBlockIds });
}

export function hasPendingDcpAutoNativeCompaction(state: DcpState): boolean {
  return pendingAutoRequests.has(state);
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
  // Lower-bound the hidden set at the live render-window start (the latest
  // PRIOR compaction's firstKeptEntryId). Entries before it were already hidden
  // by that compaction and pi no longer renders them, so this new compaction is
  // not hiding them again. Without this bound the denominator counts the entire
  // on-disk lineage, so in an already-compacted session the ratio collapses
  // (e.g. 8/2187) below minHiddenCoverageRatio and pi's LLM summarizer runs
  // instead of DCP — even though the live window is ~96% DCP-covered.
  const windowStartBranchIndex = resolveLiveWindowStartBranchIndex(branchEntries);
  const snapshot = buildTranscriptSnapshot(records.map((record) => record.message));
  const hiddenKeys = new Set<string>();
  for (const item of snapshot.sourceItems) {
    const rec = records[item.ordinal];
    if (
      rec &&
      isRawHistoryRecord(rec) &&
      rec.branchIndex >= windowStartBranchIndex &&
      rec.branchIndex < firstKeptBranchIndex
    ) {
      hiddenKeys.add(item.key);
    }
  }
  const hiddenMessageCount = hiddenKeys.size;
  if (hiddenMessageCount === 0) {
    return { ratio: 1, hiddenMessageCount: 0, coveredHiddenCount: 0 };
  }
  const covered = new Set<string>();
  for (const block of state.compressionBlocks.filter((b) => b.active)) {
    const coveredKeys = resolveBlockCoveredSourceKeys(block);
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

/**
 * Branch index where the live (currently TUI-rendered) window begins: the
 * position of the latest EXISTING compaction's `firstKeptEntryId`. Mirrors pi's
 * `buildSessionContext`, which renders only from the latest compaction's
 * `firstKeptEntryId` onward. Entries before it remain on disk for lineage but
 * are not rendered, so they must be excluded from both the hidden-coverage
 * denominator and raw-excerpt embedding. Returns 0 when the branch has no prior
 * compaction (the whole branch is the live window) or the boundary entry cannot
 * be resolved (conservative: count from the start).
 */
function resolveLiveWindowStartBranchIndex(branchEntries: SessionEntry[]): number {
  let latestCompaction: { firstKeptEntryId?: unknown } | null = null;
  for (const entry of branchEntries) {
    if ((entry as { type?: unknown }).type === "compaction") {
      latestCompaction = entry as { firstKeptEntryId?: unknown };
    }
  }
  if (!latestCompaction || typeof latestCompaction.firstKeptEntryId !== "string") return 0;
  const firstKeptEntryId = latestCompaction.firstKeptEntryId;
  const index = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  return index >= 0 ? index : 0;
}

/** Only exact source keys certify that raw content may be omitted at a checkpoint. */
function resolveBlockCoveredSourceKeys(block: CompressionBlock): Set<string> {
  // Legacy timestamp ranges can include unrelated same-timestamp messages.
  // Preserve those authored summaries, but carry their source as uncovered raw.
  return new Set(block.metadata?.coveredSourceKeys ?? []);
}

function resolveRepresentedBlocks(
  state: DcpState,
  hiddenSourceKeys: Set<string>
): { blocks: CompressionBlock[]; coveredSourceKeys: Set<string> } {
  const coveredSourceKeys = new Set<string>();
  const blocks: CompressionBlock[] = [];

  for (const block of state.compressionBlocks.filter((candidate) => candidate.active)) {
    const blockKeys = resolveBlockCoveredSourceKeys(block);
    if (blockKeys.size === 0) continue;

    const fullyHidden = Array.from(blockKeys).every((key) => hiddenSourceKeys.has(key));
    if (!fullyHidden) continue;

    blocks.push(block);
    for (const key of blockKeys) coveredSourceKeys.add(key);
  }

  blocks.sort((a, b) => a.startTimestamp - b.startTimestamp || a.id - b.id);
  return { blocks, coveredSourceKeys };
}

// Keep compaction entries in the source snapshot to preserve canonical ordinals,
// but prior summaries inform the fresh handoff, never accumulate as raw gaps.
function isRawHistoryRecord(record: BranchMessageRecord): boolean {
  return (
    record.entry.type !== "compaction" &&
    !(record.message.role === "bashExecution" && record.message.excludeFromContext)
  );
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

// Live blocks use Record headers for local chronology. Those boundary refs are
// not actionable after compaction; also remove headers expanded from older bN blocks.
function stripRecordHeaders(text: string): string {
  return text.replace(
    /^Record (?:m\d+|b\d+)–(?:m\d+|b\d+) \(ended \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\)\n\n/gm,
    ""
  );
}

function renderBlockForCompaction(block: CompressionBlock): string {
  return stripRecordHeaders(renderCompressedBlockText({ ...block, detailLevel: "full" })).trim();
}

export function buildDcpNativeCompactionResult({
  state,
  config: _config,
  branchEntries,
  preparation,
  request,
  handoff,
}: BuildDcpNativeCompactionResultArgs): CompactionResult<DcpNativeCompactionDetails> {
  const records = buildBranchMessageRecords(branchEntries);
  const snapshot = buildTranscriptSnapshot(records.map((record) => record.message));
  const firstKeptBranchIndex = branchEntries.findIndex(
    (entry) => entry.id === preparation.firstKeptEntryId
  );
  if (firstKeptBranchIndex < 0) throw new Error("Unknown compaction boundary; history retained.");
  const firstKeptEntryId = preparation.firstKeptEntryId;
  // Window the hidden set at the live render-window start, consistent with the
  // coverage gate: only messages newly hidden by THIS compaction count, not
  // already-compacted history still resident on disk.
  const windowStartBranchIndex = resolveLiveWindowStartBranchIndex(branchEntries);
  const hiddenSourceKeys = new Set(
    snapshot.sourceItems
      .filter((item) => {
        const branchIndex = records[item.ordinal]?.branchIndex;
        return (
          branchIndex !== undefined &&
          isRawHistoryRecord(records[item.ordinal]) &&
          branchIndex >= windowStartBranchIndex &&
          branchIndex < firstKeptBranchIndex
        );
      })
      .map((item) => item.key)
  );
  const hiddenMessageCount = hiddenSourceKeys.size;
  const represented = resolveRepresentedBlocks(state, hiddenSourceKeys);
  const { readFiles, modifiedFiles } = collectFileLists(represented.blocks, preparation.fileOps);
  const representedBlockIds = represented.blocks.map((block) => block.id);
  const requestedBlockIds = request.requestedBlockIds ?? [];
  const tiers = selectRetainedCompressionBlockDetails(
    state.compressionBlocks,
    _config.compress.renderFullBlockCount,
    _config.compress.renderCompactBlockCount
  );
  // Newest first for admission; render admitted records chronologically.
  const retained = [...tiers.keys()].map((id) => state.compressionBlocks.find((b) => b.id === id)!);
  const render = (metadata: boolean): string =>
    [
      handoff ? `<current-orientation>\n${handoff}\n</current-orientation>` : "",
      ...[...retained].reverse().map(
        (block) =>
          `<section topic="${escapeAttr(block.topic)}">\n${stripRecordHeaders(
            renderCompressedBlockText({
              ...block,
              detailLevel: metadata ? tiers.get(block.id) : "compact",
            })
          ).trim()}\n</section>`
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
  // Prior summaries informed the fresh handoff; never append them recursively.
  // Uncovered source (including tool evidence) is intentionally not raw-carried.
  let summary = render(true);
  const budget = _config.nativeCompaction.maxSummaryTokens;
  if (budget > 0 && estimateTokens(summary) > budget) summary = render(false);
  while (budget > 0 && estimateTokens(summary) > budget && retained.length > 0) {
    retained.pop(); // Drop a whole oldest record, never clip its authored summary.
    summary = render(false);
  }
  if (budget > 0 && estimateTokens(summary) > budget) {
    throw new Error("Fresh checkpoint orientation exceeds the DCP budget; use host summarization.");
  }

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
      uncoveredHiddenMessageCount: hiddenMessageCount - represented.coveredSourceKeys.size,
      renderedUncoveredExcerptCount: 0,
      truncatedUncoveredExcerptCount: 0,
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

  const generation = sessionGeneration.get(state) ?? 0;
  pendingRequests.set(state, request);
  notify(ctx, "DCP native compaction queued", "info");
  // Historical records already enter the fresh handoff. Do not duplicate the
  // entire archive in host custom instructions or bypass the retention budget.
  const customInstructions =
    "Preserve current authorized intent, explicit permissions and prohibitions, and recent corrections from the fresh previousSummary handoff. Summarize useful evidence; do not recursively retain historical checkpoints.";
  return new Promise((resolve) => {
    ctx.compact({
      customInstructions,
      onComplete: (result) => {
        if ((sessionGeneration.get(state) ?? 0) === generation) {
          const pending = pendingRequests.get(state);
          if (pending?.id === request.id) pendingRequests.delete(state);
          notify(
            ctx,
            `DCP native compaction complete: kept from ${result.firstKeptEntryId}`,
            "info"
          );
        }
        resolve({ started: true, completed: true });
      },
      onError: (error) => {
        if ((sessionGeneration.get(state) ?? 0) === generation) {
          const pending = pendingRequests.get(state);
          if (pending?.id === request.id) pendingRequests.delete(state);
          notify(ctx, `DCP native compaction failed: ${error.message}`, "error");
        }
        resolve({ started: true, completed: false });
      },
    });
  });
}

export function registerDcpNativeCompactionBridge(
  pi: ExtensionAPI,
  state: DcpState,
  config: DcpConfig,
  generateHandoff: CheckpointHandoffGenerator = generateCheckpointHandoff
): void {
  const retirePendingRequest = (): void => {
    sessionGeneration.set(state, (sessionGeneration.get(state) ?? 0) + 1);
    pendingRequests.delete(state);
    pendingFallbackDetails.delete(state);
    pendingAutoRequests.delete(state);
  };
  // A mid-run session_start can re-fire on the same branch; only shutdown or
  // a genuine tree switch retires this in-flight callback.
  pi.on("session_shutdown", retirePendingRequest);
  pi.on("session_tree", retirePendingRequest);

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
    pendingFallbackDetails.delete(state);
    if (!config.enabled || !config.nativeCompaction.enabled) return;
    const request = pendingRequests.get(state) ?? createRequest("host");
    // Validate the actual returned boundary before either DCP or host fallback.
    if (!event.branchEntries.some((entry) => entry.id === event.preparation.firstKeptEntryId)) {
      notify(ctx, "DCP checkpoint cancelled: unknown compaction boundary.", "error");
      return { cancel: true };
    }
    let handoff: string;
    try {
      handoff = await generateHandoff(event, ctx, state, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, `DCP checkpoint orientation unavailable: ${message}`, "error");
      appendDebugLog(config, "native_compaction_cancelled", { error: message });
      return { cancel: true };
    }
    const coverage = computeDcpHiddenCoverage(
      state,
      event.branchEntries,
      event.preparation.firstKeptEntryId
    );
    const fallback = (): undefined => {
      // Pi consumes this shared preparation object, not mutations to event.customInstructions.
      // Replace rather than append: the fresh tail-informed orientation supersedes prior checkpoints.
      event.preparation.previousSummary = `Current authorized intent and constraints (apply later corrections; preserve explicit permissions):\n${handoff}`;
      const prepared = buildDcpNativeCompactionResult({
        state,
        config,
        branchEntries: event.branchEntries,
        preparation: event.preparation,
        request,
      });
      pendingFallbackDetails.set(state, prepared.details!);
      appendDebugLog(config, "native_compaction_host_fallback", { coverageRatio: coverage.ratio });
      return undefined;
    };
    if (coverage.ratio < config.nativeCompaction.minHiddenCoverageRatio) return fallback();
    let result: CompactionResult<DcpNativeCompactionDetails>;
    try {
      result = buildDcpNativeCompactionResult({
        state,
        config,
        branchEntries: event.branchEntries,
        preparation: event.preparation,
        request,
        handoff,
      });
    } catch (error) {
      appendDebugLog(config, "native_compaction_budget_fallback", { error: String(error) });
      return fallback();
    }

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
    const fallback = pendingFallbackDetails.get(state);
    pendingFallbackDetails.delete(state);
    const details = isDcpNativeCompactionDetails(event.compactionEntry.details)
      ? event.compactionEntry.details
      : fallback?.firstKeptEntryId === event.compactionEntry.firstKeptEntryId
        ? fallback
        : undefined;
    if (!details) return;

    const representedBlockIds = new Set(details.representedBlockIds);
    // The checkpoint consumes these source ranges, whether their record was
    // retained or intentionally omitted by the budget/aging policy. Retire all
    // fully hidden blocks, not only the rendered subset, to prevent revival.
    // Move their estimated savings into the lifetime
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
    state.pendingSave = true;
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

    // Post the auto-compaction continuation prompt HERE, not from `turn_end`.
    // `session_compact` fires only after compaction has actually committed, so
    // reaching this point already implies success — no started/completed
    // bookkeeping needed. Gating:
    //   - reason === "auto": manual `/dcp compact` ("command") and host-driven
    //     ("host") compactions must NOT auto-resume; only the post-`compress`
    //     auto path should continue the interrupted task on its own.
    // The cancel/error path never reaches `session_compact` (no entry is
    // committed), so it inherently posts no prompt.
    //
    // We intentionally do NOT gate on `ctx.hasPendingMessages()`. The earlier
    // assumption was that, if the user typed during compaction, pi would
    // deliver their input on the next turn and a stacked resume prompt would be
    // noise. That is false for THIS compaction path: `ctx.compact()` routes
    // through `AgentSession.compact()`, which swaps `agent.state.messages` and
    // returns idle WITHOUT draining the steering/follow-up queues and WITHOUT
    // kicking a turn. The only automatic steering drain lives inside the agent
    // run loop, which is not running once compaction finishes. (pi's OWN
    // auto-compaction kicks `agent.continue()` for exactly this reason, but
    // that kick does not exist on the extension-driven `compact()` path.) So a
    // steering message queued during compaction is stranded with no turn to
    // deliver it — the session just stops. Always posting the resume prompt on
    // the auto path starts a fresh run; that run's initial steering poll drains
    // the queued message and delivers it alongside the resume prompt.
    if (details.reason === "auto") {
      // Defer the kick to a fresh macrotask. `session_compact` is awaited by
      // `AgentSession.compact()` BEFORE its `finally { _reconnectToAgent() }`,
      // so starting a turn synchronously here would re-enter `agent.prompt()`
      // while compaction is still mid-cleanup (risking a run whose messages
      // bypass the session manager). pi defers its own post-compaction
      // `continue()` via setTimeout "to break out of event handler chain" for
      // the same reason; we mirror that here.
      const generation = sessionGeneration.get(state) ?? 0;
      setTimeout(() => {
        // Reload or branch replacement retires this continuation before it can
        // touch the old pi API (or its now-throwing context getters).
        if ((sessionGeneration.get(state) ?? 0) !== generation) return;
        try {
          pi.sendUserMessage(
            "[dcp-auto-compaction] Continue the authorized task from the summary and active DCP blocks. Follow newer user directions and corrections; do not repeat completed work or revive superseded plans."
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
      }, 0);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const pending = pendingAutoRequests.get(state);
    if (!pending) return;

    // Consume the queue entry up front. This is single-shot semantics: a
    // successful `compress` queues exactly one native compaction attempt.
    // Whether that attempt succeeds, errors, or gets cancelled, the queue must
    // drain so the next turn_end does not re-fire compaction in a loop.
    pendingAutoRequests.delete(state);

    if (!state.heading && !state.compressionBlocks.some((block) => block.active)) return;

    // CRITICAL: fire-and-forget. `ctx.compact()` is void; internally it awaits
    // `session.compact()` -> `waitForIdle()`, which cannot resolve until the
    // CURRENT turn goes idle. `turn_end` IS part of that turn (the host awaits
    // this handler before advancing), so awaiting compaction here is a circular
    // wait that deadlocks the session into an uninterruptible "Working...".
    // Kick compaction off and return immediately; the continuation prompt is
    // posted from the `session_compact` handler once compaction commits. The
    // returned promise resolves (never rejects) on onComplete/onError, but a
    // synchronous throw from ctx.compact would reject it; catch defensively so
    // a fire-and-forget rejection cannot become an unhandled rejection.
    triggerDcpNativeCompaction(ctx, state, "auto", pending.requestedBlockIds).catch((error) => {
      appendDebugLog(config, "native_compaction_auto_trigger_failed", {
        ...buildSessionDebugPayload(ctx.sessionManager),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
