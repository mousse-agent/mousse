export function truncateFileName(name: string, max = 24): string {
  if (name.length <= max) return name
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  const base = name.slice(0, name.length - ext.length)
  const keep = max - ext.length - 1
  return `${base.slice(0, Math.max(keep, 8))}…${ext}`
}

export interface ParsedUserMessageContent {
  text: string
  attachedFiles: string[]
}

export function parseUserMessageContent(content: string): ParsedUserMessageContent {
  const attachedFiles: string[] = []

  let text = content.replace(/\[Attached files: ([^\]]+)\]/g, (_match, list: string) => {
    for (const name of list.split(', ')) {
      const trimmed = name.trim()
      if (trimmed) attachedFiles.push(trimmed)
    }
    return ''
  })

  text = text.replace(/\[(?:Voice message \([^)]+\)(?:, )?)+\]/g, '')
  text = text.replace(/\n{3,}/g, '\n\n').trim()

  return { text, attachedFiles }
}
