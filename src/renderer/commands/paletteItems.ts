import { COMMANDS, commandAllowedInContext, type CommandContext, type CommandId } from '../../shared/commands'
import { visibleThreads } from '../../shared/threadLineage'
import { isThreadStarted } from '../../shared/threadTitle'
import type { Project, Thread, ThreadSearchResult } from '../../shared/types'
import { nextPaletteIndex } from '../hooks/useMenuKeyboard'
import { UNKNOWN_COMPUTER_NAME } from '../lib/computers'
import { groupProjects } from '../lib/projectGroups'
import { rankItems } from './paletteRank'

/** How many threads an empty query lists, newest first. */
export const RECENT_THREAD_COUNT = 5
/** Typed characters before the palette also searches message text. */
export const MESSAGE_SEARCH_MIN_LENGTH = 2
/** Message hits a thread shows before its "+N more" row. */
export const MESSAGE_HITS_PER_THREAD = 3

export type PaletteItem =
  /** `category` is shown muted at the row's end, before the shortcut, once per run (`categoryLabels`). */
  | { kind: 'command'; key: string; id: CommandId; title: string; category: string; terms: string[] }
  | { kind: 'thread'; key: string; id: string; title: string; detail?: string }
  /** `threadId` is the project's newest listed thread; without one the palette starts a thread in the project. */
  | { kind: 'project'; key: string; id: string; title: string; detail: string; threadId?: string }
  /** A message hit: `id` is the message, `title` its snippet, `match` the text to mark in it. */
  | { kind: 'message'; key: string; id: string; threadId: string; title: string; match: string }
  /** Shows the rest of a thread's message hits in place. */
  | { kind: 'more'; key: string; threadId: string; title: string }

export interface PaletteGroup {
  label: string
  items: PaletteItem[]
}

/**
 * The commands the palette may offer: a handler is mounted and enabled, and the command's own rules
 * allow it when run from a palette row (no text field or terminal focus, the palette's overlay left out).
 * The palette toggle itself and display-only entries are never listed.
 */
export function eligibleCommands(ctx: CommandContext, isRegistered: (id: CommandId) => boolean): PaletteItem[] {
  return COMMANDS.filter(
    (command) => !command.fixed && command.id !== 'palette.open' && isRegistered(command.id) && commandAllowedInContext(command, ctx)
  ).map((command) => ({
    kind: 'command',
    key: `command:${command.id}`,
    id: command.id,
    title: command.title,
    category: command.category,
    terms: [command.category, ...(command.searchTerms ?? [])]
  }))
}

/** Threads the sidebar lists: started, not settled, and not a subagent shown under its parent. */
function listedThreads(threads: readonly Thread[]): Thread[] {
  return visibleThreads(threads).filter((thread) => !thread.settledAt && isThreadStarted(thread))
}

const byNewest = (a: Thread, b: Thread): number => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)

export interface PaletteInput {
  query: string
  /** Output of `eligibleCommands`. */
  commands: readonly PaletteItem[]
  threads: readonly Thread[]
  projects: readonly Project[]
  /** The names of the user's other computers by node, for the rows that are on one. */
  computers?: Readonly<Record<string, { name: string }>>
  /** Hits of the message search for this query (the palette searches once two characters are typed). */
  messages?: readonly ThreadSearchResult[]
  /** Threads whose message hits show in full, after their "+N more" row was chosen. */
  expanded?: ReadonlySet<string>
  /** The search stopped at its hit limit, so a thread may have more hits than were returned. */
  messagesCapped?: boolean
  /** `messages` puts the message hits first. */
  mode?: 'all' | 'messages'
}

/** The text to search messages for, or null: commands-only (`>`) and queries under two characters search none. */
export function messageQuery(query: string): string | null {
  const text = query.trim()
  return !text.startsWith('>') && text.length >= MESSAGE_SEARCH_MIN_LENGTH ? text : null
}

/**
 * What the palette shows for a query. An empty query lists the newest threads ("Recent"), then every
 * eligible command (in `messages` mode, the newest threads only). Typed text ranks commands, then threads, then projects with the same matcher, and
 * adds the message hits grouped by thread (first in `messages` mode); a thread that also matches by
 * title is listed once, with its hits under its Threads row. A leading `>` limits the list to
 * commands. A thread or project on another computer names that computer; a project that several
 * computers hold for the same repository is one row, named as this computer's project is.
 */
