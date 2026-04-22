function getTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []

  return content.flatMap((part: any) => {
    if (!part || typeof part !== "object") return []
    if (typeof part.text === "string") return [part.text]
    return []
  })
}

export function extractMessageLikeText(message: any): string {
  return getTextParts(message?.content).join("\n")
}

function normalizeInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function extractVisibleOwnerKeyFromMessageLike(message: any): string | null {
  const normalized = normalizeInlineWhitespace(extractMessageLikeText(message))
  if (!normalized) return null

  const blockMatch = normalized.match(/<dcp-block-id>(b\d+)<\/dcp-block-id>/)
  if (blockMatch) return `block:${blockMatch[1]}`

  const messageMatch = normalized.match(/<dcp-id>(m\d+)<\/dcp-id>/)
  if (messageMatch) return `msg:${messageMatch[1]}`

  return null
}

function isMessageLike(item: any): boolean {
  return typeof item?.role === "string"
}

function isIdOnlyMessageLike(item: any): boolean {
  const normalized = normalizeInlineWhitespace(extractMessageLikeText(item))
  if (!normalized) return false

  return /^<dcp-id>m\d+<\/dcp-id>$/.test(normalized)
}

function buildRenderedOwnerSet(messages: any[]): Set<string> {
  const keys = new Set<string>()
  for (const message of messages) {
    const key = extractVisibleOwnerKeyFromMessageLike(message)
    if (key) keys.add(key)
  }
  return keys
}

function buildDirectOwnerKeys(input: any[]): Array<string | null> {
  const owners = input.map((item) =>
    isMessageLike(item) ? extractVisibleOwnerKeyFromMessageLike(item) : null,
  )

  for (let i = 0; i + 1 < input.length; i++) {
    const current = input[i]
    const next = input[i + 1]
    if (!isMessageLike(current) || !isMessageLike(next)) continue
    if (owners[i] !== null || owners[i + 1] === null) continue
    if (current.role !== next.role) continue
    if (!isIdOnlyMessageLike(next)) continue

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

export function filterProviderPayloadInput(input: any[], renderedMessages: any[]): any[] {
  if (!Array.isArray(input) || renderedMessages.length === 0) return input

  const renderedOwners = buildRenderedOwnerSet(renderedMessages)
  if (renderedOwners.size === 0) return input

  const directOwners = buildDirectOwnerKeys(input)
  const previousAssistantOwners = buildPreviousAssistantOwners(input, directOwners)
  const nextAssistantOwners = buildNextAssistantOwners(input, directOwners)

  return input.filter((item, index) => {
    if (isMessageLike(item)) {
      const owner = directOwners[index]
      return owner === null ? true : renderedOwners.has(owner)
    }

    if (item?.type === "reasoning") {
      const owner = nextAssistantOwners[index] ?? previousAssistantOwners[index]
      return owner === null ? true : renderedOwners.has(owner)
    }

    if (item?.type === "function_call" || item?.type === "function_call_output") {
      const owner = previousAssistantOwners[index] ?? nextAssistantOwners[index]
      return owner === null ? true : renderedOwners.has(owner)
    }

    return true
  })
}
