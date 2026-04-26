import type { CompressionBlock } from "../../types/state.js"
import type { DcpMessage } from "../../types/message.js"
import type { DcpProviderPayloadItem } from "../../types/api.js"

function getTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []

  return content.flatMap((part: any) => {
    if (!part || typeof part !== "object") return []
    if (typeof part.text === "string") return [part.text]
    return []
  })
}

export function extractMessageLikeText(message: DcpMessage): string {
  return getTextParts(message?.content).join("\n")
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function findLastVisibleMessageRef(text: string): string | null {
  let lastRef: string | null = null
  for (const match of text.matchAll(/<dcp-id>(m\d{3,4})<\/dcp-id>/gi)) {
    if (typeof match[1] === "string") lastRef = match[1].toLowerCase()
  }
  return lastRef
}

function findLastBlockOwnerKey(text: string): string | null {
  let lastOwner: string | null = null
  for (const match of text.matchAll(/<dcp-block-id>(b\d+)<\/dcp-block-id>/gi)) {
    if (typeof match[1] === "string") lastOwner = `block:${match[1].toLowerCase()}`
  }
  return lastOwner
}

export function extractCanonicalOwnerKeyFromMessageLike(
  message: DcpMessage,
  ownerByMessageRef: ReadonlyMap<string, string> = new Map(),
): string | null {
  const normalized = normalizeInlineWhitespace(extractMessageLikeText(message))
  if (!normalized) return null

  const blockOwner = findLastBlockOwnerKey(normalized)
  if (blockOwner) return blockOwner

  const messageRef = findLastVisibleMessageRef(normalized)
  return messageRef ? ownerByMessageRef.get(messageRef) ?? null : null
}

function isMessageLike(item: any): boolean {
  return typeof item?.role === "string"
}

function isMetadataOnlyMessageLike(item: any): boolean {
  const normalized = normalizeInlineWhitespace(extractMessageLikeText(item))
  if (!normalized) return false

  const stripped = normalized
    .replace(/<dcp-id>m\d{3,4}<\/dcp-id>/gi, "")
    .replace(/<dcp-owner>[^<]+<\/dcp-owner>/gi, "")
    .replace(/<dcp-block-id>b\d+<\/dcp-block-id>/gi, "")
    .trim()

  return stripped === "" && /<dcp-id>|<dcp-owner>|<dcp-block-id>/i.test(normalized)
}

function buildDirectOwnerKeys(input: any[], ownerByMessageRef: ReadonlyMap<string, string>): Array<string | null> {
  const owners = input.map((item) =>
    isMessageLike(item) ? extractCanonicalOwnerKeyFromMessageLike(item, ownerByMessageRef) : null,
  )

  for (let i = 0; i + 1 < input.length; i++) {
    const current = input[i]
    const next = input[i + 1]
    if (!isMessageLike(current) || !isMessageLike(next)) continue
    if (owners[i] !== null || owners[i + 1] === null) continue
    if (current.role !== next.role) continue
    if (!isMetadataOnlyMessageLike(next)) continue

    owners[i] = owners[i + 1]
  }

  return owners
}

function buildPreviousAssistantOwners(
  input: any[],
  directOwners: Array<string | null>,
): Array<string | null> {
  const owners: Array<string | null> = new Array(input.length).fill(null)
  let previousAssistantOwner: string | null = null

  for (let i = 0; i < input.length; i++) {
    const item = input[i]
    owners[i] = previousAssistantOwner

    if (!isMessageLike(item)) continue
    if (item.role === "user") {
      previousAssistantOwner = null
      continue
    }
    if (item.role === "assistant" && directOwners[i]) {
      previousAssistantOwner = directOwners[i]
    }
  }

  return owners
}

function buildNextAssistantOwners(
  input: any[],
  directOwners: Array<string | null>,
): Array<string | null> {
  const owners: Array<string | null> = new Array(input.length).fill(null)
  let nextAssistantOwner: string | null = null

  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i]
    owners[i] = nextAssistantOwner

    if (!isMessageLike(item)) continue
    if (item.role === "user") {
      nextAssistantOwner = null
      continue
    }
    if (item.role === "assistant" && directOwners[i]) {
      nextAssistantOwner = directOwners[i]
    }
  }

  return owners
}

type CompressArtifactBlock = Pick<CompressionBlock, "id" | "active" | "compressCallId" | "topic">

interface RepresentedCompressBlockReceipt {
  id: number
  topic: string
}

interface RepresentedCompressCallReceipt {
  callId: string
  blocks: RepresentedCompressBlockReceipt[]
  newestBlockId: number
}

interface RepresentedCompressArtifacts {
  byProviderCallId: Map<string, RepresentedCompressCallReceipt>
  newestReceipt: RepresentedCompressCallReceipt | null
}

function addProviderCallIdAliases(
  callIds: Map<string, RepresentedCompressCallReceipt>,
  callId: string,
  receipt: RepresentedCompressCallReceipt,
): void {
  callIds.set(callId, receipt)

  // Pi tool call ids can preserve both the provider call id and provider item id
  // as `${call_id}|${item_id}`. OpenAI Responses payload artifacts use only the
  // provider `call_id`, so represented-compress suppression must match both.
  const pipeIndex = callId.indexOf("|")
  if (pipeIndex > 0) {
    callIds.set(callId.slice(0, pipeIndex), receipt)
  }
}

