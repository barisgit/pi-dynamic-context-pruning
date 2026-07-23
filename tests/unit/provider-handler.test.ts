import { describe, expect, test } from "bun:test";
import { registerProviderHandler } from "../../src/application/provider-handler.js";
import { buildBlockOwnerKey } from "../../src/domain/transcript/index.js";
import { makeConfig, makeState } from "../helpers/dcp-test-utils.js";

describe("provider request handling", () => {
  test("returns payload changes when a sandbox compress receipt only minifies items", async () => {
    type Handler = (...args: any[]) => any;
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (name: string, handler: Handler) => handlers.set(name, handler),
    };
    const state = makeState([
      {
        id: 7,
        active: true,
        compressCallId: "nested_compress",
        topic: "cleanup",
      } as any,
    ]);
    state.lastLiveOwnerKeys = [buildBlockOwnerKey(7)];
    state.lastRenderedMessages = [
      {
        role: "toolResult",
        toolName: "run",
        toolCallId: "call_outer|fc_item",
        details: {
          kind: "sandbox.result",
          version: 1,
          timeline: [
            {
              kind: "tool",
              toolName: "compress",
              isError: false,
              result: { details: { blockIds: [7] } },
            },
          ],
        },
      } as any,
    ];

    registerProviderHandler(pi as any, state, makeConfig());
    const handler = handlers.get("before_provider_request");
    expect(handler).toBeDefined();

    const payload = {
      input: [
        {
          type: "function_call",
          name: "run",
          call_id: "call_outer",
          arguments: '{"code":"await compress(...)"}',
        },
        {
          type: "function_call_output",
          call_id: "call_outer",
          output: "Compressed 1 range(s): cleanup",
        },
      ],
    };
    const result = await handler!(
      { payload },
      {
        sessionManager: {
          getSessionId: () => "test-session",
          getCwd: () => "/tmp/test",
          getSessionDir: () => "/tmp/test-session",
          getSessionFile: () => null,
          getLeafId: () => null,
        },
      }
    );

    expect(result).toBeDefined();
    expect(result.input).toHaveLength(payload.input.length);
    expect(result.input[0].arguments).toContain("receiptOnly");
  });
});
