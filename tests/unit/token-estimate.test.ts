import { describe, test } from "bun:test"
import { assert } from "../helpers/dcp-test-utils.js"
import { estimateMessageTokens, estimateTokens } from "../../src/domain/tokens/estimate.js"

describe("DCP token estimate.test", () => {
  test("tokenizer-backed estimates handle text and message content shapes", () => {
    assert.strictEqual(estimateTokens(""), 0, "FAIL — empty text should cost no tokens")
    assert.ok(estimateTokens("hello world") > 0, "FAIL — text should have a positive token estimate")

    const messageEstimate = estimateMessageTokens({
      content: [
        { type: "text", text: "hello world" },
        { type: "thinking", thinking: "private reasoning" },
        { type: "input", input: "tool input" },
      ],
    })

    assert.ok(messageEstimate >= estimateTokens("hello world"), "FAIL — message estimate should include text parts")
  })
})
