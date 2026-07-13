import { resolveChannelCommand } from './registry'

export interface ParsedSlashCommand {
  name: string
  canonical: string
  args: string
  raw: string
}

/**
 * Parse inbound text as a channel slash command.
 * Returns null if not a slash command (doesn't start with /, or looks like a path).
 * Unknown commands still return a parse result with canonical = raw name.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const raw = text.trim()
  if (!raw.startsWith('/')) return null

  const match = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return null

  let name = match[1]!.slice(1).toLowerCase()
  if (!name) return null

  if (name.includes('@')) {
    name = name.split('@')[0]!
  }

  // Reject file paths: valid command names never contain /
  if (name.includes('/')) return null

  // Reject Windows drive paths like /C:... after the leading slash
  if (name.includes(':')) return null

  if (!name) return null

  const args = (match[2] ?? '')
    .replace(/\u2014\u2014/g, '--')
    .replace(/\u2014/g, '--')
    .replace(/\u2013/g, '-')

  const resolved = resolveChannelCommand(name)
  return {
    name,
    canonical: resolved?.name ?? name,
    args,
    raw
  }
}
