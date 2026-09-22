import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface JevLedgerRecord {
  version: 1;
  [key: string]: unknown;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const appendQueues = new Map<string, Promise<void>>();

function ledgerPath(agentDir: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      "Invalid Jev session ID: expected 1-128 alphanumeric, dash, or underscore characters"
    );
  }
  return join(agentDir, "dcp", "jev", `${sessionId}.jsonl`);
}

function isLedgerRecord(value: unknown): value is JevLedgerRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1
  );
}

/** Read valid version-1 records without creating or modifying the ledger directory. */
export async function readJevLedger(
  agentDir: string,
  sessionId: string
): Promise<JevLedgerRecord[]> {
  const path = ledgerPath(agentDir, sessionId);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const records: JevLedgerRecord[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLedgerRecord(parsed)) records.push(parsed);
    } catch {
      // A partial final write or corrupt line does not hide later valid records.
    }
  }
  return records;
}

async function needsLeadingNewline(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size === 0) return false;
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, size - 1);
    return buffer[0] !== 0x0a;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function appendRecord(path: string, record: JevLedgerRecord): Promise<void> {
  if (!isLedgerRecord(record)) throw new Error("Jev ledger records must use version 1");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const prefix = (await needsLeadingNewline(path)) ? "\n" : "";
  const handle = await open(path, "a", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${prefix}${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Append one record durably, serializing in-process writers for the same session. */
export async function appendJevLedger(
  agentDir: string,
  sessionId: string,
  record: JevLedgerRecord
): Promise<void> {
  const path = ledgerPath(agentDir, sessionId);
  const previous = appendQueues.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => appendRecord(path, record));
  appendQueues.set(path, pending);
  try {
    await pending;
  } finally {
    if (appendQueues.get(path) === pending) appendQueues.delete(path);
  }
}
