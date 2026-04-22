// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — canonical transcript scaffolding
// ---------------------------------------------------------------------------

// Phase 1 note:
// This file introduces deterministic source-item/span scaffolding for DCP v2
// without changing the active runtime behavior. The current runtime still uses
// `pruner.ts` for message transformation.

/** One source item in the canonical transcript snapshot. */
export interface TranscriptSourceItem {
  /** Stable-ish internal key derived from source order and message metadata */
  key: string
  /** Zero-based ordinal in the source transcript */
  ordinal: number
  /** Raw role from the source message */
  role: string
  /** Original source message */
  message: any
  /** Numeric timestamp when available */
  timestamp: number | null
}

/** Kinds of spans the v2 materializer will eventually operate on. */
export type TranscriptSpanKind = "message" | "tool-exchange"

/** Canonical span in the transcript snapshot. */
export interface TranscriptSpan {
  /** Stable key for the span itself */
  key: string
  /** Span kind */
  kind: TranscriptSpanKind
  /** Inclusive first source item key in the span */
  startSourceKey: string
  /** Inclusive last source item key in the span */
  endSourceKey: string
  /** Source items covered by the span */
  sourceKeys: string[]
  /** Dominant visible role for this span */
  role: string
  /** Number of source messages inside the span */
  messageCount: number
}

/** Snapshot of the transcript before any v2 materialization is applied. */
export interface TranscriptSnapshot {
  sourceItems: TranscriptSourceItem[]
  spans: TranscriptSpan[]
}

function getRole(message: any): string {
  return typeof message?.role === "string" ? message.role : "unknown"
}

function getTimestamp(message: any): number | null {
  return typeof message?.timestamp === "number" && Number.isFinite(message.timestamp)
    ? message.timestamp
    : null
}

/**
 * Build a deterministic source-item key.
 *
 * This is only a Phase 1 fallback key scheme. If pi later exposes durable
 * session-entry IDs, v2 should switch to those.
 */
export function buildSourceItemKey(message: any, ordinal: number): string {
  const role = getRole(message)
  const timestamp = getTimestamp(message)
  const toolCallId = typeof message?.toolCallId === "string" ? message.toolCallId : null

  if (toolCallId) {
    return `msg:${timestamp ?? "na"}:${role}:${toolCallId}:${ordinal}`
  }

  return `msg:${timestamp ?? "na"}:${role}:${ordinal}`
}

/**
 * Build a Phase 1 transcript snapshot.
 *
 * For now, each source message becomes its own `message` span. Future phases
 * will coalesce assistant/tool-result groups into `tool-exchange` spans.
 */
export function buildTranscriptSnapshot(messages: any[]): TranscriptSnapshot {
  const sourceItems: TranscriptSourceItem[] = messages.map((message, ordinal) => {
    const key = buildSourceItemKey(message, ordinal)
    return {
      key,
      ordinal,
      role: getRole(message),
      message,
      timestamp: getTimestamp(message),
    }
  })

  const spans: TranscriptSpan[] = sourceItems.map((item) => ({
    key: `span:${item.key}`,
    kind: "message",
    startSourceKey: item.key,
    endSourceKey: item.key,
    sourceKeys: [item.key],
    role: item.role,
    messageCount: 1,
  }))

  return { sourceItems, spans }
}
