// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — v2 materialization scaffolding
// ---------------------------------------------------------------------------

import { stripDcpMetadataTags } from "../refs/metadata.js"
import type { CompressionBlockV2, CompressionLogEntry } from "../../types/state.js"
import type { DcpMessage } from "../../types/message.js"
import type { TranscriptSnapshot } from "../transcript/index.js"

/** Result of v2 transcript materialization. */
export interface MaterializedTranscript {
  /** Outbound message list to send to the provider */
  messages: DcpMessage[]
  /** Active v2 block IDs rendered into the transcript */
  renderedBlockIds: number[]
}

export type CompressionBlockRenderDetail = "full" | "compact" | "minimal"

/** Minimal shared shape needed to render a compressed block message. */
export interface CompressionBlockRenderData {
  id: number
  topic: string
  summary: string
  activityLogVersion?: number
  activityLog?: CompressionLogEntry[]
  detailLevel?: CompressionBlockRenderDetail
}

const MAX_ACTIVITY_LOG_LINES = 48
const MAX_ACTIVITY_LOG_CHARS = 420
const MAX_COMPACT_SUMMARY_CHARS = 320
const MAX_MINIMAL_SUMMARY_CHARS = 140

function cloneMessage(message: any): any {
  const clone = { ...message }
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.map((block: any) =>
      typeof block === "object" && block !== null ? { ...block } : block,
    )
  }
  return clone
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…"
}

function renderLogEntry(entry: CompressionLogEntry): string {
  const prefix =
    entry.kind === "user_excerpt"
      ? "u: "
      : entry.kind === "assistant_excerpt"
        ? "a: "
        : entry.kind === "command"
          ? "cmd: "
          : `${entry.kind}: `

  return prefix + truncateText(
    normalizeInlineWhitespace(stripDcpMetadataTags(entry.text)),
    MAX_ACTIVITY_LOG_CHARS,
  )
}

/** Render the plain text body for a compressed block. */
export function renderCompressedBlockText(block: CompressionBlockRenderData): string {
  const detailLevel = block.detailLevel ?? "full"
  const summary = block.summary.trim()
  const normalizedSummary = normalizeInlineWhitespace(summary)
  const activityLog = (block.activityLog ?? []).slice(0, MAX_ACTIVITY_LOG_LINES)
  const parts = [`[Compressed section: ${block.topic}]`]

  if (detailLevel === "minimal") {
    parts.push(truncateText(normalizedSummary, MAX_MINIMAL_SUMMARY_CHARS))
  } else if (detailLevel === "compact") {
    parts.push(
      `<agent-summary>\n${truncateText(summary, MAX_COMPACT_SUMMARY_CHARS)}\n</agent-summary>`,
    )
  } else if (activityLog.length > 0) {
    parts.push(`<agent-summary>\n${summary}\n</agent-summary>`)
    parts.push(
      `<dcp-log v="${block.activityLogVersion ?? 1}">\n${activityLog
        .map(renderLogEntry)
        .join("\n")}\n</dcp-log>`,
    )
  } else {
    parts.push(summary)
  }

  parts.push(`<dcp-block-id>b${block.id}</dcp-block-id>`)
  return parts.join("\n\n")
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
  }
}

/**
 * Materialize a transcript snapshot plus active v2 blocks.
 *
 * Phase 1 keeps this intentionally conservative: it returns a clone of the raw
 * source transcript and exposes which v2 blocks are active. Future phases will
 * replace covered spans with `renderCompressedBlockMessage(...)`.
 */
export function materializeTranscript(
  snapshot: TranscriptSnapshot,
  blocks: CompressionBlockV2[],
): MaterializedTranscript {
  const messages = snapshot.sourceItems.map((item) => cloneMessage(item.message))
  const renderedBlockIds = blocks
    .filter((block) => block.status === "active")
    .map((block) => block.id)

  return {
    messages,
    renderedBlockIds,
  }
}
