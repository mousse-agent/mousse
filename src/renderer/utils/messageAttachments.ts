export function truncateFileName(name: string, max = 24): string {
  if (name.length <= max) return name
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  const base = name.slice(0, name.length - ext.length)
  const keep = max - ext.length - 1
  return `${base.slice(0, Math.max(keep, 8))}…${ext}`
}

export function truncateLabel(text: string, max = 40): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, Math.max(max - 1, 1))}…`
}

/** Structured browser element extracted from a sent user message. */
export interface ParsedBrowserElement {
  url: string
  selector: string
  tagName: string
  role?: string
  ariaLabel?: string
  text?: string
  outerHTML?: string
}

export interface ParsedUserMessageContent {
  text: string
  attachedFiles: string[]
  browserElements: ParsedBrowserElement[]
}

const BROWSER_ELEMENT_BLOCK_RE =
  /\[Selected browser element\]\n([\s\S]*?)\n\[\/Selected browser element\]/g

/** Legacy blocks without a closing marker (best-effort). */
const BROWSER_ELEMENT_LEGACY_RE =
  /\[Selected browser element\]\n((?:URL:|Selector:|Element:|Accessible label:|Text:|HTML:)[\s\S]*?)(?=\n\n\[|\n\n(?![A-Za-z]+:)|\s*$)/g

function parseBrowserElementBody(body: string): ParsedBrowserElement | null {
  const lines = body.split('\n')
  let url = ''
  let selector = ''
  let tagName = ''
  let role: string | undefined
  let ariaLabel: string | undefined
  let text: string | undefined
  let outerHTML: string | undefined

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('URL: ')) {
      url = line.slice(5)
      i += 1
      continue
    }
    if (line.startsWith('Selector: ')) {
      selector = line.slice(10)
      i += 1
      continue
    }
    if (line.startsWith('Element: ')) {
      const rest = line.slice(9)
      const tagMatch = rest.match(/^<([^>\s]+)>/)
      if (tagMatch) tagName = tagMatch[1]
      const roleMatch = rest.match(/\brole="([^"]*)"/)
      if (roleMatch) role = roleMatch[1]
      i += 1
      continue
    }
    if (line.startsWith('Accessible label: ')) {
      ariaLabel = line.slice(18)
      i += 1
      continue
    }
    if (line.startsWith('Text: ')) {
      text = line.slice(6)
      i += 1
      continue
    }
    if (line.startsWith('HTML: ')) {
      // HTML may span remaining lines until the block ends.
      outerHTML = [line.slice(6), ...lines.slice(i + 1)].join('\n')
      break
    }
    i += 1
  }

  if (!tagName && !selector && !url) return null
  return {
    url,
    selector,
    tagName: tagName || 'element',
    role,
    ariaLabel,
    text,
    outerHTML
  }
}

export function formatBrowserElementBlock(element: {
  url: string
  selector: string
  tagName: string
  role?: string
  ariaLabel?: string
  text?: string
  outerHTML?: string
}): string {
  const lines = [
    '[Selected browser element]',
    `URL: ${element.url}`,
    `Selector: ${element.selector}`,
    `Element: <${element.tagName}>${element.role ? ` role="${element.role}"` : ''}`,
    element.ariaLabel ? `Accessible label: ${element.ariaLabel}` : '',
    element.text ? `Text: ${element.text}` : '',
    element.outerHTML ? `HTML: ${element.outerHTML}` : '',
    '[/Selected browser element]'
  ]
  return lines.filter(Boolean).join('\n')
}

export function browserElementLabel(element: Pick<ParsedBrowserElement, 'text' | 'ariaLabel' | 'tagName'>): string {
  return element.text?.trim() || element.ariaLabel?.trim() || `<${element.tagName}>`
}

export function parseUserMessageContent(content: string): ParsedUserMessageContent {
  const attachedFiles: string[] = []
  const browserElements: ParsedBrowserElement[] = []

  let text = content.replace(/\[Attached files: ([^\]]+)\]/g, (_match, list: string) => {
    for (const name of list.split(', ')) {
      const trimmed = name.trim()
      if (trimmed) attachedFiles.push(trimmed)
    }
    return ''
  })

  text = text.replace(/\[(?:Voice message \([^)]+\)(?:, )?)+\]/g, '')

  // Prefer closed blocks; fall back to legacy open-ended blocks.
  let hadClosedBlocks = false
  text = text.replace(BROWSER_ELEMENT_BLOCK_RE, (_match, body: string) => {
    hadClosedBlocks = true
    const parsed = parseBrowserElementBody(body)
    if (parsed) browserElements.push(parsed)
    return ''
  })

  if (!hadClosedBlocks) {
    text = text.replace(BROWSER_ELEMENT_LEGACY_RE, (_match, body: string) => {
      const parsed = parseBrowserElementBody(body)
      if (parsed) browserElements.push(parsed)
      return ''
    })
  }

  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return { text, attachedFiles, browserElements }
}
