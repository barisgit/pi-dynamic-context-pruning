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

const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi
const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi
const OWNER_PARAMETER_REGEX = /<parameter\s+name=["']owner["'][^>]*>[\s\S]*?<\/parameter>/gi

/** Strip generated DCP/protocol metadata hallucinations from assistant/tool output text. */
export function stripDcpHallucinationsFromString(text: string): string {
  return text
    .replace(DCP_PAIRED_TAG_REGEX, "")
    .replace(DCP_UNPAIRED_TAG_REGEX, "")
    .replace(OWNER_PARAMETER_REGEX, "")
}
