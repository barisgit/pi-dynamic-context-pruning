// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — state types
// ---------------------------------------------------------------------------

import type { MessageAliasState, MessageRefSnapshotEntry } from "../message-refs.js"
import type { DcpMessage } from "./message.js"

/**
 * A record of a single tool call, keyed by toolCallId in DcpState.toolCalls.
 */
export interface ToolRecord {
  /** Matches ToolResultMessage.toolCallId */
  toolCallId: string
  /** Matches ToolResultMessage.toolName */
  toolName: string
  /** The arguments passed to the tool (from the corresponding ToolCall) */
  inputArgs: Record<string, unknown>
  /**
   * Deduplication fingerprint: `toolName::JSON(sortedArgs)`
   * Two calls with the same name + identical args share the same fingerprint.
   */
  inputFingerprint: string
  /** Whether the tool result was an error */
  isError: boolean
  /**
   * Zero-based index of the logical turn during which this tool was called.
   * Standalone visible messages count as turns; an assistant tool batch counts
   * as one turn.
   */
  turnIndex: number
  /** message.timestamp from the ToolResultMessage */
  timestamp: number
  /** Rough token estimate: sum of result text content lengths divided by 4 */
  tokenEstimate: number
}

/**
 * Legacy v1 compression block created by the `compress` tool.
 * Tracks a timestamp-bounded range of messages and where to inject the summary
 * back into the context.
 */
export interface CompressionBlock {
  /** Auto-incrementing integer ID */
  id: number
  /** Short human-readable topic label */
  topic: string
  /** LLM-generated summary text */
  summary: string
  /** Timestamp of the first message in the compressed range */
  startTimestamp: number
  /** Timestamp of the last message in the compressed range */
  endTimestamp: number
  /**
   * Timestamp of the first message *after* the range — legacy insertion
   * fallback for timestamp-only blocks.
   */
  anchorTimestamp: number
  /** Canonical source key of the first covered source item, when known. */
  startSourceKey?: string | null
  /** Canonical source key of the last covered source item, when known. */
  endSourceKey?: string | null
  /** Canonical source key before which this block should render, or a trailing anchor. */
  anchorSourceKey?: string | null
  /** Whether this block is still being applied (false = soft-deleted) */
  active: boolean
  /** Token estimate for the summary text itself */
  summaryTokenEstimate: number
  /** Current estimated net tokens saved by rendering this block */
  savedTokenEstimate?: number
  /** Wall-clock time the block was created (Date.now()) */
  createdAt: number
  /** Originating compress tool call id when this block came from a successful compress call */
  compressCallId?: string
  /** Version of the deterministic visible activity log format */
  activityLogVersion?: 1
  /** Deterministic chronological activity log shown in the rendered block */
  activityLog?: CompressionLogEntry[]
  /** Hidden exact coverage and artifact metadata */
  metadata?: CompressionBlockMetadata
}

/** Status for a v2 span-key compression block. */
export type CompressionBlockStatus = "active" | "superseded" | "decompressed"

/** Deterministic log entry rendered inside a v2 compressed block. */
export interface CompressionLogEntry {
  kind:
    | "user_excerpt"
    | "assistant_excerpt"
    | "read"
    | "edit"
    | "write"
    | "command"
    | "test"
    | "commit"
    | "tool"
  text: string
}

/** Hidden per-file read stats attached to a v2 compressed block. */
export interface CompressionFileReadStat {
  path: string
  count: number
  lineSpans: string[]
}

/** Hidden per-file write stats attached to a v2 compressed block. */
export interface CompressionFileWriteStat {
  path: string
  editCount: number
  addedLines: number
  removedLines: number
}

/** Hidden per-command stats attached to a v2 compressed block. */
export interface CompressionCommandStat {
  command: string
  status: "ok" | "error" | "other"
}

/** Hidden deterministic metadata attached to a v2 compressed block. */
export interface CompressionBlockMetadata {
  coveredSourceKeys: string[]
  coveredSpanKeys: string[]
  coveredArtifactRefs: string[]
  coveredToolIds: string[]
  supersededBlockIds: number[]
  fileReadStats: CompressionFileReadStat[]
  fileWriteStats: CompressionFileWriteStat[]
  commandStats: CompressionCommandStat[]
}

/**
 * Draft v2 compression block.
 *
 * v2 uses canonical span keys instead of raw timestamps and explicitly records
 * deterministic rendered activity plus hidden coverage metadata. Phase 1 only
 * introduces the type and persistence scaffolding — the active runtime still
 * materializes legacy v1 blocks.
 */
