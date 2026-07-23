import { describe, expect, test } from "bun:test";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { parseJsonHttpBody } from "../../scripts/llm-proxy-codec.js";

describe("LLM proxy request decoding", () => {
  test("parses gzip-compressed JSON request bodies without changing forwarded bytes", () => {
    const body = { model: "gpt-5", input: [{ role: "user", content: "hello" }] };
    const compressed = gzipSync(Buffer.from(JSON.stringify(body)));
    const before = Buffer.from(compressed);

    expect(parseJsonHttpBody(compressed, { "content-encoding": "gzip" })).toEqual(body);
    expect(compressed).toEqual(before);
  });

  test("parses uncompressed JSON request bodies", () => {
    const body = { model: "gpt-5", input: [] };
    const raw = Buffer.from(JSON.stringify(body));

    expect(parseJsonHttpBody(raw, {})).toEqual(body);
  });

  test("parses zstd-compressed Codex request bodies", () => {
    const body = { model: "gpt-5-codex", input: [{ role: "user", content: "hello" }] };
    const compressed = zstdCompressSync(Buffer.from(JSON.stringify(body)));

    expect(parseJsonHttpBody(compressed, { "content-encoding": "zstd" })).toEqual(body);
  });
});