export function buildPaletteGroups({
  query,
  commands,
  threads,
  projects,
  computers,
  messages = [],
  expanded,
  messagesCapped = false,
  mode = 'all'
}: PaletteInput): PaletteGroup[] {
  const commandsOnly = query.trimStart().startsWith('>')
  const text = commandsOnly ? query.trimStart().slice(1) : query
  const searching = text.trim() !== ''
  const groups: PaletteGroup[] = []

  const commandRows = rankItems(
    text,
    commands.map((item) => ({ item, title: item.title, terms: item.kind === 'command' ? item.terms : undefined }))
  ).map((row) => row.item)
  const commandGroup: PaletteGroup | null = commandRows.length > 0 ? { label: 'Commands', items: commandRows } : null
  if (commandsOnly) return commandGroup ? [commandGroup] : []

  const listed = listedThreads(threads)
  const { groups: projectGroups, groupOf } = groupProjects(projects)
  const groupById = new Map(projectGroups.map((group) => [group.id, group]))
  const computerName = (node: string): string => computers?.[node]?.name ?? UNKNOWN_COMPUTER_NAME
  const where = (projectName: string | undefined, node: string | undefined): string | undefined =>
    [projectName, node ? computerName(node) : undefined].filter(Boolean).join(' · ') || undefined
  const threadItem = (thread: Thread): Extract<PaletteItem, { kind: 'thread' }> => {
    const group = thread.projectId ? groupById.get(groupOf.get(thread.projectId) ?? '') : undefined
    return {
      kind: 'thread',
      key: `thread:${thread.id}`,
      id: thread.id,
      title: thread.name,
      detail: where(group?.project.name, thread.node)
    }
  }

  if (!searching) {
    const recent = [...listed].sort(byNewest).slice(0, RECENT_THREAD_COUNT).map(threadItem)
    if (recent.length > 0) groups.push({ label: 'Recent', items: recent })
    // Search opens on threads alone; commands wait for typed text or a leading `>`.
    if (mode !== 'messages' && commandGroup) groups.push(commandGroup)
    return groups
  }

  const match = messageQuery(text)
  const hitsByThread = match ? groupMessageHits(messages) : new Map<string, ThreadSearchResult[]>()
  const hitRows = (threadId: string, hits: readonly ThreadSearchResult[]): PaletteItem[] =>
    messageHitRows(threadId, hits, match ?? '', expanded?.has(threadId) ?? false, messagesCapped)

  const threadRows = rankItems(text, listed.map((thread) => ({ thread, title: thread.name }))).map((row) => threadItem(row.thread))
  const titled = new Set(threadRows.map((row) => row.id))

  // Threads that match only by message text get their own header row in Messages.
  const messageItems: PaletteItem[] = []
  for (const [threadId, hits] of hitsByThread) {
    if (titled.has(threadId)) continue
    const first = hits[0]!
    messageItems.push(
      { kind: 'thread', key: `message-thread:${threadId}`, id: threadId, title: first.threadName, detail: where(first.projectName, first.node) },
      ...hitRows(threadId, hits)
    )
  }
  const messageGroup: PaletteGroup | null = messageItems.length > 0 ? { label: 'Messages', items: messageItems } : null
  if (mode === 'messages' && messageGroup) groups.push(messageGroup)
  if (mode !== 'messages' && commandGroup) groups.push(commandGroup)

  const threadItems = threadRows.flatMap((row) => {
    const hits = hitsByThread.get(row.id)
    return hits ? [row, ...hitRows(row.id, hits)] : [row]
  })
  if (threadItems.length > 0) groups.push({ label: 'Threads', items: threadItems })

  const projectRows = rankItems(
    text,
    projectGroups.map((group) => ({
      group,
      title: group.project.name,
      // The other computers' names for the same repository find it too.
      terms: group.members.slice(1).map((member) => member.name)
    }))
  ).map(({ group }): PaletteItem => {
    const project = group.project
    return {
      kind: 'project',
      key: `project:${group.id}`,
      id: project.id,
      title: project.name,
      // A project that is on another computer only says which.
      detail: project.node ? `Project · ${computerName(project.node)}` : 'Project',
      threadId: [...listed]
        .filter((thread) => thread.projectId && groupOf.get(thread.projectId) === group.id)
        .sort(byNewest)[0]?.id
    }
  })
  if (projectRows.length > 0) groups.push({ label: 'Projects', items: projectRows })

  if (mode !== 'messages' && messageGroup) groups.push(messageGroup)
  if (mode === 'messages' && commandGroup) groups.push(commandGroup)
  return groups
}

