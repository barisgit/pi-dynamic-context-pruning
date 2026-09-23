// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — PI extension prompts
// ---------------------------------------------------------------------------
// Plain strings shared by the system prompt and compress tool registration.

/** Appended to the host system prompt when DCP is enabled. */
export const SYSTEM_PROMPT = `
Use \`compress\` proactively at settled work boundaries, not only when context is full. Compress reminder-listed stretches whose raw evidence is no longer needed; keep live work and the protected hot tail raw. Compression is housekeeping, not a reason to stop the task.

Block summaries are historical records. Preserve relevant intent, restrictions, corrections, and unresolved work at the close of each stretch. Later user corrections and evidence supersede earlier claims, including those quoted in conversation excerpts. Consolidate settled blocks into a distilled replacement, not an accumulation of old summaries; keep surviving permissions, corrections, verified outcomes, and unresolved work.

The automatic footer keeps bounded conversation excerpts, effect counts, and modified-file paths—not individual commands or results. Put consequential evidence in the summary. Do not copy DCP metadata into prose.
`.trim();

/** Description used by the compress tool; the schema carries field-level constraints. */
export const COMPRESS_RANGE_DESCRIPTION = `Replace selected conversation ranges with \`bN\` summaries.

Ranges: use existing, ordered \`mNNNN\` user/tool-result IDs or \`bN\` blocks. DCP includes complete assistant/tool groups automatically. Keep ranges coherent, independent, non-overlapping, and outside the protected hot tail.

Summary: write a past-tense record for an agent that cannot see the replaced messages. Preserve what continuation needs: user scope and permission boundaries, decisions and rationale, changes, exact technical references, consequential commands/results, and unresolved issues at the stretch's close. Distinguish verified facts from hypotheses, child reports from integrated acceptance, and failed/skipped checks from passes. State corrections explicitly. Preserve restrictions precisely; quote when paraphrasing could change their scope. Use readable prose with enough detail to avoid repeating work—not a progress diary, glued shorthand, or just 'see report'.

Covered blocks: write a new distilled summary rather than copying their records. A single block can be rewritten using the same \`bN\` as both boundaries. If the full prior record is genuinely needed, \`(bN)\` explicitly inserts that covered block once; otherwise omit placeholders. Uncovered, inactive, or repeated placeholders are invalid. For a plain reference without insertion, write \`compressed bN\`.
`;
