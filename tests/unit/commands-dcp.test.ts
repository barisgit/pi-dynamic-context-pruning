import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { registerCommands } from "../../src/application/commands/dcp.js";
import { makeConfig, makeState } from "../helpers/dcp-test-utils.js";

// ---------------------------------------------------------------------------
// VAL-LEGACY-COMMANDS-AND-MANUAL-MODE-REMOVED verifier
//
// The dcp-replay-v3 charter removes the unused `decompress`, `sweep`, and
// `manual` subcommands along with all `manualMode` state/config plumbing.
// These tests confirm the removals at the surface (registered command schema +
// runtime handler) and pin the production source so manualMode cannot quietly
// reappear without updating this test.
// ---------------------------------------------------------------------------

describe("VAL: legacy commands and manualMode removed", () => {
  test("/dcp registers only context/stats/compress/compact/help completions", () => {
    const state = makeState();
    const config = makeConfig();

    let registered: any = null;
    const piMock = {
      registerCommand: (_name: string, def: any) => {
        registered = def;
      },
    } as any;

    registerCommands(piMock, state, config);

    expect(registered).not.toBeNull();
    const items = registered.getArgumentCompletions("") ?? [];
    const values = items.map((it: any) => it.value).sort();
    expect(values).toEqual(["compact", "compress", "context", "help", "stats"]);
  });

  test("unknown removed subcommands fall through to error notify", async () => {
    const state = makeState();
    const config = makeConfig();

    let registered: any = null;
    const piMock = {
      registerCommand: (_name: string, def: any) => {
        registered = def;
      },
    } as any;
    registerCommands(piMock, state, config);

    const calls: Array<{ msg: string; level: string }> = [];
    const ctx = {
      ui: {
        notify: (msg: string, level: string) => {
          calls.push({ msg, level });
        },
      },
    } as any;

    for (const sub of ["decompress", "sweep", "manual"]) {
      calls.length = 0;
      await registered.handler(sub, ctx);
      expect(calls.length).toBe(1);
      expect(calls[0].level).toBe("error");
      expect(calls[0].msg).toContain("Unknown DCP command");
    }
  });

  test("production source has no manualMode / removed handler references", () => {
    const files = [
      "src/application/commands/dcp.ts",
      "src/application/context-handler.ts",
      "src/application/session-handler.ts",
      "src/application/system-prompt-handler.ts",
      "src/application/status.ts",
      "src/domain/pruning/index.ts",
      "src/infrastructure/config.ts",
      "src/prompts/index.ts",
      "src/prompts/system.ts",
      "src/state.ts",
      "src/types/config.ts",
      "src/types/state.ts",
      "src/index.ts",
    ];
    const offenders: string[] = [];
    for (const rel of files) {
      const path = join(process.cwd(), rel);
      const text = readFileSync(path, "utf8");
      // Allow inline comments that document the removal.
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/handleDecompress|handleSweep|handleManual|MANUAL_MODE_SYSTEM_PROMPT/.test(line)) {
          offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        }
        if (/\bmanualMode\b/.test(line)) {
          offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        }
        if (/"manual_mode"/.test(line)) {
          offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
