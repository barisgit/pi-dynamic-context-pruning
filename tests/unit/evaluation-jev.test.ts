import { describe, expect, test } from "bun:test";
import {
  buildJevRequest,
  classifyArtifactWithJev,
  parseJevResponse,
  type JevRequestFn,
} from "../../scripts/evaluation-jev.js";

describe("evaluation Jev adapter", () => {
  test("builds one typed choice question from the full candidate", () => {
    const request = buildJevRequest({
      candidateId: "artifact-1",
      taskContext: "Preserve the user's authorization boundary.",
      artifact: "Do not publish without asking first.",
    });

    expect(request.model).toBe("typesafe/jev-1.13");
    expect(request.state).toEqual({
      candidate_id: "artifact-1",
      task_context: "Preserve the user's authorization boundary.",
      artifact: "Do not publish without asking first.",
      tool_name: "unknown",
      tool_arguments: {},
      is_error: false,
      age_turns: null,
    });
    expect(request.questions.retention.type).toBe("choice");
    expect(Object.keys(request.questions.retention.criteria)).toEqual(["keep", "drop"]);
  });

  test("accepts a confident documented choice response", () => {
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
      })
    ).toMatchObject({
      decision: "drop",
      rawChoice: "drop",
      confidence: 0.82,
      probabilities: { keep: 0.18, drop: 0.82 },
    });
  });

  test.each([
    undefined,
    {},
    { answers: {} },
    { answers: { retention: { type: "choice", choice: "erase", confidence: 0.99 } } },
    { answers: { retention: { type: "choice", choice: "drop", confidence: 2 } } },
    {
      answers: {
        retention: {
          type: "choice",
          choice: "drop",
          confidence: 0.9,
          probabilities: { keep: 0.4, drop: 0.9 },
        },
      },
    },
    {
      answers: {
        retention: {
          type: "choice",
          choice: "drop",
          confidence: 0.9,
          probabilities: { drop: "high" },
        },
      },
    },
  ])("returns keep for malformed response %#", (response) => {
    expect(parseJevResponse(response)).toMatchObject({
      decision: "keep",
      confidence: 0,
      failure: { kind: "malformed_response" },
    });
  });

  test("maps a low-drop-probability destructive choice to keep", () => {
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
      failure: { kind: "low_drop_probability" },
      probabilities: { keep: 0.41, drop: 0.59 },
    });
  });

  test("uses an injected request function without provider coupling", async () => {
    const calls: unknown[] = [];
    const request: JevRequestFn = async (body) => {
      calls.push(body);
      return {
        answers: {
          retention: {
            type: "choice",
            choice: "keep",
            confidence: 0.91,
            probabilities: { keep: 0.91, drop: 0.09 },
          },
        },
      };
    };

    const result = await classifyArtifactWithJev(
      { candidateId: "a", taskContext: "task", artifact: "evidence" },
      request
    );

    expect(calls).toHaveLength(1);
    expect(result.decision).toBe("keep");
  });

  test("turns transport failures into keep by default", async () => {
    const result = await classifyArtifactWithJev(
      { candidateId: "a", taskContext: "task", artifact: "evidence" },
      async () => {
        throw new Error("network down");
      }
    );

    expect(result).toMatchObject({
      decision: "keep",
      confidence: 0,
      failure: { kind: "transport" },
    });
  });
});
