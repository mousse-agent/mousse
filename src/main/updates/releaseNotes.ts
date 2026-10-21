import type { UpdateReleaseNote } from '../../shared/updates'

const MAX_RELEASES = 6
const MAX_ITEMS = 8
const MAX_ITEM_CHARS = 220

/** What electron-updater reports: one release's HTML, or every newer release's with `fullChangelog`. */
export type RawReleaseNotes = string | ReadonlyArray<{ version: string; note: string | null }> | null | undefined

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

function toText(html: string): string {
  const text = decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g, '#$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS - 1).trimEnd()}…` : text
}

const SKIPPED_ITEM = /^(what'?s changed|full changelog|new contributors)\b/i

/** The change items of one release's notes: list items when there are any, else non-empty lines. */
export function releaseNoteItems(note: string | null | undefined): string[] {
  if (!note) return []
  // GitHub's generated notes end with "New Contributors" and "Full Changelog"; neither is a change.
  const body = note.split(/<h\d[^>]*>\s*New Contributors/i)[0]!
  const listItems = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => match[1]!)
  const parts = listItems.length > 0
    ? listItems
    : body.split(/<\/?(?:p|div|h\d|ul|ol)[^>]*>|<br\s*\/?>|\n/i)
      .map((line) => line.replace(/^\s*(?:[*-]|#{1,6})\s+/, '').replace(/\*\*|__/g, ''))
  return parts.map(toText).filter((item) => item.length > 0 && !SKIPPED_ITEM.test(item))
}

/**
 * Release notes for the update popover: newest release first, at most 6 releases of at most 8
 * items each. Truncated items and releases stay reachable through each release's page.
 */
export function normalizeReleaseNotes(
  raw: RawReleaseNotes,
  latestVersion: string,
  repositoryUrl: string
): { releaseNotes: UpdateReleaseNote[]; omittedReleaseCount: number } {
  const groups = typeof raw === 'string' ? [{ version: latestVersion, note: raw }] : [...(raw ?? [])]
  const releaseNotes: UpdateReleaseNote[] = []
  for (const group of groups.slice(0, MAX_RELEASES)) {
    const items = releaseNoteItems(group.note)
    releaseNotes.push({
      version: group.version,
      items: items.slice(0, MAX_ITEMS),
      totalItems: items.length,
      url: `${repositoryUrl}/releases/tag/v${group.version}`
    })
  }
  return { releaseNotes, omittedReleaseCount: Math.max(0, groups.length - MAX_RELEASES) }
}
