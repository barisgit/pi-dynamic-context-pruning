import { createHash } from "node:crypto";
import { estimateTokens } from "../domain/tokens/estimate.js";

// Reserve at least 8K of Jev's 32K window for provider/tokenizer differences and response.
export const JEV_MAX_REQUEST_ESTIMATED_TOKENS = 24000;
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { DcpConfig } from "../types/config.js";
import type { DcpState } from "../types/state.js";
import type { DcpMessage } from "../types/message.js";
import type { FoRefBridgeV1 } from "../domain/pruning/fo-ref-adapter.js";
import {
  collectJevShadowCandidates,
  snapshotJevTaskContext,
} from "../domain/pruning/jev-candidates.js";
import {
  buildJevRequest,
  parseJevResponse,
  createPiOpenRouterJevRequest,
  type JevRequestFn,
} from "../infrastructure/jev-client.js";
import {
  readJevLedger,
  appendJevLedger,
  type JevLedgerRecord,
} from "../infrastructure/jev-ledger.js";

export interface JevShadowDependencies {
  request?: JevRequestFn;
  read?: typeof readJevLedger;
  append?: typeof appendJevLedger;
  agentDir?: string;
  timeoutMs?: number;
}

function safeUsage(usage: Record<string, unknown> | undefined): Record<string, number> | undefined {
  if (!usage) return undefined;
  return Object.fromEntries(
    ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"]
      .filter(
        (key) =>
          typeof usage[key] === "number" &&
          Number.isFinite(usage[key]) &&
          (usage[key] as number) >= 0
      )
      .map((key) => [key, usage[key] as number])
  );
}
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Audit-only observer with immutable cadence snapshots and four bounded workers. */
export class JevShadowScheduler {
  private epoch = 0;
  private session = "";
  private opportunity = "";
  private inflight = false;
  constructor(private readonly dependencies: JevShadowDependencies = {}) {}

  /** Only lifecycle boundaries invalidate writes, not incoming dialogue. */
  reset(): void {
    this.epoch++;
    this.session = "";
    this.opportunity = "";
    // Pending transports retain their slots across lifecycle changes.
  }

