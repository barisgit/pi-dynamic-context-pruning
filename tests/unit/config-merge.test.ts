import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepMerge as deepMergeTyped, loadConfig } from "../../src/infrastructure/config.js";

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

describe("custom strategy config validation", () => {
  function expectInvalidConfig(snippet: string, expected: string): void {
    const dir = mkdtempSync(join(tmpdir(), "dcp-config-test-"));
    const previous = process.env["PI_CONFIG_DIR"];
    try {
      writeFileSync(join(dir, "dcp.jsonc"), snippet, "utf8");
      process.env["PI_CONFIG_DIR"] = dir;
      expect(() => loadConfig(dir)).toThrow(expected);
    } finally {
      if (previous === undefined) {
        delete process.env["PI_CONFIG_DIR"];
      } else {
        process.env["PI_CONFIG_DIR"] = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("rejects unknown custom strategy actions", () => {
    expectInvalidConfig(
      `{ "strategies": { "customStrategies": { "rules": [{ "tools": ["read"], "action": "drop" }] } } } }`,
      "action must be"
    );
  });

  test("rejects reduce rules without keep", () => {
    expectInvalidConfig(
      `{ "strategies": { "customStrategies": { "rules": [{ "tools": ["read"], "action": "reduce" }] } } } }`,
      "keep is required"
    );
  });

  test("rejects empty tools and negative numbers", () => {
    expectInvalidConfig(
      `{ "strategies": { "customStrategies": { "rules": [{ "tools": [], "action": "clear" }] } } } }`,
      "tools must be a non-empty array"
    );
    expectInvalidConfig(
      `{ "strategies": { "customStrategies": { "defaults": { "minAgeTurns": -1 }, "rules": [] } } } }`,
      "minAgeTurns"
    );
  });
});
