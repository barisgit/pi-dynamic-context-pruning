import type { DcpHeading, DcpState } from "../../types/state.js";
import type { DcpMessage } from "../../types/message.js";
import { buildTranscriptSnapshot, INTERNAL_HEADING } from "../transcript/index.js";

export type HeadingInput = Pick<DcpHeading, "goal" | "now" | "next" | "constraints">;
export const MAX_HEADING_CHARS = 1000;

/** Replace direction as a whole; reject oversized input rather than losing intent. */
export function createHeading(input: HeadingInput, state: DcpState, revisedAt: number): DcpHeading {
  const count =
    input.goal.length + input.now.length + input.next.length + (input.constraints?.length ?? 0);
  if (count > MAX_HEADING_CHARS) {
    throw new Error(`Heading has ${count} characters; maximum is ${MAX_HEADING_CHARS}.`);
  }
  const revisedAfterId = [...state.messageRefSnapshot.keys()]
    .filter((ref) => /^m\d{4,}$/.test(ref))
    .at(-1);
  if (!revisedAfterId)
    throw new Error("Heading requires a visible message reference from the latest context.");
  return { ...input, revisedAfterId, revisedAt };
}

/** Restore optional heading data without interpreting or rewriting its strings. */
export function normalizeHeading(value: unknown): DcpHeading | undefined {
  if (!value || typeof value !== "object") return undefined;
  const h = value as Record<string, unknown>;
  if (
    typeof h.goal !== "string" ||
    typeof h.now !== "string" ||
    typeof h.next !== "string" ||
    typeof h.revisedAfterId !== "string" ||
    typeof h.revisedAt !== "number" ||
    !Number.isFinite(h.revisedAt) ||
    (h.constraints !== undefined && typeof h.constraints !== "string")
  )
    return undefined;
  return {
    goal: h.goal,
    now: h.now,
    next: h.next,
    ...(h.constraints !== undefined ? { constraints: h.constraints } : {}),
    revisedAfterId: h.revisedAfterId,
    revisedAt: h.revisedAt,
  };
}

/** Render present direction verbatim, outside historical block text. */
export function renderHeading(heading: DcpHeading): string {
  return `<heading revised-after="${heading.revisedAfterId}">\nGoal: ${heading.goal}\n\nNow: ${heading.now}\n\nNext: ${heading.next}${heading.constraints === undefined ? "" : `\n\nConstraints: ${heading.constraints}`}\n</heading>`;
}

/** Heading messages are internal synthetic users, never compression boundaries. */
export function renderHeadingMessage(heading: DcpHeading): DcpMessage {
  const message: DcpMessage = {
    role: "user",
    content: [{ type: "text", text: renderHeading(heading) }],
  };
  Object.defineProperty(message, INTERNAL_HEADING, { value: true, enumerable: false });
  return message;
}

/** Remove the heading envelope baked into a previous native compaction. */
export function stripHeadingPrefix(summary: string): string {
  return summary.replace(/^<heading revised-after="[^"\n]*">[\s\S]*?\n<\/heading>\s*/, "");
}

/** Count logical work since the heading's last visible boundary, not message IDs. */
export function renderHeadingReminder(
  state: DcpState,
  messages: DcpMessage[],
  history: DcpMessage[] = messages
): string {
  const heading = state.heading;
  if (!heading)
    return state.compressionBlocks.filter((block) => block.active).length >= 2
      ? "No heading. Write one: goal, now, next."
      : "";
  let snapshot = buildTranscriptSnapshot(messages);
  let spans = snapshot.spans.filter((span) =>
    ["user", "assistant", "toolResult", "bashExecution"].includes(span.role)
  );
  const key = state.messageAliases.byRef.get(heading.revisedAfterId);
  let index = key ? spans.findIndex((span) => span.sourceKeys.includes(key)) : -1;
  // v5 restores do not retain visible aliases. Resolve the latest visible source
  // at revision time when the original reference no longer resolves in this buffer.
  const referenced = snapshot.sourceItems.find((item) => item.key === key);
  if (
    index < 0 ||
    (referenced?.timestamp !== null &&
      referenced?.timestamp !== undefined &&
      referenced.timestamp > heading.revisedAt)
  ) {
    snapshot = buildTranscriptSnapshot(history);
    spans = snapshot.spans.filter((span) =>
      ["user", "assistant", "toolResult", "bashExecution"].includes(span.role)
    );
    const boundary = snapshot.sourceItems
      .filter(
        (item) =>
          ["user", "toolResult", "bashExecution"].includes(item.role) &&
          item.timestamp !== null &&
          item.timestamp <= heading.revisedAt
      )
      .at(-1);
    if (boundary) index = spans.findIndex((span) => span.sourceKeys.includes(boundary.key));
  }
  const age = Math.max(0, spans.length - index - 1);
  return `Heading revised after ${heading.revisedAfterId} (${age} turns ago) — replace it if it no longer matches where the work is.`;
}
