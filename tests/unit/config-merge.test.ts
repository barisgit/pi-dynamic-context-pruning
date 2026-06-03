import { describe, expect, test } from "bun:test";
import { deepMerge as deepMergeTyped } from "../../src/infrastructure/config.js";

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

  test("clearTools replaces wholesale so a layer can NARROW the safety allowlist", () => {
    const merged = deepMerge(
      { strategies: { clearStaleResults: { clearTools: ["Read", "Bash", "Grep"] } } },
      { strategies: { clearStaleResults: { clearTools: ["Read"] } } }
    );
    // Union would have leaked Bash/Grep back in; replace keeps only the override.
    expect(merged.strategies.clearStaleResults.clearTools).toEqual(["Read"]);
  });

  test("clearTools absent in override keeps the base allowlist", () => {
    const merged = deepMerge(
      { strategies: { clearStaleResults: { enabled: false, clearTools: ["Read", "Bash"] } } },
      { strategies: { clearStaleResults: { enabled: true } } }
    );
    expect(merged.strategies.clearStaleResults.enabled).toBe(true);
    expect(merged.strategies.clearStaleResults.clearTools).toEqual(["Read", "Bash"]);
  });

  test("clearTools can widen too (override fully controls the list)", () => {
    const merged = deepMerge(
      { strategies: { clearStaleResults: { clearTools: ["Read"] } } },
      { strategies: { clearStaleResults: { clearTools: ["Read", "Bash", "Grep", "read"] } } }
    );
    expect(merged.strategies.clearStaleResults.clearTools).toEqual([
      "Read",
      "Bash",
      "Grep",
      "read",
    ]);
  });
});
