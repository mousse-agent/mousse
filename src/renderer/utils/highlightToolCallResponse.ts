import hljs from 'highlight.js/lib/core'
import json from 'highlight.js/lib/languages/json'
import plaintext from 'highlight.js/lib/languages/plaintext'

hljs.registerLanguage('json', json)
hljs.registerLanguage('plaintext', plaintext)

export function highlightToolCallResponse(text: string): { html: string; language: string } {
  const trimmed = text.trim()
  if (!trimmed) {
    return { html: '', language: 'plaintext' }
  }

  try {
    JSON.parse(trimmed)
    const result = hljs.highlight(trimmed, { language: 'json' })
    return { html: result.value, language: 'json' }
  } catch {
    const result = hljs.highlight(trimmed, { language: 'plaintext' })
    return { html: result.value, language: 'plaintext' }
  }
}

export function resolveToolCallResponse(toolCall: {
  response?: string
  details: string[]
}): string | undefined {
  if (toolCall.response?.trim()) return toolCall.response

  // Backward compat: older messages stored tool output as a single detail entry.
  if (toolCall.details.length === 1) {
    const [detail] = toolCall.details
    if (detail.startsWith('Server:') || detail.startsWith('Tool:')) return undefined
    return detail
  }

  return undefined
}