function buildRepresentedCompressArtifacts(
  liveOwnerKeys: Set<string>,
  compressionBlocks: readonly CompressArtifactBlock[],
): RepresentedCompressArtifacts {
  const receiptsByStoredCallId = new Map<string, RepresentedCompressCallReceipt>()

  for (const block of compressionBlocks) {
    if (!block.active) continue
    if (typeof block.compressCallId !== "string") continue
    if (!liveOwnerKeys.has(`block:b${block.id}`)) continue

    const existing = receiptsByStoredCallId.get(block.compressCallId)
    const blockReceipt = {
      id: block.id,
      topic: typeof block.topic === "string" && block.topic.trim() ? block.topic : "untitled",
    }

    if (existing) {
      existing.blocks.push(blockReceipt)
      existing.newestBlockId = Math.max(existing.newestBlockId, block.id)
    } else {
      receiptsByStoredCallId.set(block.compressCallId, {
        callId: block.compressCallId,
        blocks: [blockReceipt],
        newestBlockId: block.id,
      })
    }
  }

  const byProviderCallId = new Map<string, RepresentedCompressCallReceipt>()
  let newestReceipt: RepresentedCompressCallReceipt | null = null

  for (const receipt of receiptsByStoredCallId.values()) {
    receipt.blocks.sort((a, b) => a.id - b.id)
    if (newestReceipt === null || receipt.newestBlockId > newestReceipt.newestBlockId) {
      newestReceipt = receipt
    }
    addProviderCallIdAliases(byProviderCallId, receipt.callId, receipt)
  }

  return { byProviderCallId, newestReceipt }
}

function getRepresentedCompressReceipt(
  item: any,
  representedCompressArtifacts: RepresentedCompressArtifacts,
): RepresentedCompressCallReceipt | null {
  if (representedCompressArtifacts.byProviderCallId.size === 0) return null
  if (typeof item?.call_id !== "string") return null

  if (item?.type === "function_call") {
    return item?.name === "compress" ? representedCompressArtifacts.byProviderCallId.get(item.call_id) ?? null : null
  }

  if (item?.type === "function_call_output") {
    return representedCompressArtifacts.byProviderCallId.get(item.call_id) ?? null
  }

  return null
}

function formatReceiptBlockList(receipt: RepresentedCompressCallReceipt): string {
  return receipt.blocks.map((block) => `b${block.id}: ${block.topic}`).join(", ")
}

function minifyNewestCompressArtifact(item: DcpProviderPayloadItem, receipt: RepresentedCompressCallReceipt): DcpProviderPayloadItem {
  const createdBlocks = receipt.blocks.map((block) => ({ id: `b${block.id}`, topic: block.topic }))

  if (item?.type === "function_call") {
    return {
      ...item,
      arguments: JSON.stringify({
        receiptOnly: true,
        status: "succeeded",
        createdBlocks,
        note: "Original compress arguments are represented by the created block(s). Previous visible message ids may now be stale.",
      }),
    }
  }

  if (item?.type === "function_call_output") {
    return {
      ...item,
      output: `Compression succeeded. Created ${formatReceiptBlockList(receipt)}.\nThis compact receipt is kept so you know your compress call just succeeded; the compressed content is represented by the live block(s).\nDo not call compress again in this assistant turn. If more compression is needed, wait for refreshed visible boundaries.`,
    }
  }

  return item
}

export function filterProviderPayloadInput(
  input: DcpProviderPayloadItem[],
  liveOwnerKeys: Iterable<string>,
  compressionBlocks: readonly CompressArtifactBlock[] = [],
  ownerByMessageRef: ReadonlyMap<string, string> = new Map(),
): DcpProviderPayloadItem[] {
  if (!Array.isArray(input)) return input

  const liveOwners = liveOwnerKeys instanceof Set ? liveOwnerKeys : new Set(liveOwnerKeys)
  if (liveOwners.size === 0) return input

  const directOwners = buildDirectOwnerKeys(input, ownerByMessageRef)
  const previousAssistantOwners = buildPreviousAssistantOwners(input, directOwners)
  const nextAssistantOwners = buildNextAssistantOwners(input, directOwners)
  const representedCompressArtifacts = buildRepresentedCompressArtifacts(liveOwners, compressionBlocks)
  const filtered: DcpProviderPayloadItem[] = []

  for (let index = 0; index < input.length; index++) {
    const item = input[index]
    const representedCompressReceipt = getRepresentedCompressReceipt(item, representedCompressArtifacts)

    if (representedCompressReceipt) {
      if (representedCompressReceipt === representedCompressArtifacts.newestReceipt) {
        filtered.push(minifyNewestCompressArtifact(item, representedCompressReceipt))
      }
      continue
    }

    if (isMessageLike(item)) {
      const owner = directOwners[index]
      if (owner === null || liveOwners.has(owner)) filtered.push(item)
      continue
    }

    if (item?.type === "reasoning") {
      const owner = nextAssistantOwners[index] ?? previousAssistantOwners[index]
      if (owner === null || liveOwners.has(owner)) filtered.push(item)
      continue
    }

    if (item?.type === "function_call" || item?.type === "function_call_output") {
      const owner = previousAssistantOwners[index] ?? nextAssistantOwners[index]
      if (owner === null || liveOwners.has(owner)) filtered.push(item)
      continue
    }

    filtered.push(item)
  }

  return filtered
}
