import { COMMANDS, commandAllowedInContext, type CommandContext, type CommandId } from '../../shared/commands'
import { visibleThreads } from '../../shared/threadLineage'
import { isThreadStarted } from '../../shared/threadTitle'
import type { Project, Thread } from '../../shared/types'
import { nextPaletteIndex } from '../hooks/useMenuKeyboard'
import { UNKNOWN_COMPUTER_NAME } from '../lib/computers'
import { groupProjects } from '../lib/projectGroups'
import { rankItems } from './paletteRank'

/** How many threads an empty query lists, newest first. */
export const RECENT_THREAD_COUNT = 8

export type PaletteItem =
  | { kind: 'command'; key: string; id: CommandId; title: string; detail: string; terms: string[] }
  | { kind: 'thread'; key: string; id: string; title: string; detail?: string }
  /** `threadId` is the project's newest listed thread; without one the palette starts a thread in the project. */
  | { kind: 'project'; key: string; id: string; title: string; detail: string; threadId?: string }

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
    detail: command.category,
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
}

/**
 * What the palette shows for a query. Commands first, then threads, then projects, each ranked by the
 * same matcher. An empty query lists every eligible command and the newest threads. A leading `>`
 * limits the list to commands. A thread or project on another computer names that computer; a project
 * that several computers hold for the same repository is one row, named as this computer's project is.
 */
export function buildPaletteGroups({ query, commands, threads, projects, computers }: PaletteInput): PaletteGroup[] {
  const commandsOnly = query.trimStart().startsWith('>')
  const text = commandsOnly ? query.trimStart().slice(1) : query
  const searching = text.trim() !== ''
  const groups: PaletteGroup[] = []

  const commandRows = rankItems(
    text,
    commands.map((item) => ({ item, title: item.title, terms: item.kind === 'command' ? item.terms : undefined }))
  ).map((row) => row.item)
  if (commandRows.length > 0) groups.push({ label: 'Commands', items: commandRows })
  if (commandsOnly) return groups

  const listed = listedThreads(threads)
  const { groups: projectGroups, groupOf } = groupProjects(projects)
  const groupById = new Map(projectGroups.map((group) => [group.id, group]))
  const computerName = (node: string): string => computers?.[node]?.name ?? UNKNOWN_COMPUTER_NAME
  const threadItem = (thread: Thread): PaletteItem => {
    const group = thread.projectId ? groupById.get(groupOf.get(thread.projectId) ?? '') : undefined
    const detail = [group?.project.name, thread.node ? computerName(thread.node) : undefined].filter(Boolean).join(' · ')
    return {
      kind: 'thread',
      key: `thread:${thread.id}`,
      id: thread.id,
      title: thread.name,
      detail: detail || undefined
    }
  }

  const threadRows = searching
    ? rankItems(text, listed.map((thread) => ({ thread, title: thread.name }))).map((row) => threadItem(row.thread))
    : [...listed].sort(byNewest).slice(0, RECENT_THREAD_COUNT).map(threadItem)
  if (threadRows.length > 0) groups.push({ label: 'Threads', items: threadRows })

  if (searching) {
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
  }
  return groups
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
