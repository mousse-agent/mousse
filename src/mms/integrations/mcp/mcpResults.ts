import type { McpToolCallResult, McpToolContentBlock } from '../../../shared/integrations/results'
import type { IntegrationArtifactAdapter } from '../profileContext'
import { redactSensitiveText } from '../secrets'

const LEGACY_TEXT_LIMIT = 12_000
const INLINE_IMAGE_LIMIT = 100_000

export function mapMcpToolResult(args: {
  result: unknown
  provenance: McpToolCallResult['provenance']
  artifacts?: IntegrationArtifactAdapter
}): McpToolCallResult {
  const record = asRecord(args.result)
  const isError = record?.isError === true
  const structuredContent = record?.structuredContent
  const rawContent = Array.isArray(record?.content) ? record.content : []
  const content: McpToolContentBlock[] = []
  const artifacts: McpToolCallResult['artifacts'] = []

  for (const entry of rawContent) {
    const item = asRecord(entry)
    if (!item || typeof item.type !== 'string') continue
    if (item.type === 'text') {
      content.push({ type: 'text', text: redactSensitiveText(String(item.text ?? '')) })
      continue
    }
    if (item.type === 'image') {
      const mimeType = String(item.mimeType ?? 'application/octet-stream')
      const data = typeof item.data === 'string' ? item.data : undefined
      const bytes = data ? Buffer.byteLength(data, 'base64') : undefined
      content.push({
        type: 'image',
        mimeType,
        data: data && bytes && bytes <= INLINE_IMAGE_LIMIT ? data : undefined,
        bytes
      })
      continue
    }
    if (item.type === 'resource_link') {
      content.push({
        type: 'resource_link',
        uri: String(item.uri ?? ''),
        name: optionalString(item.name),
        mimeType: optionalString(item.mimeType),
        description: optionalString(item.description)
      })
      continue
    }
    if (item.type === 'resource') {
      const resource = asRecord(item.resource) ?? item
      content.push({
        type: 'resource',
        uri: optionalString(resource.uri),
        text: optionalString(resource.text),
        mimeType: optionalString(resource.mimeType),
        blob: optionalString(resource.blob)
      })
      continue
    }
    content.push({
      type: 'unknown',
      rawType: item.type,
      summary: `${item.type} content omitted from text flattening`
    })
  }

  const text = buildLegacyText(content, structuredContent, isError)
  return {
    text,
    isError,
    content,
    structuredContent,
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    provenance: args.provenance
  }
}

function buildLegacyText(
  content: McpToolContentBlock[],
  structuredContent: unknown,
  isError: boolean
): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'image') {
      parts.push(`[image ${block.mimeType}${block.bytes ? `, ${block.bytes} bytes` : ''}]`)
      continue
    }
    if (block.type === 'resource_link') {
      parts.push(`[resource ${block.uri}]`)
      continue
    }
    if (block.type === 'resource') {
      parts.push(block.text ?? `[resource ${block.uri ?? 'untyped'}]`)
      continue
    }
    parts.push(`[${block.rawType}]`)
  }
  if (parts.length === 0 && structuredContent !== undefined) {
    parts.push(truncate(JSON.stringify(structuredContent)))
  }
  const joined = parts.filter(Boolean).join('\n')
  const text = joined || (isError ? 'MCP tool returned an error with no text content.' : '')
  return truncate(text)
}

function truncate(value: string): string {
  return value.length > LEGACY_TEXT_LIMIT ? `${value.slice(0, LEGACY_TEXT_LIMIT)}\n...[truncated]` : value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