export interface CompressionBlockV2 {
  /** Auto-incrementing integer ID */
  id: number
  /** Short human-readable topic label */
  topic: string
  /** LLM-generated summary text */
  summary: string
  /** Canonical span key for the first covered span */
  startSpanKey: string
  /** Canonical span key for the last covered span */
  endSpanKey: string
  /** Lifecycle status of this block */
  status: CompressionBlockStatus
  /** Token estimate for the summary text itself */
  summaryTokenEstimate: number
  /** Wall-clock time the block was created (Date.now()) */
  createdAt: number
  /** Version of the deterministic visible activity log format */
  activityLogVersion: 1
  /** Deterministic chronological activity log shown in the rendered block */
  activityLog: CompressionLogEntry[]
  /** Hidden exact coverage and artifact metadata */
  metadata: CompressionBlockMetadata
}

/** Persisted v1 DCP state stored in session history. */
export interface PersistedDcpStateV1 {
  schemaVersion?: 1
  compressionBlocks: CompressionBlock[]
  nextBlockId: number
  messageAliases?: {
    bySourceKey: Record<string, string>
    byRef: Record<string, string>
    nextRef: number
  }
  prunedToolIds: string[]
  tokensSaved: number
  totalPruneCount: number
  manualMode: boolean
  lastNudgeTurn?: number
  lastCompressTurn?: number
}

/** Persisted v2 DCP state stored in session history. */
export interface PersistedDcpStateV2 {
  schemaVersion: 2
  blocks: CompressionBlockV2[]
  nextBlockId: number
  messageAliases?: {
    bySourceKey: Record<string, string>
    byRef: Record<string, string>
    nextRef: number
  }
  manualMode: boolean
  lastNudgeTurn?: number
  lastCompressTurn?: number
}

/** Any persisted DCP state shape supported during migration. */
export type PersistedDcpState = PersistedDcpStateV1 | PersistedDcpStateV2

/**
 * Full runtime state for the DCP extension.
 */
export interface DcpState {
  // ── Tool tracking ──────────────────────────────────────────────────────────
  /** toolCallId → ToolRecord, populated when a tool_result event fires */
  toolCalls: Map<string, ToolRecord>
  /** Set of toolCallIds whose result messages should be suppressed in context */
  prunedToolIds: Set<string>

  // ── Compression ────────────────────────────────────────────────────────────
  /** Highest persisted schema version currently loaded into runtime state */
  schemaVersion: 1 | 2
  /** Legacy v1 timestamp-based compression blocks (active runtime path today) */
  compressionBlocks: CompressionBlock[]
  /** Draft v2 span-key blocks loaded or preserved during migration work */
  compressionBlocksV2: CompressionBlockV2[]
  /** Monotonically increasing counter used to assign compression block IDs */
  nextBlockId: number
  /** Latest rendered visible transcript returned from the `context` hook. */
  lastRenderedMessages: DcpMessage[]
  /** Canonical owner keys live in the latest materialized transcript. */
  lastLiveOwnerKeys: string[]

  // ── Message ID snapshot ────────────────────────────────────────────────────
  /** Persisted source-key → visible-ref aliases for model-facing compression refs. */
  messageAliases: MessageAliasState
  /** Latest visible-ref snapshot with canonical source, timestamp, and owner metadata. */
  messageRefSnapshot: Map<string, MessageRefSnapshotEntry>
  /** Compatibility map from visible message refs to timestamps for legacy code paths. */
  messageIdSnapshot: Map<string, number>
  /** Latest visible-ref → internal owner-key mapping for provider payload filtering. */
  messageOwnerSnapshot: Map<string, string>

  // ── Turn tracking ──────────────────────────────────────────────────────────
  /**
   * Monotonic logical-turn counter for the current context snapshot.
   *
   * A standalone visible message counts as one turn. An assistant tool-call
   * message plus its matching `toolResult` / `bashExecution` batch counts as a
   * single turn.
   */
  currentTurn: number

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Current estimated net tokens saved by active compression blocks */
  tokensSaved: number
  /** Number of discrete pruning operations performed */
  totalPruneCount: number

  // ── Mode ───────────────────────────────────────────────────────────────────
  /**
   * When true, the extension will not autonomously emit compress nudges.
   * Automatic deduplication/error-purge strategies may still run depending on
   * the `manualMode.automaticStrategies` config flag.
   */
  manualMode: boolean

  // ── Nudge state ────────────────────────────────────────────────────────────
  /**
   * The value of `currentTurn` at the time the last nudge was emitted.
   * Used to debounce nudges by logical turns rather than raw context passes.
   */
  lastNudgeTurn: number
  /**
   * The value of `currentTurn` at the time the last successful `compress`
   * transaction completed.
   *
   * Used to suppress further nudges until at least one newer logical turn
   * exists.
   */
  lastCompressTurn: number
}

