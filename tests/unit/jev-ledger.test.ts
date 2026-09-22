import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJevLedger,
  readJevLedger,
  type JevLedgerRecord,
} from "../../src/infrastructure/jev-ledger.js";

const tempDirs: string[] = [];

async function makeAgentDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dcp-jev-ledger-"));
  tempDirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Jev ledger", () => {
  test.each(["", "../session", "a/b", "a.b", " space", "x".repeat(129)])(
    "rejects unsafe session ID %j",
    async (sessionId) => {
      const agentDir = await makeAgentDir();
      await expect(readJevLedger(agentDir, sessionId)).rejects.toThrow("Invalid Jev session ID");
      await expect(appendJevLedger(agentDir, sessionId, { version: 1 })).rejects.toThrow(
        "Invalid Jev session ID"
      );
    }
  );

  test("round-trips records across resume without creating on read", async () => {
    const agentDir = await makeAgentDir();
    expect(await readJevLedger(agentDir, "session_01-test")).toEqual([]);
    await expect(stat(join(agentDir, "dcp", "jev"))).rejects.toMatchObject({ code: "ENOENT" });

    const records: JevLedgerRecord[] = [
      { version: 1, candidateId: "a", decision: "keep" },
      { version: 1, candidateId: "b", decision: "drop", confidence: 0.93 },
    ];
    for (const record of records) await appendJevLedger(agentDir, "session_01-test", record);

    expect(await readJevLedger(agentDir, "session_01-test")).toEqual(records);
  });

  test("skips corrupt and truncated lines and separates the next append", async () => {
    const agentDir = await makeAgentDir();
    const ledgerDir = join(agentDir, "dcp", "jev");
    await mkdir(ledgerDir, { recursive: true });
    await writeFile(
      join(ledgerDir, "resume.jsonl"),
      '{"version":1,"candidateId":"valid"}\nnot-json\n{"version":1,"candidateId":"truncated"',
      "utf8"
    );

    await appendJevLedger(agentDir, "resume", { version: 1, candidateId: "after" });

    expect(await readJevLedger(agentDir, "resume")).toEqual([
      { version: 1, candidateId: "valid" },
      { version: 1, candidateId: "after" },
    ]);
  });

  test("creates owner-only ledger directory and file permissions", async () => {
    if (process.platform === "win32") return;
    const agentDir = await makeAgentDir();
    await appendJevLedger(agentDir, "permissions", { version: 1, decision: "unsure" });

    const directory = await stat(join(agentDir, "dcp", "jev"));
    const file = await stat(join(agentDir, "dcp", "jev", "permissions.jsonl"));
    expect(directory.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
  });

  test("serializes concurrent appends without losing records", async () => {
    const agentDir = await makeAgentDir();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        appendJevLedger(agentDir, "concurrent", { version: 1, index })
      )
    );

    const records = await readJevLedger(agentDir, "concurrent");
    expect(records).toHaveLength(40);
    expect(records.map((record) => record.index).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 40 }, (_, index) => index)
    );
  });

  test("rejects records with the wrong version", async () => {
    const agentDir = await makeAgentDir();
    await expect(
      appendJevLedger(agentDir, "session", { version: 2 } as unknown as JevLedgerRecord)
    ).rejects.toThrow("version 1");
  });
});
