import type { Thread } from '../../shared/types'

/**
 * The sidebar's thread filter (`ThreadFilterBar`): which threads its Projects and Threads tabs list.
 *
 * - `show`: My threads (not kept out of the sidebar by the agent or bot that started them, `Thread.hidden`), Bot threads
 *   (those one of the owner's bots started, hidden or not), or All (hidden threads too).
 * - `botId`: only the threads that bot started, hidden or not, whatever `show` says.
 * - `projectId`: only the threads of that project group (`groupProjects`).
 * - `computerIds`: only the threads running on those computers (`LOCAL_COMPUTER_ID` for this computer, or node ids); empty keeps all.
 * - `archived`: the list holds archived threads instead of the others.
 * - `query`: each word must be in the thread's title, its project's name, its bot's name or its computer's name; or what
 *   is typed, as a whole, is in one of the thread's messages (`ThreadFilterContext.messageMatches`).
 */
export type ThreadShow = 'mine' | 'bots' | 'all'

/** The filter value for threads that run on this computer (`!thread.node`). */
export const LOCAL_COMPUTER_ID = 'local'

export interface ThreadFilter {
  query: string
  show: ThreadShow
  projectId: string | null
  botId: string | null
  computerIds: string[]
  archived: boolean
}

export const SHOW_LABELS: Record<ThreadShow, string> = { mine: 'My threads', bots: 'Bot threads', all: 'All' }

/** What a thread is matched against, besides its own fields. */
export interface ThreadFilterContext {
  /** The group a project belongs to (the project itself when it has no group). */
  groupOf(projectId: string): string
  projectName(projectId: string): string | undefined
  botName(botId: string): string | undefined
  /** The computer a thread runs on; omitted when only this computer is in use. */
  computerName?(node: string | undefined): string | undefined
  /** Threads with a message (one people typed, or an agent's reply) that holds the query; found by the service. */
  messageMatches?: ReadonlySet<string>
}

/** The query's words, lower case. */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Whether a thread is in the filter's scope; `archived` is not looked at (the lists split on it themselves). */
export function threadInFilter(thread: Thread, filter: ThreadFilter, context: ThreadFilterContext): boolean {
  const bot = thread.startedByBot
  if (filter.botId !== null) {
    if (bot?.botId !== filter.botId) return false
  } else if (filter.show === 'mine') {
    // A thread an agent or a bot keeps out of the sidebar is not listed, unless it is archived.
    if (thread.hidden && !thread.archivedAt) return false
  } else if (filter.show === 'bots' && !bot) {
    return false
  }
  if (filter.projectId !== null && (!thread.projectId || context.groupOf(thread.projectId) !== filter.projectId)) return false
  if (filter.computerIds.length > 0) {
    const computer = thread.node ?? LOCAL_COMPUTER_ID
    if (!filter.computerIds.includes(computer)) return false
  }
  const words = queryWords(filter.query)
  if (!words.length) return true
  const haystack = [
    thread.name,
    thread.projectId ? context.projectName(thread.projectId) : undefined,
    bot ? (context.botName(bot.botId) ?? bot.name) : undefined,
    context.computerName?.(thread.node)
  ].filter(Boolean).join('\n').toLowerCase()
  return words.every((word) => haystack.includes(word)) || context.messageMatches?.has(thread.id) === true
}

/** Whether anything narrows the list beyond the default (My threads, nothing typed). */
export function filterNarrows(filter: ThreadFilter): boolean {
  return filter.show !== 'mine' || filter.botId !== null || filter.projectId !== null || filter.computerIds.length > 0 || filter.archived || queryWords(filter.query).length > 0
}

export interface FilterOption {
  id: string
  name: string
  /** When its newest thread was updated (ISO), for "Recent". */
  lastUsed?: string
}

/** How many options "Recent" holds, and the shortest list that gets one. */
export const RECENT_OPTIONS = 3
const RECENT_FROM = 6

/**
 * A sub-list's options for what was typed in its search line: the most recently used first under "Recent" (when the list is
 * long enough to need it and nothing is typed), then the rest by name. Typed text keeps the names that contain it, those
 * that start with it first.
 */
export function orderOptions<T extends FilterOption>(options: readonly T[], search: string): { recent: T[]; rest: T[] } {
  const needle = search.trim().toLowerCase()
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  if (needle) {
    const matching = options.filter((option) => option.name.toLowerCase().includes(needle))
    const starts = (option: T) => (option.name.toLowerCase().startsWith(needle) ? 0 : 1)
    return { recent: [], rest: matching.sort((a, b) => starts(a) - starts(b) || byName(a, b)) }
  }
  if (options.length < RECENT_FROM) return { recent: [], rest: [...options].sort(byName) }
  const recent = options.filter((option) => option.lastUsed)
    .sort((a, b) => (b.lastUsed ?? '').localeCompare(a.lastUsed ?? ''))
    .slice(0, RECENT_OPTIONS)
  const shown = new Set(recent.map((option) => option.id))
  return { recent, rest: options.filter((option) => !shown.has(option.id)).sort(byName) }
}

export type FilterSuggestion = { kind: 'project' | 'bot' | 'computer'; id: string; name: string }

/** At most this many projects, bots, and computers are suggested above the list while typing. */
export const SUGGESTIONS_PER_KIND = 2

/**
 * The projects, bots and computers whose names hold the typed text, suggested above the list: picking one makes it a
 * filter. Not the one already filtered on.
 */
export function filterSuggestions(
  query: string,
  filter: ThreadFilter,
  projects: readonly FilterOption[],
  bots: readonly FilterOption[],
  computers: readonly FilterOption[] = []
): FilterSuggestion[] {
  if (!query.trim()) return []
  const pick = (kind: FilterSuggestion['kind'], options: readonly FilterOption[], selected: ReadonlySet<string>) =>
    orderOptions(options.filter((option) => !selected.has(option.id)), query).rest
      .slice(0, SUGGESTIONS_PER_KIND)
      .map((option): FilterSuggestion => ({ kind, id: option.id, name: option.name }))
  return [
    ...pick('project', projects, new Set(filter.projectId ? [filter.projectId] : [])),
    ...pick('bot', bots, new Set(filter.botId ? [filter.botId] : [])),
    ...pick('computer', computers, new Set(filter.computerIds))
  ]
}

/** The newest update of each key's threads (ISO), for "Recent". */
export function lastUsedBy(threads: readonly Thread[], keyOf: (thread: Thread) => string | undefined): Map<string, string> {
  const last = new Map<string, string>()
  for (const thread of threads) {
    const key = keyOf(thread)
    if (!key) continue
    const at = thread.updatedAt ?? thread.createdAt
    if (at && at > (last.get(key) ?? '')) last.set(key, at)
  }
  return last
}
