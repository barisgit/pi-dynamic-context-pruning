import { describe, test, expect } from "bun:test";
import { buildDcpStatusText } from "../../src/application/status.js";
import { makeState } from "../helpers/dcp-test-utils.js";

describe("DCP status.test", () => {
  test("status text uses aggregate savings and latest active block id", () => {
    const state = makeState([
      {
        id: 1,
        topic: "one",
        summary: "summary one",
        startTimestamp: 1,
        endTimestamp: 2,
        anchorTimestamp: 3,
        createdAt: 3,
        active: true,
        summaryTokenEstimate: 100,
        savedTokenEstimate: 96_837,
      },
      {
        id: 2,
        topic: "two",
        summary: "summary two",
        startTimestamp: 4,
        endTimestamp: 5,
        anchorTimestamp: 6,
        createdAt: 6,
        active: true,
        summaryTokenEstimate: 100,
        savedTokenEstimate: 78_656,
      },
      {
        id: 3,
        topic: "three",
        summary: "summary three",
        startTimestamp: 7,
        endTimestamp: 8,
        anchorTimestamp: 9,
        createdAt: 9,
        active: true,
        summaryTokenEstimate: 100,
        savedTokenEstimate: 93_099,
      },
    ]);
    state.tokensSaved = 268_592;
    state.totalPruneCount = 1_824;

    expect(buildDcpStatusText(state)).toBe("DCP 269k saved 1.8k prunes b3");
  });

  test("status text uses uppercase M with sub-100k precision for million-scale savings", () => {
    const state = makeState([
      {
        id: 13,
        topic: "million-scale",
        summary: "summary",
        startTimestamp: 1,
        endTimestamp: 2,
        anchorTimestamp: 3,
        createdAt: 3,
        active: true,
        summaryTokenEstimate: 100,
        savedTokenEstimate: 1_012_345,
      },
    ]);
    state.tokensSaved = 1_012_345;
    state.totalPruneCount = 3_612;

    expect(buildDcpStatusText(state)).toBe("DCP 1.012M saved 3.6k prunes b13");
  });

  test("status text promotes rounded 1000k values to uppercase M", () => {
    const state = makeState();
    state.tokensSaved = 999_500;

    expect(buildDcpStatusText(state)).toBe("DCP 1M saved");
  });
});
