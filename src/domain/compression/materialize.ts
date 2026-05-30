// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compressed block rendering
// ---------------------------------------------------------------------------

import { stripDcpMetadataTags } from "../refs/metadata.js";
import { INTERNAL_BLOCK_ID } from "../transcript/index.js";
import type { CompressionLogEntry } from "../../types/state.js";
import type { DcpMessage } from "../../types/message.js";

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

const MAX_ACTIVITY_LOG_LINES = 96;
const MAX_ACTIVITY_LOG_CHARS = 800;
const MAX_COMPACT_SUMMARY_CHARS = 640;
const MAX_MINIMAL_SUMMARY_CHARS = 240;

export function cloneMessage(message: any): any {
  const clone = { ...message };
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.map((block: any) =>
      typeof block === "object" && block !== null ? { ...block } : block
    );
  }
  return clone;
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
  const parts = [`[Compressed section: ${block.topic}]`, ``];

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
 * Stamps the `INTERNAL_BLOCK_ID` Symbol on the synthesized message so
 * `buildSourceItemKey` produces a stable `synth:block:bN` key regardless of
 * where the block sits in the materialized buffer.
 */
export function renderCompressedBlockMessage(block: CompressionBlockRenderData): DcpMessage {
  const msg: DcpMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: renderCompressedBlockText(block),
      },
    ],
  };
  (msg as any)[INTERNAL_BLOCK_ID] = block.id;
  return msg;
}
