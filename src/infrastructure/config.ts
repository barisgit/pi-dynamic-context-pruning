import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { DcpConfig } from "../types/config.js";

export type { DcpConfig } from "../types/config.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DcpConfig = {
  enabled: true,
  debug: false,
  compress: {
    maxContextPercent: 0.9,
    minContextPercent: 0.75,
    nudgeDebounceTurns: 2,
    nudgeFrequency: 8,
    iterationNudgeThreshold: 15,
    protectRecentTurns: 4,
    renderFullBlockCount: 4,
    renderCompactBlockCount: 8,
    nudgeForce: "soft",
    protectedTools: ["compress", "write", "edit"],
    protectUserMessages: false,
  },
  nativeCompaction: {
    enabled: true,
    autoTriggerMessageCount: 1000,
    autoTriggerForceMessageCount: 2000,
    minActiveBlockCount: 3,
    minHiddenCoverageRatio: 0.6,
    maxPreviousSummaryTokens: 4000,
    maxSummaryTokens: 20000,
  },
  strategies: {
    pruneCadenceTurns: 1,
    minPruneItemSavedTokens: 25,
    minPruneBatchSavedTokens: 100,
    deduplication: {
      enabled: true,
      protectedTools: [],
    },
    purgeErrors: {
      enabled: true,
      turns: 4,
      protectedTools: [],
    },
    customStrategies: {
      enabled: true,
      defaults: { minResultTokens: 300, minAgeTurns: 10 },
      rules: [{ tools: ["read", "bash", "grep"], action: "clear" }],
    },
  },
  protectedFilePatterns: [],
  pruneNotification: "detailed",
};

const DEFAULT_CONFIG_FILE_CONTENT = `{
  // Dynamic Context Pruning (DCP) configuration
  // Full schema reference: https://github.com/your-org/pi-dynamic-context-pruning
  //
  // "$schema": "...",
  //
  // Uncomment and edit properties you want to override:
  //
  // "enabled": true,
  // "debug": false, // best-effort JSONL log at ~/.pi/log/dcp.jsonl
  // "compress": {
  //   "maxContextPercent": 0.9,
  //   "minContextPercent": 0.75,
  //   // Optional absolute-token thresholds. These are ORed with percent thresholds.
  //   // Useful for large context windows that degrade before they are nearly full.
  //   // "maxContextTokens": 200000,
  //   // "minContextTokens": 150000,
  //   "nudgeDebounceTurns": 2,
  //   "nudgeFrequency": 8,
  //   "iterationNudgeThreshold": 15,
  //   "protectRecentTurns": 4,
  //   "renderFullBlockCount": 4,
  //   "renderCompactBlockCount": 8,
  //   "nudgeForce": "soft",
  //   "protectedTools": ["compress", "write", "edit"],
  //   "protectUserMessages": false
  // },
  // "nativeCompaction": {
  //   // When enabled, normal DCP compression can immediately request pi-native
  //   // compaction once the active branch has this many renderable messages.
  //   "enabled": true,
  //   "autoTriggerMessageCount": 1000,
  //   "autoTriggerForceMessageCount": 2000,
  //   "minActiveBlockCount": 3,
  //   "minHiddenCoverageRatio": 0.6,
  //   "maxPreviousSummaryTokens": 4000,
  //   "maxSummaryTokens": 20000
  // },
  // "strategies": {
  //   // Batch tombstone additions onto bucketed turn boundaries to reduce
  //   // prefix-cache invalidations. 1 = current per-turn behavior; values like
  //   // 5 or 10 group additions so a cache break happens at most every N turns.
  //   "pruneCadenceTurns": 1,
  //   // Minimum net tokens saved before a dedup/error tombstone is allowed to
  //   // break the prefix cache. Per-item skips tiny outputs; batch refuses to
  //   // rewrite old context unless the whole flush clears the bar. 0 = off;
  //   // shipped defaults 25 / 100 drop net-negative and trivial tombstones.
  //   // Both gates are bypassed when effective context enters the red zone
  //   // (compress.maxContextPercent / maxContextTokens).
  //   "minPruneItemSavedTokens": 25,
  //   "minPruneBatchSavedTokens": 100,
  //   "deduplication": { "enabled": true, "protectedTools": [] },
  //   "purgeErrors": { "enabled": true, "turns": 4, "protectedTools": [] },
  //   // Ordered safety allowlist for old large successful results. Runs every
  //   // cadence (not pressure-gated), governed by minAgeTurns, protected recent
  //   // tail, cadence, and per-item/batch savings gates. rules REPLACES across
  //   // config layers; tools and string args match case-insensitive * globs.
  //   "customStrategies": {
  //     "enabled": true,
  //     "defaults": { "minResultTokens": 300, "minAgeTurns": 10 },
  //     "rules": [
  //       { "tools": ["read", "bash", "grep"], "action": "clear" }
  //     ]
  //   }
  // },
  // "protectedFilePatterns": [],
  // "pruneNotification": "detailed"
}
`;

