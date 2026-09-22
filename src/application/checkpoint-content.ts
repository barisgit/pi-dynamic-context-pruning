import type { DcpMessage } from "../types/message.js";

/** Project public conversation fields only; canonical details/signatures are not model text. */
export function projectCheckpointMessage(message: DcpMessage): DcpMessage | null {
  if (message.role === "bashExecution" && message.excludeFromContext) return null;
  const projected: DcpMessage = { role: message.role };
  for (const key of [
    "toolName",
    "toolCallId",
    "isError",
    "timestamp",
    "stopReason",
    "errorMessage",
  ] as const) {
    if (message[key] !== undefined) projected[key] = message[key];
  }
  if (message.role === "bashExecution") {
    for (const key of [
      "command",
      "output",
      "exitCode",
      "cancelled",
      "truncated",
      "fullOutputPath",
    ] as const) {
      if (message[key] !== undefined) projected[key] = message[key];
    }
  }
  if (typeof message.content === "string") projected.content = message.content;
  else if (Array.isArray(message.content))
    projected.content = message.content.map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string")
        return { type: "text", text: part.text };
      if (part?.type === "thinking") {
        if (typeof part.thinking === "string") return { type: "thinking", thinking: part.thinking };
        if (typeof part.text === "string") return { type: "thinking", text: part.text };
      }
      if (part?.type === "toolCall" || part?.type === "tool_use") {
        return {
          type: part.type,
          id: part.id,
          name: part.name,
          ...(part.arguments !== undefined ? { arguments: part.arguments } : {}),
          ...(part.input !== undefined ? { input: part.input } : {}),
        };
      }
      if (part?.type === "image")
        return { type: "image", data: part.data, mimeType: part.mimeType };
      // A new provider content shape must not be silently dropped or serialized wholesale.
      throw new Error(
        `Unsupported checkpoint content type: ${String(part?.type)}; history retained.`
      );
    });
  else if (message.content !== undefined && message.content !== null) {
    throw new Error("Unsupported checkpoint content; history retained.");
  }
  return projected;
}
