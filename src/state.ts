import { createMessageAliasState } from "./message-refs.js"
import { createEmptyCompressionBlockMetadata } from "./domain/compression/metadata.js"
import type { DcpState } from "./types/state.js"

export type {
  CompressionBlock,
  CompressionBlockMetadata,
  CompressionBlockStatus,
  CompressionBlockV2,
  CompressionCommandStat,
  CompressionFileReadStat,
  CompressionFileWriteStat,
  CompressionLogEntry,
  DcpState,
  PersistedDcpState,
  PersistedDcpStateV1,
  PersistedDcpStateV2,
  ToolRecord,
} from "./types/state.js"

export { createEmptyCompressionBlockMetadata } from "./domain/compression/metadata.js"

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
    lastRenderedMessages: [],
    lastLiveOwnerKeys: [],
    messageAliases: createMessageAliasState(),
    messageRefSnapshot: new Map(),
    messageIdSnapshot: new Map(),
    messageOwnerSnapshot: new Map(),
    currentTurn: 0,
    tokensSaved: 0,
    totalPruneCount: 0,
    manualMode: false,
    lastNudgeTurn: -1,
    lastCompressTurn: -1,
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
  state.lastRenderedMessages = []
  state.lastLiveOwnerKeys = []
  state.messageAliases = createMessageAliasState()
  state.messageRefSnapshot.clear()
  state.messageIdSnapshot.clear()
  state.messageOwnerSnapshot.clear()
  state.currentTurn = 0
  state.tokensSaved = 0
  state.totalPruneCount = 0
  state.manualMode = false
  state.lastNudgeTurn = -1
  state.lastCompressTurn = -1
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
