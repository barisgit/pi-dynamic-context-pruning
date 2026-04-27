// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — v2 materialization scaffolding
// ---------------------------------------------------------------------------

import { stripDcpMetadataTags } from "../refs/metadata.js";
import type { CompressionBlockV2, CompressionLogEntry } from "../../types/state.js";
import type { DcpMessage } from "../../types/message.js";
import { buildBlockOwnerKey, buildSourceOwnerKey } from "../transcript/index.js";
import type { TranscriptSnapshot } from "../transcript/index.js";

/** Result of v2 transcript materialization. */
export interface MaterializedTranscript {
  /** Outbound message list to send to the provider */
  messages: DcpMessage[];
  /** Active v2 block IDs rendered into the transcript */
  renderedBlockIds: number[];
  /** Internal owner key for each rendered message, index-aligned with messages. */
  messageOwnerKeys: string[];
  /** Stable source key for each rendered message, index-aligned with messages. */
  messageSourceKeys: string[];
}

export interface MaterializeTranscriptOptions {
  /** Number of newest active rendered blocks shown with full detail. */
  renderFullBlockCount?: number;
  /** Number of active rendered blocks after the full-detail window shown compactly. */
  renderCompactBlockCount?: number;
}

export type CompressionBlockRenderDetail = "full" | "compact" | "minimal";

/** Minimal shared shape needed to render a compressed block message. */
export interface CompressionBlockRenderData {
  id: number;
  topic: string;
  summary: string;
  activityLogVersion?: number;
  activityLog?: CompressionLogEntry[];
  detailLevel?: CompressionBlockRenderDetail;
}

const MAX_ACTIVITY_LOG_LINES = 48;
const MAX_ACTIVITY_LOG_CHARS = 420;
const MAX_COMPACT_SUMMARY_CHARS = 320;
const MAX_MINIMAL_SUMMARY_CHARS = 140;

function cloneMessage(message: any): any {
  const clone = { ...message };
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.map((block: any) =>
      typeof block === "object" && block !== null ? { ...block } : block
    );
  }
  return clone;
}

function resolveRenderDetailByBlockId(
  blocks: CompressionBlockV2[],
  options: MaterializeTranscriptOptions
): Map<number, CompressionBlockRenderDetail> {
  const fullCount = Math.max(0, Math.floor(options.renderFullBlockCount ?? 0));
  const compactCount = Math.max(0, Math.floor(options.renderCompactBlockCount ?? 0));
  const details = new Map<number, CompressionBlockRenderDetail>();

  const blocksByRecency = [...blocks].sort((a, b) => (b.createdAt ?? b.id) - (a.createdAt ?? a.id));
  blocksByRecency.forEach((block, index) => {
    const detailLevel =
      index < fullCount ? "full" : index < fullCount + compactCount ? "compact" : "minimal";
    details.set(block.id, detailLevel);
  });

  return details;
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function renderLogEntry(entry: CompressionLogEntry): string {
  const prefix =
    entry.kind === "user_excerpt"
      ? "u: "
      : entry.kind === "assistant_excerpt"
        ? "a: "
        : entry.kind === "command"
          ? "cmd: "
          : `${entry.kind}: `;

  return (
    prefix +
    truncateText(
      normalizeInlineWhitespace(stripDcpMetadataTags(entry.text)),
      MAX_ACTIVITY_LOG_CHARS
    )
  );
}

/** Render the plain text body for a compressed block. */
export function renderCompressedBlockText(block: CompressionBlockRenderData): string {
  const detailLevel = block.detailLevel ?? "full";
  const summary = block.summary.trim();
  const normalizedSummary = normalizeInlineWhitespace(summary);
  const activityLog = (block.activityLog ?? []).slice(0, MAX_ACTIVITY_LOG_LINES);
  const parts = [
    `[Compressed section: ${block.topic}]`,
    `<dcp-block-id>b${block.id}</dcp-block-id>`,
  ];

  if (detailLevel === "minimal") {
    parts.push(truncateText(normalizedSummary, MAX_MINIMAL_SUMMARY_CHARS));
  } else if (detailLevel === "compact") {
    parts.push(
      `<agent-summary>\n${truncateText(summary, MAX_COMPACT_SUMMARY_CHARS)}\n</agent-summary>`
    );
  } else if (activityLog.length > 0) {
    parts.push(`<agent-summary>\n${summary}\n</agent-summary>`);
    parts.push(`<activity-log>\n${activityLog.map(renderLogEntry).join("\n")}\n</activity-log>`);
  } else {
    parts.push(summary);
  }

  parts.push(``);
  return parts.join("\n\n");
}

/**
 * Render a synthetic compressed-block message.
 *
 * Shared by the legacy v1 runtime path and the draft v2 materializer so the
 * visible block shape can evolve in one place.
 */
export function renderCompressedBlockMessage(block: CompressionBlockRenderData): DcpMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: renderCompressedBlockText(block),
      },
    ],
  };
}

