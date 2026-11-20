import type { Project } from '../../shared/types'

/** One project card in the New thread picker. */
export interface PickerCard {
  project: Project
  /** "This computer", or the name of the computer that holds the project. */
  computer: string
  /** The newest update of the project's threads (ISO); absent when it has none. */
  lastUsed?: string
  starred: boolean
  /** Why a thread cannot start there now; absent when it can. */
  unavailable?: 'Offline' | 'Not shared'
}

export interface PickerSections {
  starred: PickerCard[]
  recent: PickerCard[]
}

const byRecent = (a: PickerCard, b: PickerCard) =>
  (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '') ||
  b.project.createdAt.localeCompare(a.project.createdAt) ||
  a.project.name.localeCompare(b.project.name)

/**
 * A folder as its card shows it: a home folder on any computer (macOS, Linux or Windows) as "~", so the part that tells
 * projects apart fits. The shared folders beside the homes (/Users/Shared, C:\Users\Public) are nobody's home and stay.
 * The card's tooltip and the search keep the full path.
 */
export function shortPath(path: string): string {
  return path.replace(/^(?:\/Users\/(?!Shared(?:\/|$))[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\(?!Public(?:\\|$))[^\\]+)(?=[\\/]|$)/, '~')
}

/** Whether every word of the query is in the project's name, computer or folder. */
export function matchesQuery(card: PickerCard, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = `${card.project.name} ${card.computer} ${card.project.path}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/**
 * The picker's cards: starred projects (the sidebar's pinned ones) first, then the rest; each part newest used first,
 * never used last. Projects of every computer are listed, each on its own card.
 */
export function pickerSections(
  projects: readonly Project[],
  lastUsed: ReadonlyMap<string, string>,
  computerName: (node: string) => string,
  query: string
): PickerSections {
  const cards = projects
    .map((project): PickerCard => ({
      project,
      computer: project.node ? computerName(project.node) : 'This computer',
      lastUsed: lastUsed.get(project.id),
      starred: Boolean(project.pinnedAt),
      unavailable: project.offline ? 'Offline' : project.notShared ? 'Not shared' : undefined
    }))
    .filter((card) => matchesQuery(card, query))
    .sort(byRecent)
  return { starred: cards.filter((card) => card.starred), recent: cards.filter((card) => !card.starred) }
}

/** Where the highlight starts: the project last picked for a new thread when it is listed, else the first card. */
export function initialIndex(cards: readonly PickerCard[], rememberedProjectId: string | null): number {
  const index = rememberedProjectId ? cards.findIndex((card) => card.project.id === rememberedProjectId) : -1
  return Math.max(index, 0)
}

export type GridDirection = 'left' | 'right' | 'up' | 'down'

/**
 * Moves the highlight through sections laid out as grids of `columns`. Left and right step through the cards in order,
 * across sections. Up and down keep the column, landing on the nearest card of a shorter row and crossing into the
 * section above or below; at the first or last row of all, the highlight stays.
 */
export function gridMove(sizes: readonly number[], index: number, direction: GridDirection, columns: number): number {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total === 0) return 0
  if (direction === 'left') return Math.max(index - 1, 0)
  if (direction === 'right') return Math.min(index + 1, total - 1)
  let section = 0
  let start = 0
  while (section < sizes.length - 1 && index >= start + sizes[section]!) {
    start += sizes[section]!
    section += 1
  }
  const position = index - start
  const column = position % columns
  const size = sizes[section]!
  if (direction === 'down') {
    if (position + columns < size) return index + columns
    // A shorter last row below: its last card.
    const lastRowStart = Math.floor((size - 1) / columns) * columns
    if (position < lastRowStart) return start + size - 1
    let nextStart = start + size
    for (let next = section + 1; next < sizes.length; next += 1) {
      if (sizes[next]! > 0) return nextStart + Math.min(column, sizes[next]! - 1)
      nextStart += sizes[next]!
    }
    return index
  }
  if (position >= columns) return index - columns
  let previousEnd = start
  for (let previous = section - 1; previous >= 0; previous -= 1) {
    const previousSize = sizes[previous]!
    const previousStart = previousEnd - previousSize
    if (previousSize > 0) {
      const lastRowStart = Math.floor((previousSize - 1) / columns) * columns
      return previousStart + Math.min(lastRowStart + column, previousSize - 1)
    }
    previousEnd = previousStart
  }
  return index
}
