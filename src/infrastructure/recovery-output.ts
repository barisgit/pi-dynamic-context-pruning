import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Persist an overlong original verbatim, with owner-only filesystem permissions. */
export function saveRecoveryText(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "dcp-recovery-")), "original.txt");
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}
