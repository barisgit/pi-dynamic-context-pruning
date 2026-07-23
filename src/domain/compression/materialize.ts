// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — compressed block rendering
// ---------------------------------------------------------------------------

import { stripDcpMetadataTags } from "../refs/metadata.js";
import { INTERNAL_BLOCK_ID } from "../transcript/index.js";
import type { CompressionBlockMetadata, CompressionLogEntry } from "../../types/state.js";
import type { DcpMessage } from "../../types/message.js";

export type CompressionBlockRenderDetail = "full" | "compact" | "minimal";

/** Minimal shared shape needed to render a compressed block message. */
export interface CompressionBlockRenderData {
  id: number;
  topic: string;
  summary: string;
  activityLogVersion?: number;
  activityLog?: CompressionLogEntry[];
  metadata?: CompressionBlockMetadata;
  detailLevel?: CompressionBlockRenderDetail;
}

function renderConversationLines(entries: CompressionLogEntry[]): string[] {
  const conversation = entries.filter(
    (entry) => entry.kind === "user_excerpt" || entry.kind === "assistant_excerpt"
  );
  if (conversation.length <= MAX_CONVERSATION_LINES) return conversation.map(renderLogEntry);

  const headCount = Math.floor(MAX_CONVERSATION_LINES / 2);
  const tailCount = MAX_CONVERSATION_LINES - headCount;
  const omitted = conversation.length - headCount - tailCount;
  return [
    ...conversation.slice(0, headCount).map(renderLogEntry),
    `[... ${omitted} conversation entries omitted ...]`,
    ...conversation.slice(-tailCount).map(renderLogEntry),
  ];
}

function renderEffects(metadata: CompressionBlockMetadata | undefined): string | null {
  if (!metadata) return null;
  const effects = metadata.effectStats ?? {
    reads: metadata.fileReadStats.reduce((sum, stat) => sum + stat.count, 0),
    searches: 0,
    mutations: metadata.fileWriteStats.reduce((sum, stat) => sum + stat.editCount, 0),
    commands: metadata.commandStats.length,
    delegations: 0,
  };
  const lines = (["reads", "searches", "mutations", "commands", "delegations"] as const)
    .filter((key) => effects[key] > 0)
    .map((key) => `${key}: ${effects[key]}`);
  return lines.length > 0 ? `<effects>\n${lines.join("\n")}\n</effects>` : null;
}

function renderModifiedFiles(metadata: CompressionBlockMetadata | undefined): string | null {
  const paths = [...new Set(metadata?.fileWriteStats.map((stat) => stat.path) ?? [])].sort();
  if (paths.length === 0) return null;
  if (paths.length <= MAX_MODIFIED_FILE_LINES) {
    return `<modified-files>\n${paths.join("\n")}\n</modified-files>`;
  }

  const headCount = Math.floor(MAX_MODIFIED_FILE_LINES / 2);
  const tailCount = MAX_MODIFIED_FILE_LINES - headCount;
  const lines = [
    ...paths.slice(0, headCount),
    `[... ${paths.length - headCount - tailCount} modified files omitted ...]`,
    ...paths.slice(-tailCount),
  ];
  return `<modified-files>\n${lines.join("\n")}\n</modified-files>`;
}

const MAX_CONVERSATION_LINES = 48;
const MAX_MODIFIED_FILE_LINES = 80;
const MAX_CONVERSATION_LINE_CHARS = 800;
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
      MAX_CONVERSATION_LINE_CHARS
    )
  );
}

/** Render the plain text body for a compressed block. */
export function renderCompressedBlockText(block: CompressionBlockRenderData): string {
  const detailLevel = block.detailLevel ?? "full";
  const summary = block.summary.trim();
  const normalizedSummary = normalizeInlineWhitespace(summary);
  const conversation = renderConversationLines(block.activityLog ?? []);
  const parts = [`[Compressed section: ${block.topic}]`, ``];

  if (detailLevel === "minimal") {
    parts.push(truncateText(normalizedSummary, MAX_MINIMAL_SUMMARY_CHARS));
  } else if (detailLevel === "compact") {
    parts.push(
      `<agent-summary>\n${truncateText(summary, MAX_COMPACT_SUMMARY_CHARS)}\n</agent-summary>`
    );
  } else {
    parts.push(`<agent-summary>\n${summary}\n</agent-summary>`);
    if (conversation.length > 0) {
      parts.push(`<conversation>\n${conversation.join("\n")}\n</conversation>`);
    }
    const effects = renderEffects(block.metadata);
    if (effects) parts.push(effects);
    const modifiedFiles = renderModifiedFiles(block.metadata);
    if (modifiedFiles) parts.push(modifiedFiles);
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
