// ---------------------------------------------------------------------------
// Dynamic Context Pruning (DCP) — shared metadata text helpers
// ---------------------------------------------------------------------------

/** Strip visible DCP metadata tags while preserving surrounding user text. */
export function stripDcpMetadataTags(text: string): string {
  return text
    .replace(/<dcp-id>[^<]*<\/dcp-id>/g, " ")
    .replace(/<dcp-owner>[^<]*<\/dcp-owner>/g, " ")
    .replace(/<dcp-block-id>[^<]*<\/dcp-block-id>/g, " ")
    .replace(/<agent-summary>/g, " ")
    .replace(/<\/agent-summary>/g, " ")
    .replace(/<dcp-log\b[^>]*>/g, " ")
    .replace(/<\/dcp-log>/g, " ")
    .replace(/<dcp-system-reminder>/g, " ")
    .replace(/<\/dcp-system-reminder>/g, " ")
}
