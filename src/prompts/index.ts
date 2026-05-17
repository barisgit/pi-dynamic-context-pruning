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

The \`compress\` tool replaces older messages with \`bN\` summaries you author. Summaries stay citable; a deterministic activity log preserves file/command facts. Compression sharpens retrieval for the live task; carrying closed work raw degrades it. Treat compression as steady housekeeping while you work, not an interrupt.

DCP metadata tags are injected metadata. Do not output them.

WHEN TO COMPRESS
Each DCP reminder lists stretches that are structurally safe to compress. Compress every one whose work is closed — research concluded, change verified, exploration exhausted, dead-end noise. Don't cherry-pick only the biggest.

Closedness over size: don't compress an in-progress plan, partial change, or unresolved thread just because it's a large stretch. Keep it raw, or write a richer summary that explicitly carries the in-progress state.

Prefer many small focused compressions over one giant one — better summary quality, lower latency. Batch independent non-overlapping ranges as separate entries in a single \`compress\` call.

Before compressing, ask: _"Could another agent continue safely from my summary plus the activity log?"_ If not, write more, or leave it raw.
`.trim();

/**
 * Used as the \`description\` field when registering the \`compress\` tool.
 *
 * Tool signature:
 *   {
 *     topic?: string           // optional default 3-5 word label
 *     ranges: Array<{
 *       startId: string        // m0001-style message ref or bN
 *       endId:   string        // m0001-style message ref or bN
 *       summary: string        // detailed technical handoff summary
 *       topic?: string         // per-block label; falls back to top-level topic
 *     }>
 *   }
 */
export const COMPRESS_RANGE_DESCRIPTION = `Collapse one or more conversation ranges into dense \`bN\` summaries.

INPUT
- \`ranges\`: [{ startId, endId, summary, topic? }, ...]; optional top-level \`topic\` is the default label.
- \`startId\`/\`endId\` are visible IDs from the transcript: \`mNNNN\` for messages, \`bN\` for prior compressed blocks. A message's ID lives in the XML metadata tag at the END of that message.
- \`startId\` must appear before \`endId\`. Do not invent IDs.
- Avoid ending inside the protected hot tail unless context is at hard emergency; the active DCP reminder names the tail start.
- Multiple independent non-overlapping ranges go in one call as separate entries.

SUMMARY CONTENT
A deterministic <activity-log> with file paths, line spans, edit counts, command status, and short excerpts is rendered next to your summary. Do not restate it.

Write what the log can't recover: user intent and success criteria, decisions made and rejected alternatives, current objective and next action, blockers/risks/assumptions, key constraints and invariants, non-obvious file/symbol/API relationships, open questions. Quote short user messages directly.

Do not compress active working memory — in-progress plans, partial changes, unresolved debugging, exact details still needed — unless your summary captures that state explicitly enough for another agent to continue.

NESTED \`bN\` PLACEHOLDERS
If the range includes prior \`bN\` blocks (marked with a \`[Compressed conversation section]\` header), reference each as \`(bN)\` exactly once in your summary. The tool expands \`(bN)\` to the full stored block content, so write the surrounding prose so it still reads correctly after expansion (no "as noted in \`(b2)\`"). To mention a block in plain prose, write \`compressed bN\` instead. Do not invent placeholders for blocks outside the range. Preflight: \`(bN)\` placeholders in the summary must equal the set of nested blocks, no duplicates.
`;

/**
 * Legacy nudge prompt text retained for compatibility with older imports.
 * Runtime DCP reminders now render compact planning hints inside <system-reminder>.
 */
export const CONTEXT_LIMIT_NUDGE_SOFT = ``;

/** Legacy strong context-limit nudge text. */
export const CONTEXT_LIMIT_NUDGE_STRONG = ``;

/** Legacy lightweight turn nudge text. */
export const TURN_NUDGE = ``;

/** Legacy iteration nudge text. */
export const ITERATION_NUDGE = ``;

/**
 * Replaces SYSTEM_PROMPT when manualMode.enabled = true.
 * The agent should NOT proactively compress — only compress when explicitly
 * requested by the user or when a context-limit nudge fires.
 */
export const MANUAL_MODE_SYSTEM_PROMPT = `
You are in DCP manual mode. Do not proactively compress — compression is user-directed.

DCP metadata tags are injected metadata. Do not output them.

Compress only when the user asks, or when a DCP nudge instructs you to (context-limit emergency). Never as background housekeeping.

When you do compress, the same quality bar applies: high-fidelity summaries (file paths, decisions, findings, constraints), preserve user intent precisely, use only visible IDs (\`mNNNN\` for messages, \`bN\` for blocks), batch independent ranges in one call. Leave active, still-needed context raw.
`.trim();
