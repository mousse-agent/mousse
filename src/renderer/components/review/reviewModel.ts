// Pure helpers for the Review surface. No Monaco or React imports, so tests can load it.
import { extractChatReferences } from '../../../shared/chatReferences'
import type { ReviewFileEntry, ReviewFileSide, ReviewFileStatus, ReviewScope } from '../../../shared/review'
import type { ChatMessage } from '../../../shared/types'
import type { ThreadAction } from '../../../shared/threadActions'

export type TreeNode =
  | { kind: 'folder'; name: string; path: string; children: TreeNode[] }
  | { kind: 'file'; name: string; path: string; entry: ReviewFileEntry }

interface MutableFolder {
  name: string
  path: string
  folders: Map<string, MutableFolder>
  files: TreeNode[]
}

const byName = (a: TreeNode, b: TreeNode) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

function finish(folder: MutableFolder): TreeNode[] {
  const children: TreeNode[] = []
  for (const sub of folder.folders.values()) {
    // A folder whose only child is another folder reads as `a/b/c`, as editors show it.
    let node = sub
    let name = sub.name
    while (node.files.length === 0 && node.folders.size === 1) {
      node = node.folders.values().next().value as MutableFolder
      name = `${name}/${node.name}`
    }
    children.push({ kind: 'folder', name, path: node.path, children: finish(node) })
  }
  children.sort(byName)
  return [...children, ...folder.files.sort(byName)]
}

/** Folders first, then files, each sorted by name. One pass over the list plus the sort per folder. */
export function buildFileTree(files: readonly ReviewFileEntry[]): TreeNode[] {
  const root: MutableFolder = { name: '', path: '', folders: new Map(), files: [] }
  for (const entry of files) {
    const parts = entry.path.split('/')
    const name = parts.pop() as string
    let folder = root
    for (const part of parts) {
      let next = folder.folders.get(part)
      if (!next) {
        next = { name: part, path: folder.path ? `${folder.path}/${part}` : part, folders: new Map(), files: [] }
        folder.folders.set(part, next)
      }
      folder = next
    }
    folder.files.push({ kind: 'file', name, path: entry.path, entry })
  }
  return finish(root)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * What to show instead of an editor for one side of a file, or null when the side has text to show.
 * A missing side is explained by the file's status: only an added file lacks an original side and only
 * a deleted one lacks a modified side.
 */
export function placeholderFor(side: ReviewFileSide, status: ReviewFileStatus): string | null {
  if (side === null) {
    if (status === 'deleted') return 'File deleted'
    if (status === 'added' || status === 'untracked') return 'File added'
    return 'Not available'
  }
  if ('binary' in side) return 'Binary file'
  if ('tooLarge' in side) {
    return side.reason === 'lines' && side.lines !== undefined
      ? `Too large to show (${side.lines.toLocaleString('en-US')} lines)`
      : `Too large to show (${formatBytes(side.size)})`
  }
  return null
}

export function isPlaceholderSide(side: ReviewFileSide): boolean {
  return side !== null && ('binary' in side || 'tooLarge' in side)
}

export interface TurnChoice {
  turnId: string
  label: string
  /** The turn was undone (or is being undone); its changes may no longer be in the working tree. */
  undone: boolean
  running: boolean
}

const UNDONE_STATES: ReadonlySet<ThreadAction['state']> = new Set(['undone', 'undoing', 'undo_conflict'])
const RUNNING_STATES: ReadonlySet<ThreadAction['state']> = new Set(['planned', 'running', 'checkpointing'])

function firstWords(text: string, maxWords = 6, maxChars = 40): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  let out = words.slice(0, maxWords).join(' ')
  const cut = words.length > maxWords
  if (out.length > maxChars) return `${out.slice(0, maxChars).trimEnd()}…`
  if (cut) out += '…'
  return out
}

function timeLabel(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * The turns the picker offers, newest first. Conversation-only actions never touched files. A running
 * action still has empty `changedPaths` and `commits` until its checkpoint, so it is listed regardless.
 */
export function turnChoices(
  actions: readonly ThreadAction[],
  messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'turnId' | 'content'>>
): TurnChoice[] {
  const prompts = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'user' && message.turnId && !prompts.has(message.turnId)) prompts.set(message.turnId, message.content)
  }
  const kept = actions.filter(
    (action) =>
      action.scope !== 'conversation' &&
      (RUNNING_STATES.has(action.state) || action.changedPaths.length > 0 || action.commits.length > 0)
  )
  const choices = kept.map((action, index) => {
    const running = RUNNING_STATES.has(action.state)
    const undone = UNDONE_STATES.has(action.state)
    const prompt = firstWords(extractChatReferences(prompts.get(action.turnId) ?? '').text) || `Turn ${index + 1}`
    const time = timeLabel(action.createdAt)
    const suffix = running ? ' (in progress)' : undone ? ' (undone)' : ''
    return { turnId: action.turnId, label: `${prompt}${time ? ` · ${time}` : ''}${suffix}`, undone, running, at: Date.parse(action.createdAt) || 0, index }
  })
  // Newest first; the original order breaks ties so equal timestamps keep their sequence.
  choices.sort((a, b) => b.at - a.at || b.index - a.index)
  return choices.map(({ turnId, label, undone, running }) => ({ turnId, label, undone, running }))
}

/** The picker's value for a scope: `worktree`, `thread` or `turn:<id>` (everything after the first colon). */
export function scopeOptionValue(scope: ReviewScope): string {
  if (scope.kind === 'worktree' && scope.staged) return 'worktree:staged'
  return scope.kind === 'turn' ? `turn:${scope.turnId}` : scope.kind
}

export function scopeFromOptionValue(value: string): ReviewScope {
  if (value.startsWith('turn:')) return { kind: 'turn', turnId: value.slice('turn:'.length) }
  if (value === 'worktree:staged') return { kind: 'worktree', staged: true }
  return value === 'thread' ? { kind: 'thread' } : { kind: 'worktree' }
}

export function scopeLabel(scope: ReviewScope, choices: readonly TurnChoice[]): string {
  if (scope.kind === 'thread') return 'Whole thread'
  if (scope.kind === 'worktree') return scope.staged ? 'Staged changes' : 'Working tree'
  return choices.find((choice) => choice.turnId === scope.turnId)?.label ?? 'Turn'
}

/** Monaco's `ILineChange`, without importing Monaco. An end of 0 means that side has no lines in the change. */
export interface LineChangeLike {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber: number
  modifiedEndLineNumber: number
}

/** "12 changed lines in view", counted by Monaco and so following the whitespace toggle. Null until Monaco has diffed. */
export function viewChangeLabel(lineChanges: readonly LineChangeLike[] | null | undefined): string | null {
  if (!lineChanges) return null
  let lines = 0
  for (const change of lineChanges) {
    const added = change.modifiedEndLineNumber === 0 ? 0 : change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1
    const removed = change.originalEndLineNumber === 0 ? 0 : change.originalEndLineNumber - change.originalStartLineNumber + 1
    lines += Math.max(added, removed)
  }
  if (lines === 0) return 'No changed lines in view'
  return `${lines.toLocaleString('en-US')} changed line${lines === 1 ? '' : 's'} in view`
}

export const STATUS_BADGES: Record<ReviewFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  typechange: 'T',
  untracked: 'U'
}

export function totalCounts(files: readonly ReviewFileEntry[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  return { additions, deletions }
}