/**
 * Materialize a transcript snapshot plus active v2 blocks.
 *
 * Invalid, unresolved, or overlapping active blocks are skipped conservatively:
 * untouched source messages remain cloned into the materialized transcript.
 */
export function materializeTranscript(
  snapshot: TranscriptSnapshot,
  blocks: CompressionBlockV2[],
  options: MaterializeTranscriptOptions = {}
): MaterializedTranscript {
  const sourceItemByKey = new Map(snapshot.sourceItems.map((item) => [item.key, item]));
  const spanIndexByKey = new Map(snapshot.spans.map((span, index) => [span.key, index]));
  const activeBlocks = blocks.filter((block) => block.status === "active");
  const detailByBlockId = resolveRenderDetailByBlockId(activeBlocks, options);
  const replacementByStartIndex = new Map<
    number,
    { block: CompressionBlockV2; endIndex: number; detailLevel: CompressionBlockRenderDetail }
  >();
  const coveredSpanIndexes = new Set<number>();

  for (const block of activeBlocks) {
    const startIndex = spanIndexByKey.get(block.startSpanKey);
    const endIndex = spanIndexByKey.get(block.endSpanKey);
    if (startIndex === undefined || endIndex === undefined || startIndex > endIndex) continue;

    let overlapsRenderedBlock = false;
    for (let index = startIndex; index <= endIndex; index++) {
      if (coveredSpanIndexes.has(index)) {
        overlapsRenderedBlock = true;
        break;
      }
    }
    if (overlapsRenderedBlock) continue;

    for (let index = startIndex; index <= endIndex; index++) {
      coveredSpanIndexes.add(index);
    }
    replacementByStartIndex.set(startIndex, {
      block,
      endIndex,
      detailLevel: detailByBlockId.get(block.id) ?? "minimal",
    });
  }

  const messages: DcpMessage[] = [];
  const renderedBlockIds: number[] = [];
  const messageOwnerKeys: string[] = [];
  const messageSourceKeys: string[] = [];

  for (let spanIndex = 0; spanIndex < snapshot.spans.length; spanIndex++) {
    const replacement = replacementByStartIndex.get(spanIndex);
    if (replacement) {
      messages.push(
        renderCompressedBlockMessage({
          ...replacement.block,
          detailLevel: replacement.detailLevel,
        })
      );
      renderedBlockIds.push(replacement.block.id);
      messageOwnerKeys.push(buildBlockOwnerKey(replacement.block.id));
      messageSourceKeys.push(buildBlockOwnerKey(replacement.block.id));
      spanIndex = replacement.endIndex;
      continue;
    }

    const span = snapshot.spans[spanIndex]!;
    for (const sourceKey of span.sourceKeys) {
      const sourceItem = sourceItemByKey.get(sourceKey);
      if (sourceItem) {
        messages.push(cloneMessage(sourceItem.message));
        messageOwnerKeys.push(buildSourceOwnerKey(sourceItem.ordinal));
        messageSourceKeys.push(sourceItem.key);
      }
    }
  }

  return {
    messages,
    renderedBlockIds,
    messageOwnerKeys,
    messageSourceKeys,
  };
}
