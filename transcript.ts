// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — canonical transcript scaffolding
// ---------------------------------------------------------------------------

// Phase 1 note:
// This file introduces deterministic source-item/span scaffolding for DCP v2
// without changing the active runtime behavior. The current runtime still uses
// `pruner.ts` for message transformation.

import type { CompressionBlock } from "./state.js"

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

const PASSTHROUGH_ROLES = new Set(["compaction", "branch_summary", "custom_message"])
const LIVE_OWNER_ELIGIBLE_ROLES = new Set(["user", "assistant", "toolResult", "bashExecution"])

function getAssistantToolCallIds(message: any): Set<string> {
  const ids = new Set<string>()
  const content: any[] = Array.isArray(message?.content) ? message.content : []

  for (const block of content) {
    if (block?.type === "toolCall" && typeof block.id === "string") {
      ids.add(block.id)
    }
  }

  return ids
}

function isMatchingToolResult(message: any, toolCallIds: Set<string>): boolean {
  const role = getRole(message)
  if (role !== "toolResult" && role !== "bashExecution") return false
  return typeof message?.toolCallId === "string" && toolCallIds.has(message.toolCallId)
}

function createSpan(kind: TranscriptSpanKind, items: TranscriptSourceItem[]): TranscriptSpan {
  const first = items[0]!
  const last = items[items.length - 1]!

  return {
    key: `span:${first.key}..${last.key}`,
    kind,
    startSourceKey: first.key,
    endSourceKey: last.key,
    sourceKeys: items.map((item) => item.key),
    role: first.role,
    messageCount: items.length,
  }
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

export function buildSourceOwnerKey(ordinal: number): string {
  return `s${ordinal}`
}

export function buildBlockOwnerKey(blockId: number): string {
  return `block:b${blockId}`
}

function resolveLegacyCoveredOrdinals(
  snapshot: TranscriptSnapshot,
  compressionBlocks: CompressionBlock[],
): { coveredOrdinals: Set<number>; activeBlockOwnerKeys: Set<string> } {
  const coveredOrdinals = new Set<number>()
  const activeBlockOwnerKeys = new Set<string>()

  for (const block of compressionBlocks) {
    if (!block.active) continue
    if (!Number.isFinite(block.startTimestamp) || !Number.isFinite(block.endTimestamp)) continue

    const coveredItems = snapshot.sourceItems.filter(
      (item) =>
        item.timestamp !== null &&
        item.timestamp >= block.startTimestamp &&
        item.timestamp <= block.endTimestamp,
    )

    if (coveredItems.length === 0) continue

    activeBlockOwnerKeys.add(buildBlockOwnerKey(block.id))
    for (const item of coveredItems) {
      coveredOrdinals.add(item.ordinal)
    }
  }

  return { coveredOrdinals, activeBlockOwnerKeys }
}

export function buildLiveOwnerKeys(
  messages: any[],
  compressionBlocks: CompressionBlock[],
): Set<string> {
  const snapshot = buildTranscriptSnapshot(messages)
  const { coveredOrdinals, activeBlockOwnerKeys } = resolveLegacyCoveredOrdinals(
    snapshot,
    compressionBlocks,
  )
  const liveOwnerKeys = new Set<string>(activeBlockOwnerKeys)

  for (const item of snapshot.sourceItems) {
    if (!LIVE_OWNER_ELIGIBLE_ROLES.has(item.role)) continue
    if (coveredOrdinals.has(item.ordinal)) continue
    liveOwnerKeys.add(buildSourceOwnerKey(item.ordinal))
  }

  return liveOwnerKeys
}

/**
 * Build a Phase 1 transcript snapshot.
 *
 * This now performs one low-risk structural upgrade for v2: assistant messages
 * with tool calls are grouped together with their immediately-following
 * matching `toolResult` / `bashExecution` messages plus intervening passthrough
 * roles into a single `tool-exchange` span.
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

  const spans: TranscriptSpan[] = []

  for (let i = 0; i < sourceItems.length; i++) {
    const item = sourceItems[i]!

    if (item.role === "assistant") {
      const toolCallIds = getAssistantToolCallIds(item.message)

      if (toolCallIds.size > 0) {
        const grouped: TranscriptSourceItem[] = [item]
        const trailingPassthrough: TranscriptSourceItem[] = []
        let matchedResult = false
        let j = i + 1

        while (j < sourceItems.length) {
          const next = sourceItems[j]!

          if (PASSTHROUGH_ROLES.has(next.role)) {
            trailingPassthrough.push(next)
            j++
            continue
          }

          if (isMatchingToolResult(next.message, toolCallIds)) {
            grouped.push(...trailingPassthrough, next)
            trailingPassthrough.length = 0
            matchedResult = true
            j++
            continue
          }

          break
        }

        if (matchedResult) {
          grouped.push(...trailingPassthrough)
          spans.push(createSpan("tool-exchange", grouped))
          i = j - 1
          continue
        }
      }
    }

    spans.push(createSpan("message", [item]))
  }

  return { sourceItems, spans }
}
