import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { saveRecoveryText } from "../infrastructure/recovery-output.js";
import { Type } from "@sinclair/typebox";
import type { DcpMessage } from "../types/message.js";

/** Read the optional fo-only bridge at use time, including after extension reload. */
export function getFoRefBridge(): any | undefined {
  const bridge = (globalThis as any)[Symbol.for("fo.exposed-ref-bridge.v1")];
  return bridge?.version === 1 &&
    typeof bridge.collect === "function" &&
    typeof bridge.project === "function" &&
    typeof bridge.recover === "function"
    ? bridge
    : undefined;
}

function decodeRecoveryId(id: string): { toolCallId: string; localId?: string } {
  if (!id.startsWith("fo-ref:v1:")) return { toolCallId: id };
  const parts = id.slice("fo-ref:v1:".length).split(":");
  if (parts.length !== 2) throw new Error("Invalid fo Ref recovery ID.");
  try {
    return { toolCallId: decodeURIComponent(parts[0]), localId: decodeURIComponent(parts[1]) };
  } catch {
    throw new Error("Invalid encoded fo Ref recovery ID.");
  }
}

/** Recover from canonical branch history, never by executing the original tool. */
export function recoverOriginalToolOutput(
  entries: any[],
  id: string,
  bridge = getFoRefBridge()
): {
  content: any[];
  details: Record<string, unknown>;
} {
  const { toolCallId, localId } = decodeRecoveryId(id);
  // Prefer original message entries to materialized checkpoint copies.
  const messages: DcpMessage[] = entries
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  for (const entry of entries) {
    if (entry.type === "compaction" && Array.isArray(entry.retainedTail))
      messages.push(...entry.retainedTail);
  }
  const message = messages.find(
    (item) => item.role === "toolResult" && item.toolCallId === toolCallId
  );
  if (!message)
    throw new Error(
      "Original tool result was not found on the current session branch. Do not rerun a mutating operation merely to recover its output."
    );
  if (localId !== undefined) {
    if (!bridge)
      throw new Error(
        "Exact Ref recovery requires the fo launcher bridge. The saved original is unchanged."
      );
    const recovered = bridge.recover({
      outerToolCallId: toolCallId,
      details: message.details,
      localId,
    });
    if (recovered.status !== "recovered")
      throw new Error(
        "This Ref is not an identifiable exposed result in the saved envelope; the original is unchanged."
      );
    const outerHasImages =
      Array.isArray(message.content) && message.content.some((part) => part.type === "image");
    if (outerHasImages && !recovered.ref.images?.length) {
      throw new Error(
        `Images are preserved on the original outer result but cannot be attributed exactly to this saved Ref. Recover the complete outer result with dcp_recover({id:${JSON.stringify(toolCallId)}}); no operation will be rerun.`
      );
    }
    const content: any[] = [{ type: "text", text: recovered.modelText }];
    if (Array.isArray(recovered.ref.images)) content.push(...structuredClone(recovered.ref.images));
    return {
      content,
      details: {
        recoveredFrom: id,
        originalRef: recovered.ref,
        originalIsError: recovered.candidate.isError,
      },
    };
  }
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : structuredClone(message.content ?? []);
  return { content, details: { recoveredFrom: id, originalIsError: message.isError === true } };
}

export function registerRecoverTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dcp_recover",
    label: "Recover original output",
    description:
      "Read an original tool result from the current session branch without rerunning it. Use the exact recovery ID in a DCP pruning marker. Optional offset/limit page text by line (default first 2000 lines, at most 50,000 characters per call); overlong single lines are saved intact to a recovery file. Canonical originals and images remain intact.",
    parameters: Type.Object({
      id: Type.String({
        minLength: 1,
        description: "A saved tool-call ID or fo-ref:v1 composite ID from a pruning marker.",
      }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "First text line, 1-based." })),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 2000, description: "Maximum text lines to return." })
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const original = recoverOriginalToolOutput(ctx.sessionManager.getBranch(), params.id);
      const text = original.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const lines = text.split("\n");
      const start = (params.offset ?? 1) - 1;
      const limit = params.limit ?? 2000;
      const selected: string[] = [];
      let characters = 0;
      for (let index = start; index < Math.min(lines.length, start + limit); index++) {
        const line = lines[index];
        if (characters + line.length + 1 > 50_000) {
          if (selected.length === 0) {
            const fullOutputPath = saveRecoveryText(text);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `An original line exceeds the display limit. Complete original text (${text.length} characters) saved to ${fullOutputPath}; inspect that file without rerunning the operation.`,
                },
                ...original.content.filter((part) => part.type !== "text"),
              ],
              details: { ...original.details, fullOutputPath, textLines: lines.length },
            };
          }
          break;
        }
        selected.push(line);
        characters += line.length + 1;
      }
      const next = start + selected.length;
      const marker =
        next < lines.length
          ? `\n[Original output continues: dcp_recover({id:${JSON.stringify(params.id)},offset:${next + 1}})]`
          : "";
      return {
        content: [
          { type: "text" as const, text: selected.join("\n") + marker },
          ...original.content.filter((part) => part.type !== "text"),
        ],
        details: {
          ...original.details,
          textLines: lines.length,
          ...(next < lines.length ? { nextOffset: next + 1 } : {}),
        },
      };
    },
  });
}