const PREFERRED_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "dcp.jsonc");
const LEGACY_GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".config", "pi", "dcp.jsonc");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Array config keys that REPLACE rather than union-merge on override.
 *
 * Most arrays (e.g. `protectedTools`, `protectedFilePatterns`) are protect-lists
 * where union is safe: a later layer can only ADD protection. custom strategy
 * `rules` are the opposite — a safety allowlist of outputs that may be cleared
 * or reduced — so a user/project layer must be able to NARROW it (the
 * conservative direction). Union-merging it would make narrowing impossible
 * (defaults would always leak back in), so it replaces instead.
 */
const REPLACE_MERGE_ARRAY_KEYS = new Set(["rules"]);

/**
 * Recursively merge `override` into `base`. Arrays are union-merged (deduped)
 * except for keys in `REPLACE_MERGE_ARRAY_KEYS`, which replace wholesale.
 * Returns a new object; does not mutate inputs.
 */
export function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override === null || override === undefined) return base;
  if (typeof base !== "object" || typeof override !== "object") {
    return override as T;
  }

  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const key of Object.keys(override as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown>)[key];
    const overVal = (override as Record<string, unknown>)[key];

    if (Array.isArray(baseVal) && Array.isArray(overVal)) {
      if (REPLACE_MERGE_ARRAY_KEYS.has(key)) {
        // Replace wholesale so a later layer can narrow a safety allowlist.
        result[key] = [...overVal];
      } else {
        // Union merge: combine and deduplicate by value
        const combined = [...baseVal, ...overVal];
        result[key] = [...new Set(combined)];
      }
    } else if (
      overVal !== null &&
      typeof overVal === "object" &&
      !Array.isArray(overVal) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>
      );
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }

  return result as T;
}

/**
 * Parse a JSONC file and return a plain object.
 * Returns `{}` on any error (missing file, parse error).
 */
function readJsoncFile(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors);
  if (errors.length > 0) {
    // Non-fatal: return whatever was parsed (jsonc-parser is lenient)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/**
 * Ensure a config file exists, creating it with defaults if missing.
 */
function ensureConfigFile(filePath: string): void {
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, DEFAULT_CONFIG_FILE_CONTENT, "utf8");
    }
  } catch {
    // Best-effort; do not crash if we cannot write
  }
}

/**
 * Resolve the global user config path.
 *
 * Prefer pi's agent-local convention. Keep the historical XDG-style path as a
 * read-only fallback; if neither exists, create the preferred file.
 */
function resolveGlobalConfigPath(): string {
  if (fs.existsSync(PREFERRED_GLOBAL_CONFIG_PATH)) return PREFERRED_GLOBAL_CONFIG_PATH;
  if (fs.existsSync(LEGACY_GLOBAL_CONFIG_PATH)) return LEGACY_GLOBAL_CONFIG_PATH;
  ensureConfigFile(PREFERRED_GLOBAL_CONFIG_PATH);
  return PREFERRED_GLOBAL_CONFIG_PATH;
}

/**
 * Walk up from `startDir` looking for `.pi/dcp.jsonc`.
 * Returns the path if found, otherwise null.
 */
function findProjectConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (true) {
    const candidate = path.join(dir, ".pi", "dcp.jsonc");
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function assertNonNegativeNumber(value: unknown, pathLabel: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid DCP config: ${pathLabel} must be a non-negative number`);
  }
}

function validateCustomStrategies(config: DcpConfig): void {
  const custom = config.strategies.customStrategies;
  if (!custom || typeof custom !== "object") {
    throw new Error("Invalid DCP config: strategies.customStrategies is required");
  }
  assertNonNegativeNumber(
    custom.defaults.minResultTokens,
    "strategies.customStrategies.defaults.minResultTokens"
  );
  assertNonNegativeNumber(
    custom.defaults.minAgeTurns,
    "strategies.customStrategies.defaults.minAgeTurns"
  );
  if (!Array.isArray(custom.rules)) {
    throw new Error("Invalid DCP config: strategies.customStrategies.rules must be an array");
  }

  custom.rules.forEach((rule, index) => {
    const label = `strategies.customStrategies.rules[${index}]`;
    if (!Array.isArray(rule.tools) || rule.tools.length === 0) {
      throw new Error(`Invalid DCP config: ${label}.tools must be a non-empty array`);
    }
    for (const [toolIndex, pattern] of rule.tools.entries()) {
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error(
          `Invalid DCP config: ${label}.tools[${toolIndex}] must be a non-empty string`
        );
      }
    }
    if (rule.action !== "clear" && rule.action !== "reduce") {
      throw new Error(`Invalid DCP config: ${label}.action must be "clear" or "reduce"`);
    }
    if (rule.args !== undefined) {
      if (rule.args === null || typeof rule.args !== "object" || Array.isArray(rule.args)) {
        throw new Error(`Invalid DCP config: ${label}.args must be an object`);
      }
      for (const [field, patterns] of Object.entries(rule.args)) {
        if (field.length === 0) {
          throw new Error(`Invalid DCP config: ${label}.args field names must be non-empty`);
        }
        const list = Array.isArray(patterns) ? patterns : [patterns];
        if (
          list.length === 0 ||
          list.some((pattern) => typeof pattern !== "string" || pattern.length === 0)
        ) {
          throw new Error(
            `Invalid DCP config: ${label}.args.${field} must be a non-empty string or string array`
          );
        }
      }
    }
    if (rule.minResultTokens !== undefined) {
      assertNonNegativeNumber(rule.minResultTokens, `${label}.minResultTokens`);
    }
    if (rule.minAgeTurns !== undefined) {
      assertNonNegativeNumber(rule.minAgeTurns, `${label}.minAgeTurns`);
    }
    if (rule.action === "reduce") {
      if (!rule.keep || typeof rule.keep !== "object") {
        throw new Error(`Invalid DCP config: ${label}.keep is required for reduce`);
      }
      const head = rule.keep.headLines ?? 0;
      const tail = rule.keep.tailLines ?? 0;
      assertNonNegativeNumber(head, `${label}.keep.headLines`);
      assertNonNegativeNumber(tail, `${label}.keep.tailLines`);
      if (Math.floor(head) <= 0 && Math.floor(tail) <= 0) {
        throw new Error(`Invalid DCP config: ${label}.keep must keep at least one line`);
      }
    }
  });
}

function validateConfig(config: DcpConfig): void {
  validateCustomStrategies(config);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the DCP configuration by merging (in order):
 *  1. Built-in defaults
 *  2. ~/.pi/agent/dcp.jsonc, falling back to ~/.config/pi/dcp.jsonc if only the legacy file exists
 *  3. $PI_CONFIG_DIR/dcp.jsonc  (if env var is set)
 *  4. <project>/.pi/dcp.jsonc  (walked up from projectDir)
 */
export function loadConfig(projectDir: string): DcpConfig {
  // Layer 1: defaults (deep clone so we never mutate the constant)
  let config: DcpConfig = deepMerge(DEFAULT_CONFIG, {});

  // Layer 2: global config
  const globalRaw = readJsoncFile(resolveGlobalConfigPath());
  if (Object.keys(globalRaw).length > 0) {
    config = deepMerge(config, globalRaw as Partial<DcpConfig>);
  }

  // Layer 3: $PI_CONFIG_DIR/dcp.jsonc
  const piConfigDir = process.env["PI_CONFIG_DIR"];
  if (piConfigDir) {
    const envConfigPath = path.join(piConfigDir, "dcp.jsonc");
    const envRaw = readJsoncFile(envConfigPath);
    if (Object.keys(envRaw).length > 0) {
      config = deepMerge(config, envRaw as Partial<DcpConfig>);
    }
  }

  // Layer 4: project-local config (walk up from projectDir)
  const projectConfigPath = findProjectConfig(projectDir);
  if (projectConfigPath) {
    const projectRaw = readJsoncFile(projectConfigPath);
    if (Object.keys(projectRaw).length > 0) {
      config = deepMerge(config, projectRaw as Partial<DcpConfig>);
    }
  }

  validateConfig(config);
  return config;
}
