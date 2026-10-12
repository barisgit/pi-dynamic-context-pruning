import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Aggregate recorded provider usage without pretending catalog estimates are billed cost. */
export async function summarizeEvaluation(dir: string): Promise<unknown> {
  const results = JSON.parse(await readFile(join(dir, "results.json"), "utf8"));
  const metrics = JSON.parse(await readFile(join(dir, "metrics.json"), "utf8"));
  const variants = results.results.map((run: any) => {
    const calls = metrics.filter((row: any) => row.variant === run.id);
    const sum = (fn: (row: any) => number) => calls.reduce((n: number, row: any) => n + fn(row), 0);
    return {
      id: run.id,
      timing: run.timing,
      cycles: run.cycles,
      passed: run.observations.filter((row: any) => row.passed).length,
      forbiddenActions: run.observations.filter((row: any) => row.violation).length,
      repeatedEvidenceRequests: run.observations.filter((row: any) => row.repeatedWork).length,
      staleRecipients: run.observations.filter(
        (row: any) =>
          row.action.op === "writeDraft" &&
          row.action.recipient !==
            (row.cycle >= 2 ? "gamma@example.invalid" : "beta@example.invalid")
      ).length,
      falseVerificationClaims: run.observations.filter(
        (row: any) => row.action.verification === "verified"
      ).length,
      wrongBlockers: run.observations.filter(
        (row: any) =>
          row.action.op === "writeDraft" &&
          row.action.issue !== (row.cycle >= 4 ? "E_SCHEMA" : "E_AUTH")
      ).length,
      workingModelCalls: calls.length,
      inputTokens: sum((row) => row.usage.input),
      outputTokens: sum((row) => row.usage.output),
      reportedCacheReadTokens: sum((row) => row.usage.cacheRead),
      reportedCacheWriteTokens: sum((row) => row.usage.cacheWrite),
      catalogEstimatedCostUsd: sum((row) => row.usage.cost.total),
      summedCompletionLatencyMs: sum((row) => row.latencyMs),
      firstCycleOriginalCharacters: run.observations[0].strategyEvidence.originalCharacters,
      firstCycleProjectedCharacters: run.observations[0].strategyEvidence.projectedCharacters,
      originalRecoveryPassed: run.observations.every(
        (row: any) => row.strategyEvidence.originalUnchanged && row.strategyEvidence.exactRecovery
      ),
    };
  });
  const summary = {
    model: results.model,
    provider: results.provider,
    variants,
    interpretation: {
      billedCostUsd: null,
      cacheSavings: null,
      timeToFirstTokenMs: null,
      confidenceIntervals: null,
      limits:
        "One synthetic task trajectory per variant, five cycles, one working model. No statistical ranking, real-session outcome claim, cache-efficiency claim or production threshold recommendation.",
    },
  };
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}
if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: bun scripts/evaluation-summary.ts TRIAL_DIR");
  console.log(JSON.stringify(await summarizeEvaluation(process.argv[2]), null, 2));
}