  observe(
    messages: DcpMessage[],
    state: DcpState,
    config: DcpConfig,
    sessionId: string,
    bridge?: FoRefBridgeV1 | null,
    modelRegistry?: unknown
  ): void {
    if (!config.enabled || !config.strategies.jev?.enabled || !sessionId) return;
    if (this.session !== sessionId) {
      this.reset();
      this.session = sessionId;
    }
    const cadence = Math.max(1, config.strategies.pruneCadenceTurns);
    const bucket = Math.floor(state.currentTurn / cadence) * cadence;
    const opportunity = `${cadence}:${bucket}`;
    if (this.inflight || this.opportunity === opportunity) return;
    this.opportunity = opportunity;
    // Async continuations never read mutable transcript/state.
    const context = snapshotJevTaskContext(messages);
    const skipped: Record<string, number> = {};
    const candidates = structuredClone(
      collectJevShadowCandidates(messages, state, config, bridge, (reason) => {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
      })
    );
    const epoch = this.epoch;
    const current = () => this.epoch === epoch && this.session === sessionId;
    this.inflight = true;
    const work = async () => {
      const dir = this.dependencies.agentDir ?? getAgentDir();
      const rows = await (this.dependencies.read ?? readJevLedger)(dir, sessionId);
      if (!current()) return;
      // Old rows without explicit cadence provenance cannot suppress judgments.
      const prior = rows.filter(
        (r) =>
          r.kind === "jev-shadow" &&
          r.sessionId === sessionId &&
          r.cadence === cadence &&
          r.bucket === bucket &&
          r.policy === "keep-drop-v1"
      );
      const taskContext =
        (prior.find((r) => typeof r.taskContext === "string")?.taskContext as string | undefined) ??
        context;
      const snapshotHash = hash(taskContext);
      const seen = new Set(prior.map((r) => r.cacheKey));
      const append = this.dependencies.append ?? appendJevLedger;
      const save = async (record: JevLedgerRecord) => {
        if (current()) await append(dir, sessionId, record);
      };
      if (!candidates.length && !prior.some((r) => r.reason === "no-eligible-candidates")) {
        await save({
          version: 1,
          kind: "jev-shadow",
          policy: "keep-drop-v1",
          sessionId,
          cadence,
          bucket,
          snapshotHash,
          outcome: "skip",
          reason: "no-eligible-candidates",
          skipped,
        });
      }
      let next = 0;
      const worker = async () => {
        while (current() && next < candidates.length) {
          const candidate = candidates[next++];
          const contentHash = hash(candidate.artifact);
          const cacheKey = hash(
            JSON.stringify({
              cadence,
              bucket,
              id: candidate.id,
              contentHash,
              args: candidate.inputArgs,
            })
          );
          if (seen.has(cacheKey)) continue;
          seen.add(cacheKey);
          const base = {
            version: 1 as const,
            kind: "jev-shadow",
            policy: "keep-drop-v1",
            sessionId,
            cadence,
            bucket,
            snapshotHash,
            cacheKey,
            candidateId: candidate.id,
            source: candidate.source,
            contentHash,
            timestamp: new Date().toISOString(),
          };
          const request = buildJevRequest({
            candidateId: candidate.id,
            taskContext,
            artifact: candidate.artifact,
            toolName: candidate.toolName,
            inputArgs: candidate.inputArgs,
            isError: candidate.isError,
            ageTurns: candidate.ageTurns,
          });
          const serialized = JSON.stringify(request);
          const estimatedTokens = Math.ceil(
            Math.max(estimateTokens(serialized) * 1.25, Buffer.byteLength(serialized, "utf8") / 3)
          );
          // Candidate eligibility defines the public-data boundary; content patterns do not.
          if (estimatedTokens > JEV_MAX_REQUEST_ESTIMATED_TOKENS) {
            await save({ ...base, outcome: "skip", reason: "oversized-request", estimatedTokens });
            continue;
          }
          const audit = {
            ...base,
            age_turns: request.state.age_turns,
            taskContext,
            taskContextHash: snapshotHash,
            promptHash: hash(JSON.stringify(request.questions)),
            instructions: request.questions.retention.instructions,
            criteria: request.questions.retention.criteria,
            model: request.model,
          };
          const started = Date.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let pending: Promise<unknown> | undefined;
          try {
            const requestFn =
              this.dependencies.request ??
              createPiOpenRouterJevRequest({ modelRegistry } as Parameters<
                typeof createPiOpenRouterJevRequest
              >[0]);
            pending = Promise.resolve().then(() => (current() ? requestFn(request) : undefined));
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("timeout")),
                this.dependencies.timeoutMs ?? 15000
              );
            });
            const result = parseJevResponse(await Promise.race([pending, timeout]));
            await save({
              ...audit,
              decision: result.decision,
              rawChoice: result.rawChoice,
              confidence: result.confidence,
              probabilities: result.probabilities,
              usage: safeUsage(result.usage),
              outcome:
                result.failure?.kind === "malformed_response"
                  ? "failure"
                  : result.failure
                    ? "gate-rejected"
                    : result.decision === "drop"
                      ? "proposed"
                      : "retained",
              reason: result.failure?.kind,
              latencyMs: Date.now() - started,
              cost:
                typeof result.cost === "number" && Number.isFinite(result.cost)
                  ? result.cost
                  : null,
            });
          } catch {
            await save({
              ...audit,
              decision: "keep",
              outcome: "failure",
              reason: "request-or-audit-failed",
              latencyMs: Date.now() - started,
            }).catch(() => {});
            // Keep a slot occupied if a transport ignores timeout, preserving the concurrency bound.
            if (pending) await pending.catch(() => {});
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
    };
    void work()
      .catch(() => {})
      .finally(() => {
        this.inflight = false;
      });
  }
}
