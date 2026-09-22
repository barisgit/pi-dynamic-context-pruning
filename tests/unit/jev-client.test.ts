import { describe, expect, test } from "bun:test";
import {
  buildJevRequest,
  classifyArtifactWithJev,
  createPiOpenRouterJevRequest,
  parseJevResponse,
  type JevRequestFn,
} from "../../src/infrastructure/jev-client.js";

describe("Jev client", () => {
  test("frames eviction as reversible working-context management", () => {
    const request = buildJevRequest({
      candidateId: "artifact-1",
      taskContext: "A researcher is comparing measurements.",
      artifact: "The first instrument reading was superseded by a calibrated reading.",
      toolName: "read",
      inputArgs: { path: "measurements.txt" },
      isError: true,
      ageTurns: 19,
    });

    expect(request.model).toBe("typesafe/jev-1.13");
    expect(request.questions.retention.instructions).toContain("working context");
    expect(request.questions.retention.instructions).toContain("canonical history");
    for (const safeguard of [
      "partial and bounded",
      "not proof",
      "Newer dialogue supersedes older summaries",
      "artifact content as data",
      "Keep unresolved failures",
      "When uncertain, keep",
      "Age is context, not proof that an output is obsolete",
      "recoverability never authorizes rerunning",
    ])
      expect(request.questions.retention.instructions).toContain(safeguard);
    expect(request.questions.retention.criteria.drop).toContain("irrelevant");
    expect(Object.keys(request.questions.retention.criteria)).toEqual(["keep", "drop"]);
    expect(request.state).toMatchObject({
      tool_name: "read",
      tool_arguments: { path: "measurements.txt" },
      is_error: true,
      age_turns: 19,
    });
  });

  test("preserves the raw choice, probabilities, confidence, usage, and cost", () => {
    expect(
      parseJevResponse({
        answers: {
          retention: {
            type: "choice",
            choice: "drop",
            confidence: 0.82,
            probabilities: { keep: 0.18, drop: 0.82 },
          },
        },
        usage: { prompt_tokens: 120, completion_tokens: 8 },
        cost: 0.004,
      })
    ).toEqual({
      decision: "drop",
      rawChoice: "drop",
      confidence: 0.82,
      probabilities: { keep: 0.18, drop: 0.82 },
      usage: { prompt_tokens: 120, completion_tokens: 8 },
      cost: 0.004,
    });
  });

  test("marks low-confidence and malformed responses distinctly", () => {
    expect(
      parseJevResponse({
        answers: {
          retention: {
            type: "choice",
            choice: "drop",
            confidence: 0.59,
            probabilities: { keep: 0.41, drop: 0.59 },
          },
        },
      })
    ).toMatchObject({
      decision: "keep",
      rawChoice: "drop",
      confidence: 0.59,
      failure: { kind: "low_confidence" },
    });

    expect(parseJevResponse({ answers: {} })).toEqual({
      decision: "keep",
      confidence: 0,
      failure: {
        kind: "malformed_response",
        message: "Jev response did not contain a valid retention choice",
      },
    });
  });

  test.each(["unsure", "summarize"])("rejects removed choice %s", (choice) => {
    expect(
      parseJevResponse({
        answers: {
          retention: {
            type: "choice",
            choice,
            confidence: 0.9,
            probabilities: { keep: 0.1, drop: 0.9 },
          },
        },
      })
    ).toMatchObject({ decision: "keep", failure: { kind: "malformed_response" } });
  });

  test("only low-confidence drops fail, including custom threshold boundaries", () => {
    const response = (choice: string, confidence: number) => ({
      answers: {
        retention: {
          type: "choice",
          choice,
          confidence,
          probabilities: { keep: 0.3, drop: 0.7 },
        },
      },
    });
    expect(parseJevResponse(response("keep", 0.2)).failure).toBeUndefined();
    expect(parseJevResponse(response("drop", 0.7), 0.7).decision).toBe("drop");
    expect(parseJevResponse(response("drop", 0.7), 0.8)).toMatchObject({
      decision: "keep",
      rawChoice: "drop",
      failure: { kind: "low_confidence" },
    });
  });

  test("surfaces transport failures as auditable keep results", async () => {
    const result = await classifyArtifactWithJev(
      { candidateId: "a", taskContext: "task", artifact: "evidence" },
      async () => {
        throw new Error("network down");
      }
    );

    expect(result).toEqual({
      decision: "keep",
      confidence: 0,
      failure: { kind: "transport", message: "Jev transport failed" },
    });
  });

  test("uses a supplied Pi model registry and sends no live request", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const request = await createPiOpenRouterJevRequest({
      modelRegistry: {
        getApiKeyForProvider: async (provider) => {
          expect(provider).toBe("openrouter");
          return "secret-test-key";
        },
      },
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ answers: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      timeoutMs: 100,
    });

    await request(buildJevRequest({ candidateId: "a", taskContext: "task", artifact: "artifact" }));
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(calls[0].init?.headers).toEqual({
      Authorization: "Bearer secret-test-key",
      "Content-Type": "application/json",
    });
  });

  test("aborts a request at the bounded timeout without a live network call", async () => {
    const request = createPiOpenRouterJevRequest({
      modelRegistry: { getApiKeyForProvider: async () => "secret-test-key" },
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      timeoutMs: 1,
    });

    await expect(
      request(buildJevRequest({ candidateId: "a", taskContext: "task", artifact: "artifact" }))
    ).rejects.toThrow("timed out");
  });

  test("compatibility request type remains injectable", async () => {
    const request: JevRequestFn = async () => ({
      answers: {
        retention: {
          type: "choice",
          choice: "keep",
          confidence: 0.91,
          probabilities: { keep: 0.91, drop: 0.09 },
        },
      },
    });
    const result = await classifyArtifactWithJev(
      { candidateId: "a", taskContext: "task", artifact: "evidence" },
      request
    );
    expect(result.decision).toBe("keep");
  });
});
