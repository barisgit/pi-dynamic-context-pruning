import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { deepMerge as deepMergeTyped, type loadConfig } from "../../src/infrastructure/config.js";

// These tests exercise structural array-merge semantics, not full DcpConfig
// shapes, so use a loosely-typed alias (deepMerge's `Partial<T>` is shallow and
// would otherwise force complete nested objects in each literal).
const deepMerge = deepMergeTyped as (base: any, override: any) => any;

describe("deepMerge array semantics", () => {
  test("protect-list arrays union-merge (later layer can only add)", () => {
    const merged = deepMerge(
      { strategies: { deduplication: { protectedTools: ["compress", "write"] } } },
      { strategies: { deduplication: { protectedTools: ["edit"] } } }
    );
    expect(merged.strategies.deduplication.protectedTools.sort()).toEqual([
      "compress",
      "edit",
      "write",
    ]);
  });

  test("custom strategy rules replace wholesale so a layer can NARROW the safety allowlist", () => {
    const merged = deepMerge(
      {
        strategies: {
          customStrategies: { rules: [{ tools: ["Read", "Bash", "Grep"], action: "clear" }] },
        },
      },
      { strategies: { customStrategies: { rules: [{ tools: ["Read"], action: "clear" }] } } }
    );
    // Union would have leaked Bash/Grep back in; replace keeps only the override.
    expect(merged.strategies.customStrategies.rules).toEqual([
      { tools: ["Read"], action: "clear" },
    ]);
  });

  test("custom strategy rules absent in override keeps the base allowlist", () => {
    const merged = deepMerge(
      {
        strategies: {
          customStrategies: {
            enabled: false,
            rules: [{ tools: ["Read", "Bash"], action: "clear" }],
          },
        },
      },
      { strategies: { customStrategies: { enabled: true } } }
    );
    expect(merged.strategies.customStrategies.enabled).toBe(true);
    expect(merged.strategies.customStrategies.rules).toEqual([
      { tools: ["Read", "Bash"], action: "clear" },
    ]);
  });

  test("custom strategy rules can widen too (override fully controls the list)", () => {
    const merged = deepMerge(
      { strategies: { customStrategies: { rules: [{ tools: ["Read"], action: "clear" }] } } },
      {
        strategies: {
          customStrategies: {
            rules: [{ tools: ["Read", "Bash", "Grep", "read"], action: "clear" }],
          },
        },
      }
    );
    expect(merged.strategies.customStrategies.rules).toEqual([
      { tools: ["Read", "Bash", "Grep", "read"], action: "clear" },
    ]);
  });
});

describe("candidate config and deprecated compatibility", () => {
  function withConfig(
    snippet: object,
    check: (config: ReturnType<typeof loadConfig>) => void
  ): void {
    const dir = mkdtempSync(join(tmpdir(), "dcp-config-test-"));
    try {
      writeFileSync(join(dir, "dcp.jsonc"), JSON.stringify(snippet), "utf8");
      // Isolate all config layers without touching the user's global config.
      const result = spawnSync(
        process.execPath,
        [
          "--eval",
          `import { loadConfig } from ${JSON.stringify(new URL("../../src/infrastructure/config.ts", import.meta.url).pathname)}; console.log(JSON.stringify(loadConfig(${JSON.stringify(dir)})));`,
        ],
        { env: { ...process.env, HOME: dir, PI_CONFIG_DIR: dir }, encoding: "utf8" }
      );
      if (result.status !== 0) throw new Error(result.stderr);
      check(JSON.parse(result.stdout));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("ships shared candidates and savings gates, not retired collector defaults", () => {
    withConfig({}, (config) => {
      expect(config.strategies.candidates).toEqual({
        minAgeTurns: 15,
        minResultTokens: 300,
        protectedTools: [],
      });
      // Deployment overrides (100/10000) are not package defaults.
      expect(config.strategies.minPruneItemSavedTokens).toBe(25);
      expect(config.strategies.minPruneBatchSavedTokens).toBe(100);
      expect(config.strategies.purgeErrors).toBeUndefined();
      expect(config.strategies.customStrategies).toBeUndefined();
    });
  });

  test("ignores unknown deprecated actions", () => {
    withConfig(
      {
        strategies: {
          customStrategies: { enabled: true, rules: [{ tools: ["read"], action: "drop" }] },
        },
      },
      (config) => expect(config.strategies.candidates.minAgeTurns).toBe(15)
    );
  });

  test("ignores deprecated reduce rules without keep", () => {
    withConfig(
      { strategies: { customStrategies: { rules: [{ tools: ["read"], action: "reduce" }] } } },
      (config) => expect(config.strategies.candidates.minResultTokens).toBe(300)
    );
  });

  test("ignores empty deprecated tools and negative deprecated age", () => {
    withConfig(
      {
        strategies: {
          customStrategies: {
            defaults: { minAgeTurns: -1 },
            rules: [{ tools: [], action: "clear" }],
          },
        },
      },
      (config) => expect(config.strategies.candidates.minAgeTurns).toBe(15)
    );
  });

  test("validates shared age, size and protection", () => {
    for (const candidates of [
      { minAgeTurns: -1 },
      { minResultTokens: -1 },
      { protectedTools: [123] },
      null,
    ]) {
      expect(() => withConfig({ strategies: { candidates } }, () => {})).toThrow(
        "strategies.candidates"
      );
    }
  });

  test("merges shared protection lists without losing defaults", () => {
    withConfig({ strategies: { candidates: { protectedTools: ["read"] } } }, (config) => {
      expect(config.strategies.candidates).toEqual({
        minAgeTurns: 15,
        minResultTokens: 300,
        protectedTools: ["read"],
      });
    });
  });
});
