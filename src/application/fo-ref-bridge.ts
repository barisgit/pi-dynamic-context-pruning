import type { FoRefBridgeV1 } from "../domain/pruning/fo-ref-adapter.ts";

/** Discover the optional fo projection bridge at use time, including after reload. */
export function getFoRefBridge(): FoRefBridgeV1 | undefined {
  const bridge = (globalThis as any)[Symbol.for("fo.exposed-ref-bridge.v1")];
  return bridge?.version === 1 &&
    typeof bridge.collect === "function" &&
    typeof bridge.project === "function"
    ? bridge
    : undefined;
}
