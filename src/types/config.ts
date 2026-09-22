// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — configuration types
// ---------------------------------------------------------------------------

export interface DcpConfig {
  enabled: boolean;
  debug: boolean;
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
    renderCompactBlockCount: number; // next N older blocks retain whole summary only; older blocks are omitted
    nudgeForce: "strong" | "soft";
    protectedTools: string[]; // these tool outputs always protected from pruning
    protectUserMessages: boolean;
  };
  nativeCompaction: {
    enabled: boolean;
    autoTriggerMessageCount: number;
    autoTriggerForceMessageCount?: number;
    minActiveBlockCount: number;
    /** Minimum exact coverage at the actual cut for DCP replacement; lower coverage uses host summarization. */
    minHiddenCoverageRatio: number;
    /** Legacy compatibility knob; fresh handoff replaces recursive previous-summary carry. */
    maxPreviousSummaryTokens: number;
    /** Retained-memory budget: strip optional metadata, drop oldest whole records, then use host fallback. */
    maxSummaryTokens: number;
  };
  strategies: {
    /** Opt-in audit-only Jev judgments; never changes rendered context. */
    jev?: { enabled: boolean };
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
    /**
     * Minimum net tokens a single dedup tombstone must save before it is
     * allowed to break the prefix cache. `netSaved = toolResultTokens -
     * tombstoneTokens`. Candidates below this are kept fully rendered. `0`
     * disables the per-item gate (legacy behavior). Shipped default `25` drops
     * net-negative and trivially-small tombstones that bust cache for no gain.
     */
    minPruneItemSavedTokens: number;
    /**
     * Minimum aggregate net tokens an eligible tombstone *batch* must save
     * before any of it is committed in a given context pass. Mirrors
     * Anthropic's `clear_at_least`: don't rewrite old context unless the whole
     * flush is worth the single prefix-cache break. `0` disables the batch gate
     * (legacy behavior). Shipped default `100` holds trivial flushes until they
     * accumulate a worthwhile saving. Bypassed when the live effective context
     * is in the red zone (see `compress.maxContextPercent` /
     * `compress.maxContextTokens`).
     */
    minPruneBatchSavedTokens: number;
    /** Shared candidate eligibility for semantic review; not an omission certificate. */
    candidates: { minAgeTurns: number; minResultTokens: number; protectedTools: string[] };
    deduplication: {
      enabled: boolean;
      protectedTools: string[];
    };
    /** @deprecated Decoded for compatibility only; never collects removals. */
    purgeErrors?: {
      enabled: boolean;
      turns: number; // historical setting; ignored
      protectedTools: string[];
    };
    /** @deprecated Decoded for compatibility only; never collects removals. */
    customStrategies?: {
      enabled: boolean;
      defaults: CustomStrategyDefaults;
      /** Historical rules; ignored by the runtime. */
      rules: CustomStrategyRule[];
    };
  };
  protectedFilePatterns: string[];
  pruneNotification: "off" | "minimal" | "detailed";
}

/** @deprecated Historical configuration shape; no runtime policy. */
export interface CustomStrategyDefaults {
  /** Skip successful results smaller than this to avoid net-negative rewrites. */
  minResultTokens: number;
  /**
   * Minimum age in logical turns before a successful result may be rewritten;
   * measured as bucketedTurn(currentTurn) - record.turnIndex.
   */
  minAgeTurns: number;
}

export interface CustomStrategyKeep {
  headLines?: number;
  tailLines?: number;
}

/** @deprecated Historical configuration shape; no runtime policy. */
export interface CustomStrategyRule {
  /** Tool-name patterns; case-insensitive `*` globs, anchored after expansion. */
  tools: string[];
  /** Optional flat string-argument glob constraints. All listed fields must match. */
  args?: Record<string, string | string[]>;
  action: "clear" | "reduce";
  /** Required for reduce; at least one count must be greater than zero. */
  keep?: CustomStrategyKeep;
  minResultTokens?: number;
  minAgeTurns?: number;
}
