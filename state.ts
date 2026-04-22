// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
   * Zero-based index of the user turn during which this tool was called.
   * Incremented each time a user message is encountered in the context stream.
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
   * Timestamp of the first message *after* the range — the summary is injected
   * immediately before this message.  Set to `Infinity` when the range extends
   * to the end of the conversation.
   */
  anchorTimestamp: number
  /** Whether this block is still being applied (false = soft-deleted) */
  active: boolean
  /** Token estimate for the summary text itself */
  summaryTokenEstimate: number
  /** Wall-clock time the block was created (Date.now()) */
  createdAt: number
}

/** Status for a v2 span-key compression block. */
export type CompressionBlockStatus = "active" | "superseded" | "decompressed"

/**
 * Draft v2 compression block.
 *
 * v2 uses canonical span keys instead of raw timestamps and explicitly records
 * superseded prior blocks. Phase 1 only introduces the type and persistence
 * scaffolding — the active runtime still materializes legacy v1 blocks.
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
  /** Active prior blocks fully consumed by this block */
  supersedesBlockIds: number[]
  /** Lifecycle status of this block */
  status: CompressionBlockStatus
  /** Token estimate for the summary text itself */
  summaryTokenEstimate: number
  /** Wall-clock time the block was created (Date.now()) */
  createdAt: number
}

/** Persisted v1 DCP state stored in session history. */
export interface PersistedDcpStateV1 {
  schemaVersion?: 1
  compressionBlocks: CompressionBlock[]
  nextBlockId: number
  prunedToolIds: string[]
  tokensSaved: number
  totalPruneCount: number
  manualMode: boolean
}

/** Persisted v2 DCP state stored in session history. */
export interface PersistedDcpStateV2 {
  schemaVersion: 2
  blocks: CompressionBlockV2[]
  nextBlockId: number
  manualMode: boolean
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

  // ── Message ID snapshot ────────────────────────────────────────────────────
  /**
   * Maps the short LLM-visible message IDs (e.g. "m001") to the actual
   * `timestamp` of that message as seen in the last `context` event.
   *
   * The `compress` tool receives ID strings from the LLM; this map lets us
   * translate them back to real timestamps so compression blocks can reference
   * message positions by timestamp (which is stable across pruning passes).
   */
  messageIdSnapshot: Map<string, number>

  // ── Turn tracking ──────────────────────────────────────────────────────────
  /**
   * Zero-based index of the current user turn.
   * Incremented each time a user message is encountered while processing the
   * context array in the `context` event handler.
   */
  currentTurn: number

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Running total of tokens estimated to have been saved by pruning/compression */
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
   * How many `context` events have fired since the last compress nudge was
   * emitted.  Reset to 0 after each nudge.
   */
  nudgeCounter: number
  /**
   * The value of `currentTurn` at the time the last nudge was emitted.
   * Used to avoid nudging more than once per user turn when nudgeFrequency is
   * satisfied within the same turn.
   */
  lastNudgeTurn: number
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/** Create a fresh, zeroed DcpState instance. */
export function createState(): DcpState {
  return {
    toolCalls: new Map(),
    prunedToolIds: new Set(),
    schemaVersion: 1,
    compressionBlocks: [],
    compressionBlocksV2: [],
    nextBlockId: 1,
    messageIdSnapshot: new Map(),
    currentTurn: 0,
    tokensSaved: 0,
    totalPruneCount: 0,
    manualMode: false,
    nudgeCounter: 0,
    lastNudgeTurn: -1,
  }
}

/**
 * Reset `state` back to its initial values **in-place**.
 * Preserves the object reference so other modules holding a reference see the
 * reset immediately.
 */
export function resetState(state: DcpState): void {
  state.toolCalls.clear()
  state.prunedToolIds.clear()
  state.schemaVersion = 1
  state.compressionBlocks = []
  state.compressionBlocksV2 = []
  state.nextBlockId = 1
  state.messageIdSnapshot.clear()
  state.currentTurn = 0
  state.tokensSaved = 0
  state.totalPruneCount = 0
  state.manualMode = false
  state.nudgeCounter = 0
  state.lastNudgeTurn = -1
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Recursively sort the keys of a plain object so that two argument objects
 * with the same entries in different key-insertion order produce the same JSON.
 */
function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys)
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortObjectKeys(obj[key])
    }
    return sorted
  }
  return value
}

/**
 * Create a stable deduplication fingerprint for a tool call.
 *
 * Two calls with the same `toolName` and semantically identical `args`
 * (regardless of key ordering) will produce the same fingerprint.
 *
 * Format: `<toolName>::<JSON of recursively key-sorted args>`
 */
export function createInputFingerprint(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const sorted = sortObjectKeys(args)
  return `${toolName}::${JSON.stringify(sorted)}`
}
