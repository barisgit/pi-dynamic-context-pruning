import type { CompressionBlockMetadata } from "../../types/state.js"

/** Create empty hidden metadata for a compressed block. */
export function createEmptyCompressionBlockMetadata(): CompressionBlockMetadata {
  return {
    coveredSourceKeys: [],
    coveredSpanKeys: [],
    coveredArtifactRefs: [],
    coveredToolIds: [],
    supersededBlockIds: [],
    fileReadStats: [],
    fileWriteStats: [],
    commandStats: [],
  }
}
