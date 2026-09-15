// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — PI extension prompts
// ---------------------------------------------------------------------------
// All prompt text is exported as plain strings so the extension index can
// reference them by name without executing any logic here.
// ---------------------------------------------------------------------------

/**
 * Appended to the existing system prompt when DCP is enabled (automatic mode).
 */
export const SYSTEM_PROMPT = `
You operate in a context-constrained environment. Compress proactively — it is essential to your performance.

\`compress\` replaces older messages with \`bN\` summaries you author. Summaries stay citable; a deterministic footer preserves bounded conversation excerpts, aggregate effect counts, and modified-file paths. It does not preserve individual commands or their outcomes. Compression sharpens retrieval for the live task; carrying closed work raw degrades it. Treat compression as steady housekeeping while you work, not an interrupt.

DCP metadata tags are injected metadata. Do not output them.

WHEN TO COMPRESS
Compress every reminder-listed stretch whose work is closed. Leave still-live work raw.

Use focused ranges and batch independent ones. Preserve consequential commands, verification outcomes, and delegated findings in past-tense summaries. The heading is the only place present intent lives; blocks are past record.
`.trim();

/**
 * Used as the \`description\` field when registering the \`compress\` tool.
 *
 * Tool signature:
 *   {
 *     topic?: string           // optional default 3-5 word label
 *     heading?: { goal: string; now: string; next: string; constraints?: string }
 *     ranges?: Array<{
 *       startId: string        // m0001-style non-assistant message ref or bN
 *       endId:   string        // m0001-style non-assistant message ref or bN
 *       summary: string        // past-tense record; (bN) placeholders
 *       topic?: string         // per-block label; falls back to top-level topic
 *     }>
 *   }
 */
export const COMPRESS_RANGE_DESCRIPTION = `Collapse conversation ranges into dense \`bN\` summaries.

Use visible transcript IDs as boundaries: \`mNNNN\` for user/tool-result messages and \`bN\` for compressed blocks. DCP includes complete assistant/tool groups automatically. Use existing, ordered IDs; keep ranges independent and non-overlapping; avoid the protected hot tail named by the current reminder.

summary: Write a past-tense record of what the stretch settled: decisions, artifacts or commits, verified facts, consequential commands, verification outcomes, and delegated findings. Not goals, not current state, not next steps; those go in heading.

heading (optional): Replace present direction in full: goal is the authorized outcome (in a charter session, write 'Objective: .charters/<id>/charter.md'); now is what is done versus the remaining gap as of this call; next is one step and why; optional constraints are user rules still in force. Maximum 1000 characters across these fields; over-budget input is rejected, never truncated. A heading-only call may omit ranges.

If a range contains prior \`bN\` blocks, include each as \`(bN)\` exactly once in summary and include no others. These placeholders expand to the full block, so their surrounding prose must remain grammatical. For a plain reference, write \`compressed bN\` instead.
`;
