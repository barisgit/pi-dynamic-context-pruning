import { expect, test } from "bun:test";

test("tokenizer loads only on first nonempty estimate without changing counts", () => {
  // A fresh process prevents other token-estimation suites from warming the module cache.
  const result = Bun.spawnSync([
    process.execPath,
    "-e",
    `const { estimateTokens } = await import(${JSON.stringify(new URL("../../src/domain/tokens/estimate.ts", import.meta.url).pathname)});
     const loaded = () => Object.keys(require.cache).some(path => path.includes("gpt-tokenizer"));
     if (loaded()) throw new Error("tokenizer loaded during import");
     if (estimateTokens("") !== 0 || loaded()) throw new Error("empty text loaded tokenizer");
     const texts = ["hello world", "Slovenščina 日本語", "<|endoftext|>", "a".repeat(10000)];
     const estimates = texts.map(estimateTokens);
     if (!loaded()) throw new Error("tokenizer was not loaded on demand");
     const { countTokens } = require("gpt-tokenizer");
     for (const [index, text] of texts.entries()) {
       let expected;
       try { expected = countTokens(text); } catch { expected = Math.round(text.length / 4); }
       if (estimates[index] !== expected) throw new Error("token count changed");
     }`,
  ]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
