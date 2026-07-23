import type { CompressionBlockMetadata } from "../../types/state.js";

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
    effectStats: {
      reads: 0,
      searches: 0,
      mutations: 0,
      commands: 0,
      delegations: 0,
    },
  };
}
