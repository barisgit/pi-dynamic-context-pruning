// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — configuration types
// ---------------------------------------------------------------------------

export interface DcpConfig {
  enabled: boolean;
  debug: boolean;
  manualMode: {
    enabled: boolean;
    automaticStrategies: boolean; // run dedup/purge even in manual mode
  };
  compress: {
    maxContextPercent: number; // 0-1, e.g. 0.9 — above this, aggressive nudges / emergency override
    minContextPercent: number; // 0-1, e.g. 0.75 — below this, no nudges
    maxContextTokens?: number; // absolute-token emergency threshold; ORed with maxContextPercent when set
    minContextTokens?: number; // absolute-token nudge eligibility threshold; ORed with minContextPercent when set
    nudgeDebounceTurns: number; // minimum number of newer logical turns between nudges
    nudgeFrequency: number; // legacy context-pass cadence knob; retained for backward compatibility
    iterationNudgeThreshold: number; // nudge after N tool calls since last user msg (default: 15)
    protectRecentTurns: number; // protect the hot tail beginning at the Nth-most-recent logical turn/tool batch
    renderFullBlockCount: number; // newest N compressed blocks render in full detail
    renderCompactBlockCount: number; // next N older compressed blocks render in compact form; the rest become minimal
    nudgeForce: "strong" | "soft";
    protectedTools: string[]; // these tool outputs always protected from pruning
    protectUserMessages: boolean;
  };
  nativeCompaction: {
    enabled: boolean;
    autoTriggerMessageCount: number;
    autoTriggerForceMessageCount?: number;
    minActiveBlockCount: number;
    /**
     * Minimum fraction (0-1) of hidden branch messages (before firstKeptEntryId)
     * that must fall inside active DCP block ranges for DCP to override pi's
     * default LLM compactor. Below this, DCP returns undefined from
     * session_before_compact so pi falls back to its own LLM summary. The
     * fallback is still seeded with active DCP block summaries via
     * customInstructions.
     */
    minHiddenCoverageRatio: number;
    /** Cap for non-DCP residue carried from preparation.previousSummary. */
    maxPreviousSummaryTokens: number;
    /** Hard cap for the total DCP-rendered native compaction summary. */
    maxSummaryTokens: number;
  };
  strategies: {
    /**
     * Batch tombstone additions onto turn boundaries that are multiples of N.
     *
     * `prunedToolIds` is treated as a pure function of `floor(currentTurn / N) * N`,
     * so within a bucket no new tombstones appear and the rendered prefix stays
     * cache-stable. `1` (default) preserves current per-turn behavior.
     *
     * Stateless on purpose: nothing is persisted between sessions, so reloads
     * cannot trigger a spurious flush.
     */
    pruneCadenceTurns: number;
    deduplication: {
      enabled: boolean;
      protectedTools: string[];
    };
    purgeErrors: {
      enabled: boolean;
      turns: number; // prune error inputs after N logical turns (default: 4)
      protectedTools: string[];
    };
  };
  protectedFilePatterns: string[];
  pruneNotification: "off" | "minimal" | "detailed";
}
