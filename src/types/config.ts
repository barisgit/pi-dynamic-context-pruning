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
  strategies: {
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