/** Message hits by thread, in the order the threads first appear (title and project matches are left out). */
function groupMessageHits(results: readonly ThreadSearchResult[]): Map<string, ThreadSearchResult[]> {
  const byThread = new Map<string, ThreadSearchResult[]>()
  for (const result of results) {
    if (result.matchType !== 'message' || !result.messageId || !result.snippet) continue
    const hits = byThread.get(result.threadId)
    if (hits) hits.push(result)
    else byThread.set(result.threadId, [result])
  }
  return byThread
}

/**
 * One thread's hit rows: newest first (the search returns them oldest first), stopping at three and a
 * "+N more" row unless the thread is expanded. When the search stopped at its limit the count is a
 * lower bound ("N+ more").
 */
function messageHitRows(
  threadId: string,
  hits: readonly ThreadSearchResult[],
  match: string,
  expanded: boolean,
  capped: boolean
): PaletteItem[] {
  const newest = [...hits].reverse()
  const shown = expanded ? newest : newest.slice(0, MESSAGE_HITS_PER_THREAD)
  const rows: PaletteItem[] = shown.map((hit) => ({
    kind: 'message',
    key: `message:${threadId}:${hit.messageId}`,
    id: hit.messageId!,
    threadId,
    title: hit.snippet!,
    match
  }))
  const rest = newest.length - shown.length
  if (rest > 0) rows.push({ kind: 'more', key: `more:${threadId}`, threadId, title: capped ? `${rest}+ more` : `+${rest} more` })
  return rows
}

/**
 * Splits `text` into runs and marks every case-insensitive occurrence of `match`, as the message
 * search matches (lower case, accents kept).
 */
export function markMatches(text: string, match: string): Array<{ text: string; match: boolean }> {
  const needle = match.toLowerCase()
  if (!needle) return [{ text, match: false }]
  const haystack = text.toLowerCase()
  const runs: Array<{ text: string; match: boolean }> = []
  let from = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) runs.push({ text: text.slice(from, at), match: false })
    runs.push({ text: text.slice(at, at + needle.length), match: true })
    from = at + needle.length
  }
  if (from < text.length) runs.push({ text: text.slice(from), match: false })
  return runs
}

/**
 * The category each row shows at its end: a command names its category only where a run of
 * same-category commands starts, so "Thread" is not repeated down the list. Other rows show none.
 */
export function categoryLabels(items: readonly PaletteItem[]): Array<string | undefined> {
  let previous: string | undefined
  return items.map((item) => {
    const category = item.kind === 'command' ? item.category : undefined
    const shown = category !== undefined && category !== previous ? category : undefined
    previous = category
    return shown
  })
}

export function flattenGroups(groups: readonly PaletteGroup[]): PaletteItem[] {
  return groups.flatMap((group) => group.items)
}

/** What a key press on the palette's input asks for. */
export type PaletteKeyAction = { type: 'move'; index: number } | { type: 'choose' } | { type: 'close' }

/**
 * Maps a key to a palette action. Enter and Escape are ignored while an input method is composing
 * text (`keyCode` 229 is the legacy signal for the same thing). Returns null for any other key.
 */
export function paletteKeyAction(
  event: { key: string; isComposing?: boolean; keyCode?: number },
  index: number,
  count: number
): PaletteKeyAction | null {
  if (event.isComposing || event.keyCode === 229) return null
  if (event.key === 'Escape') return { type: 'close' }
  if (event.key === 'Enter') return count > 0 ? { type: 'choose' } : null
  const next = nextPaletteIndex(event.key, index, count)
  return next === undefined ? null : { type: 'move', index: next }
}
