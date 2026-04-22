// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — v2 materialization scaffolding
// ---------------------------------------------------------------------------

import type { CompressionBlockV2 } from "./state.js"
import type { TranscriptSnapshot } from "./transcript.js"

/** Result of v2 transcript materialization. */
export interface MaterializedTranscript {
  /** Outbound message list to send to the provider */
  messages: any[]
  /** Active v2 block IDs rendered into the transcript */
  renderedBlockIds: number[]
}

function cloneMessage(message: any): any {
  const clone = { ...message }
  if (Array.isArray(clone.content)) {
    clone.content = clone.content.map((block: any) =>
      typeof block === "object" && block !== null ? { ...block } : block,
    )
  }
  return clone
}

/**
 * Render a synthetic v2 compressed-block message.
 *
 * Phase 1 adds the canonical rendering shape but does not yet splice these into
 * the live runtime transcript.
 */
export function renderCompressedBlockMessage(block: CompressionBlockV2): any {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `[Compressed section: ${block.topic}]\n\n` +
          `${block.summary}\n\n` +
          `<dcp-block-id>b${block.id}</dcp-block-id>`,
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
