import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import type { complete, Context } from "@mariozechner/pi-ai";
import { runCycles, type CycleFixture } from "./evaluation-cycles.js";
import { createPiOpenRouterJevRequest, classifyArtifactWithJev } from "./evaluation-jev.js";
import {
  collectFoRefAdapterCandidates,
  projectFoRefOuterResult,
} from "../src/domain/pruning/fo-ref-adapter.js";
import { finalizeMaterializedMessages } from "../src/domain/pruning/index.js";
import { makeConfig, makeState } from "../tests/helpers/dcp-test-utils.js";

async function main(): Promise<void> {
  const outputDir = process.argv[2];
  const foRepo = process.argv[3];
  const provider = process.argv[4];
  const modelId = process.argv[5];
  const usage =
    "Usage: bun scripts/evaluation-run.ts OUTPUT_DIR FO_REPO PROVIDER MODEL_ID [--resume]; five cycles, five variants, at most 60 model / 10 Jev requests, synthetic only";
  if (process.argv.includes("--help")) {
    console.log(usage);
    return;
  }
  if (!outputDir || !foRepo || !provider || !modelId) throw new Error(usage);
  await mkdir(outputDir, { recursive: true });
  const { foExposedRefBridgeV1: bridge } = await import(
    pathToFileURL(resolve(foRepo, "src/runtime/exposed-refs.ts")).href
  );
  const { makeRef } = await import(pathToFileURL(resolve(foRepo, "src/runtime/refs.ts")).href);
  const { projectModelText } = await import(
    pathToFileURL(resolve(foRepo, "src/runtime/envelope.ts")).href
  );
  // Current installed Pi runtime, matching charter dcp-model-smoke.ts. Credentials
  // stay in memory and catalog loading is offline; no auth/model configuration writes.
  const sdkCore = resolve(foRepo, "node_modules/@earendil-works/pi-coding-agent/dist/core");
  const { AuthStorage } = await import(pathToFileURL(join(sdkCore, "auth-storage.js")).href);
  const { ModelRegistry } = await import(pathToFileURL(join(sdkCore, "model-registry.js")).href);
  const { ModelRuntime } = await import(pathToFileURL(join(sdkCore, "model-runtime.js")).href);
  const agentDir = join(homedir(), ".pi/agent");
  const credentials = AuthStorage.inMemory(
    JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))
  );
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  const registry = new ModelRegistry(runtime);
  const model = registry.find(provider, modelId);
  if (!model) throw new Error(`Requested model absent from Pi registry: ${provider}/${modelId}`);
  if (!registry.hasConfiguredAuth(model))
    throw new Error(`Provider authentication unavailable: ${provider}`);
  const resume = process.argv.includes("--resume");
  const existingFiles = await readdir(outputDir);
  if (!resume && existingFiles.length > 0)
    throw new Error("Output directory must be empty unless --resume is explicit");
  const previous = resume
    ? JSON.parse(await readFile(join(outputDir, "results.json"), "utf8"))
    : null;
  if (previous && (previous.model !== model.id || previous.provider !== model.provider))
    throw new Error("Cannot resume with a different working model");
  let call = existingFiles.filter((file) => /^model-\d+-input\.json$/.test(file)).length;
  let variant = "setup";
  const metrics: unknown[] = resume
    ? JSON.parse(await readFile(join(outputDir, "metrics.json"), "utf8"))
    : [];
  const completion: typeof complete = async (selected, context, options) => {
    const id = ++call;
    if (id > 60) throw new Error("Bounded budget: at most 60 working-model requests");
    const start = performance.now();
    await writeFile(
      join(outputDir, `model-${id}-input.json`),
      JSON.stringify(
        {
          variant,
          provider: selected.provider,
          model: selected.id,
          context,
          maxTokens: options?.maxTokens,
        },
        null,
        2
      )
    );
    const { apiKey: _injectedKey, headers: _injectedHeaders, ...requestOptions } = options ?? {};
    void _injectedKey;
    void _injectedHeaders;
    const response = await registry.complete(selected, context, {
      ...requestOptions,
      signal: AbortSignal.timeout(90000),
      cacheRetention: "none",
    });
    const row = {
      id,
      variant,
      latencyMs: performance.now() - start,
      usage: response.usage,
      stopReason: response.stopReason,
    };
    metrics.push(row);
    await writeFile(join(outputDir, `model-${id}-output.json`), JSON.stringify(response, null, 2));
    await writeFile(join(outputDir, "metrics.json"), JSON.stringify(metrics, null, 2));
    return response;
  };
  const jevTransport = await createPiOpenRouterJevRequest({
    fetchImpl: ((input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(30000) })) as typeof fetch,
  });
  let jevCalls = existingFiles.filter((file) => /^jev-\d+-input\.json$/.test(file)).length;
  const jevRequest: typeof jevTransport = async (request) => {
    if (++jevCalls > 10) throw new Error("Bounded budget: at most ten Jev requests");
    const start = performance.now();
    await writeFile(
      join(outputDir, `jev-${jevCalls}-input.json`),
      JSON.stringify(request, null, 2)
    );
    const response = await jevTransport(request);
    await writeFile(
      join(outputDir, `jev-${jevCalls}-output.json`),
      JSON.stringify({ response, latencyMs: performance.now() - start }, null, 2)
    );
    return response;
  };
  function envelope(f: CycleFixture): any {
    const items =
      f.cycle === 0
        ? [
            {
              id: "old",
              tool: "read",
              text: "routine observation ".repeat(6000),
              path: "routine.txt",
            },
            {
              id: "new",
              tool: "read",
              text: "routine observation ".repeat(6000),
              path: "routine.txt",
            },
          ]
        : [];
    items.push({ id: "diagnostic", tool: "bash", text: f.artifact, path: "synthetic-check" });
    return {
      kind: "sandbox.result",
      version: 1,
      script: { hash: "safe-synthetic" },
      emissions: items.map((item) => ({
        kind: "ref",
        ref: makeRef(item.tool, item.text, {
          cwd: "/synthetic",
          input: { path: item.path },
          timelineId: item.id,
        }),
      })),
      final: null,
      timeline: items.map((item) => ({
        id: item.id,
        kind: "tool",
        toolName: item.tool,
        args: { path: item.path },
        result: { content: [{ type: "text", text: item.text }], isError: false },
      })),
      trace: [],
      budgets: { timedOut: false, calls: items.length, visibleBytesTruncated: false },
    };
  }
  const results: { id: string }[] = previous?.results ?? [];
  for (const spec of [
    { id: "A", timing: "early" },
    { id: "B", timing: "early" },
    { id: "C", timing: "early" },
    { id: "D", timing: "early" },
    { id: "B-late", timing: "late" },
  ] as const) {
    if (results.some((result) => result.id === spec.id)) continue;
    variant = spec.id;
    const strategy = async (fixture: CycleFixture) => {
      const env = envelope(fixture);
      const before = JSON.stringify(env);
      const outerToolCallId = `run-${fixture.cycle}`;
      const original = projectModelText(env, 2000000, 2000000).text;
      const collected = collectFoRefAdapterCandidates({
        bridge,
        details: env,
        outerToolCallId,
        outerRecord: { turnIndex: 0, timestamp: 1000 },
      });
      if (collected.status !== "supported")
        throw new Error("Production Ref adapter rejected synthetic envelope");
      const state = makeState();
      const config = makeConfig();
      state.currentTurn = 25;
      config.compress.protectRecentTurns = 0; // candidates explicitly represent settled work 25 logical turns old
      config.strategies.pruneCadenceTurns = 25;
      config.strategies.minPruneItemSavedTokens = 100;
      config.strategies.minPruneBatchSavedTokens = 10000;
      config.strategies.deduplication.enabled = spec.id !== "A";
      state.toolCalls.set(outerToolCallId, {
        toolCallId: outerToolCallId,
        toolName: "run",
        inputArgs: { code: "synthetic" },
        inputFingerprint: "run::synthetic",
        isError: false,
        turnIndex: 0,
        timestamp: 1000,
        tokenEstimate: 0,
      });
      const outer = {
        role: "toolResult",
        toolCallId: outerToolCallId,
        toolName: "run",
        content: [{ type: "text", text: original }],
        details: env,
        timestamp: 1000,
      };
      const assistant = {
        role: "assistant",
        content: [
          { type: "toolCall", id: outerToolCallId, name: "run", arguments: { code: "synthetic" } },
        ],
        timestamp: 999,
      };
      finalizeMaterializedMessages([assistant, outer], state, config, {
        foRefBridge: bridge,
        turnMessages: Array.from({ length: 25 }, (_, i) => ({
          role: "user",
          content: `Settled logical turn ${i}`,
          timestamp: i,
        })),
      });
      if (fixture.cycle === 0 && spec.id !== "A" && state.prunedToolIds.size !== 1)
        throw new Error(
          `Expected one deterministic duplicate selection, got ${state.prunedToolIds.size}: ${JSON.stringify(state.lastHeuristicPruneDecision)}`
        );
      const projected = projectFoRefOuterResult({
        bridge,
        details: env,
        outerToolCallId,
        outerMessage: {
          role: "toolResult",
          toolCallId: outerToolCallId,
          toolName: "run",
          content: [{ type: "text", text: original }],
        },
        persistedActions: state.prunedToolActions,
        maxVisibleBytes: 2000000,
        maxVisibleEventBytes: 2000000,
      });
      let output = projected.status === "projected" ? projected.projectedText : original;
      let decision: unknown;
      if (spec.id === "C" || spec.id === "D") {
        const candidate = collected.candidates.find((c) => c.timelineId === "diagnostic")!;
        decision = await classifyArtifactWithJev(
          {
            candidateId: candidate.compositeId,
            taskContext:
              "Prepare local release mail drafts only. Retain current blockers and unverified integration status. No integration run has succeeded.",
            artifact: candidate.text,
          },
          jevRequest
        );
        // C exercises the actual classifier; failures and uncertain drops retain the output.
        const choices: Record<string, string> = {};
        for (const id of state.prunedToolIds) {
          const c = collected.candidates.find((c) => c.compositeId === id);
          if (c)
            choices[c.localId] =
              "[Duplicate observed output removed; canonical original recoverable]";
        }
        if ((decision as { decision: string }).decision === "drop")
          choices[candidate.localId] = "[Jev-selected drop; canonical original recoverable]";
        if (spec.id === "D") {
          const context: Context = {
            systemPrompt:
              "Summarize this original synthetic artifact. Preserve exact blocker identifiers, verification uncertainty and consequential facts. Do not invent success. Return only the summary.",
            messages: [{ role: "user", content: candidate.text, timestamp: 1000 }],
          };
          const response = await completion(model, context, { maxTokens: 500 });
          if (response.stopReason !== "stop") throw new Error("Artifact summary incomplete");
          choices[candidate.localId] =
            response.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n") + `\nRecovery: ${candidate.compositeId}`;
        }
        const result = bridge.project({
          outerToolCallId,
          details: env,
          originalModelText: original,
          decisions: choices,
          maxVisibleBytes: 2000000,
          maxVisibleEventBytes: 2000000,
        });
        output = result.modelText;
      }
      if (JSON.stringify(env) !== before) throw new Error("Canonical original mutated");
      const recovered = bridge.recover({
        outerToolCallId,
        details: env,
        localId: "timeline:diagnostic",
      });
      if (recovered.status !== "recovered" || recovered.candidate.text !== fixture.artifact)
        throw new Error("Exact recovery failed");
      return {
        text: output,
        evidence: {
          originalCharacters: original.length,
          projectedCharacters: output.length,
          gate: state.lastHeuristicPruneDecision,
          selected: [...state.prunedToolIds],
          jev: decision,
          originalUnchanged: true,
          exactRecovery: true,
        },
      };
    };
    results.push(
      (await runCycles({
        ...spec,
        outputDir: join(outputDir, spec.id),
        completion,
        model,
        strategy,
      })) as { id: string }
    );
    await writeFile(
      join(outputDir, "results.json"),
      JSON.stringify(
        {
          model: model.id,
          provider: model.provider,
          results,
          workingModelCalls: call,
          jevCalls,
          costMeaning:
            "SDK usage.cost is catalog estimate, not an invoice; no cache savings inference",
        },
        null,
        2
      )
    );
  }
  console.log(JSON.stringify({ outputDir, workingModelCalls: call, jevCalls }));
}
if (import.meta.main) await main();
