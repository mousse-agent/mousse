// The one place the Changes tab reaches the daemon's selection and revert methods (`git.changes`,
// `git.include`, `git.revert`, `git.restoreReverted`, `git.revertedList`). They ship in their own PR;
// until the preload exposes them, `changesApiAvailable()` is false and the tab hides Include, Revert
// and the selection UI, and reads the uncommitted diff through `review.file` instead.
import type { GitScope } from '../../../shared/types'

export type IncludeState = 'yes' | 'no' | 'partial'

export interface ChangeLine {
  kind: ' ' | '-' | '+'
  text: string
  oldNo?: number
  newNo?: number
}

export interface ChangeHunk {
  /** Content hash of the hunk's removed and added lines plus its context. */
  id: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: ChangeLine[]
  /** Project folders: from the index; threads: from the held selection. */
  included: IncludeState
}

export type ChangedFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflict' | 'binary'

export interface ChangedFile {
  path: string
  oldPath?: string
  status: ChangedFileStatus
  /** Hash of HEAD blob + index entry + working-tree bytes for this path. */
  version: string
  hunks: ChangeHunk[]
  included: IncludeState
}

export interface ChangesResult {
  files: ChangedFile[]
  /** `untouched`: nothing chosen yet (empty index in a project folder, no held selection in a thread). */
  selection: 'untouched' | 'chosen'
  truncated: boolean
}

export interface LineChoice {
  hunk: string
  indexes: number[]
}

export type IncludeInput =
  | { path: string; version: string; hunks?: string[]; lines?: LineChoice[]; include: boolean }
  | { all: true; include: boolean }

export interface RevertInput {
  path: string
  version: string
  hunks?: string[]
  lines?: LineChoice[]
}

export interface RevertResult {
  revertId: string
  keptUntil: number
  file: ChangedFile | null
}

export type RestoreResult =
  | { restored: true }
  | { restored: false; reason: 'changed' | 'expired'; current?: string; kept?: string }

export interface RevertedEntry {
  revertId: string
  path: string
  at: number
  keptUntil: number
  summary: string
}

/** The errors these methods reject with, besides today's Git errors. */
export type ChangesErrorCode = 'stale' | 'turn_running' | 'not_a_repository' | 'conflict' | 'remote_offline'

interface ChangesBridge {
  changes: (scope: GitScope, options?: { paths?: string[] }) => Promise<ChangesResult>
  include: (scope: GitScope, input: IncludeInput) => Promise<ChangedFile | ChangesResult>
  revert: (scope: GitScope, input: RevertInput) => Promise<RevertResult>
  restoreReverted: (scope: GitScope, input: { revertId: string }) => Promise<RestoreResult>
  revertedList: (scope: GitScope) => Promise<RevertedEntry[]>
}

function bridge(): Partial<ChangesBridge> | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { mousse?: { git?: Partial<ChangesBridge> } }).mousse?.git
}

function method<K extends keyof ChangesBridge>(name: K): ChangesBridge[K] {
  const fn = bridge()?.[name]
  if (typeof fn !== 'function') throw Object.assign(new Error('Not available in this version'), { code: 'unavailable' })
  return fn as ChangesBridge[K]
}

/** True once the preload exposes the selection and revert methods. */
export function changesApiAvailable(): boolean {
  const git = bridge()
  return typeof git?.changes === 'function' && typeof git.include === 'function' && typeof git.revert === 'function'
}

/** True when kept copies of reverts can be listed and restored. Revert ships only with restore. */
export function restoreAvailable(): boolean {
  const git = bridge()
  return typeof git?.restoreReverted === 'function' && typeof git.revertedList === 'function'
}

export const changesApi = {
  changes: (scope: GitScope, options?: { paths?: string[] }) => method('changes')(scope, options),
  include: (scope: GitScope, input: IncludeInput) => method('include')(scope, input),
  revert: (scope: GitScope, input: RevertInput) => method('revert')(scope, input),
  restoreReverted: (scope: GitScope, revertId: string) => method('restoreReverted')(scope, { revertId }),
  revertedList: (scope: GitScope) => method('revertedList')(scope)
}

export function changesErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}
