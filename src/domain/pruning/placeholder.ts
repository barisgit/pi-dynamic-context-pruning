/** Model-visible replacement for masked output; never advertises an unavailable recovery tool. */
export const HIDDEN_OUTPUT_PLACEHOLDER =
  "[Output hidden to save context; re-run if needed and safe to repeat.]";

/** Preserve legacy head/tail projections without exposing internal pruning identities. */
export function hiddenLinesPlaceholder(count: number): string {
  return `[... ${count} lines hidden to save context; re-run if needed and safe to repeat. ...]`;
}
