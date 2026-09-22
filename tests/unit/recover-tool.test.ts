import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  recoverOriginalToolOutput,
  registerRecoverTool,
} from "../../src/application/recover-tool.js";

const entry = (id: string, text: string) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    isError: false,
    content: [{ type: "text", text }],
  },
});
function tool() {
  let registered: any;
  registerRecoverTool({
    registerTool: (definition: any) => {
      registered = definition;
    },
  } as any);
  return registered;
}

describe("exact original-output recovery", () => {
  test("returns a clone of canonical output without executing a tool", () => {
    const entries = [entry("call-1", "deployed once")];
    const result = recoverOriginalToolOutput(entries, "call-1");
    expect(result.content[0].text).toBe("deployed once");
    result.content[0].text = "changed";
    expect(entries[0].message.content[0].text).toBe("deployed once");
  });

  test("does not cross branches or fabricate missing results", () => {
    expect(() => recoverOriginalToolOutput([entry("other", "other branch")], "missing")).toThrow(
      "current session branch"
    );
  });

  test("can recover from an embedded retained tail", () => {
    const message = entry("kept", "checkpoint original").message;
    expect(
      recoverOriginalToolOutput([{ type: "compaction", retainedTail: [message] }], "kept")
        .content[0].text
    ).toBe("checkpoint original");
  });

  test("decodes exact composite Ref identity and delegates only recovery", () => {
    const id = `fo-ref:v1:${encodeURIComponent("outer:id")}:${encodeURIComponent("timeline:event:1")}`;
    let received: any;
    const bridge = {
      recover: (request: any) => {
        received = request;
        return {
          status: "recovered",
          modelText: "exact original Ref",
          ref: {
            value: "original",
            images: [{ type: "image", data: "bytes", mimeType: "image/png" }],
          },
          candidate: { isError: false },
        };
      },
    };
    const result = recoverOriginalToolOutput(
      [entry("outer:id", "outer model projection")],
      id,
      bridge
    );
    expect(received.outerToolCallId).toBe("outer:id");
    expect(received.localId).toBe("timeline:event:1");
    expect(result.content[0].text).toBe("exact original Ref");
    expect(result.content[1].data).toBe("bytes");
  });

  test("stripped persisted image attribution directs recovery to the intact outer result", () => {
    const saved: any = entry("outer", "original image output");
    saved.message.content.push({ type: "image", data: "original-image", mimeType: "image/png" });
    const bridge = {
      recover: () => ({
        status: "recovered",
        modelText: "image reference",
        ref: { value: "image reference" },
        candidate: { isError: false },
      }),
    };
    expect(() => recoverOriginalToolOutput([saved], "fo-ref:v1:outer:inner", bridge)).toThrow(
      'dcp_recover({id:"outer"})'
    );
    const full = recoverOriginalToolOutput([saved], "outer", bridge);
    expect(full.content[1].data).toBe("original-image");
  });
  test("pages original lines with a stable continuation ID", async () => {
    const result = await tool().execute(
      "recovery",
      { id: "call", offset: 2, limit: 2 },
      undefined,
      undefined,
      { sessionManager: { getBranch: () => [entry("call", "one\ntwo\nthree\nfour")] } }
    );
    expect(result.content[0].text).toContain("two\nthree");
    expect(result.content[0].text).toContain("offset:4");
    expect(result.details.nextOffset).toBe(4);
  });

  test("overlong single lines remain exactly recoverable from a file", async () => {
    const original = "z".repeat(60_000);
    const result = await tool().execute("recovery", { id: "call" }, undefined, undefined, {
      sessionManager: { getBranch: () => [entry("call", original)] },
    });
    try {
      expect(readFileSync(result.details.fullOutputPath, "utf8")).toBe(original);
      expect(result.content[0].text).toContain(result.details.fullOutputPath);
    } finally {
      rmSync(dirname(result.details.fullOutputPath), { recursive: true });
    }
  });
});
