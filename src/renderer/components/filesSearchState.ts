import { isImeComposing, moveSelection } from '../../shared/channelCommands'
import type { FileGrepMatch, FileGrepResponse, FileSearchResponse, FileSearchResult } from '../../shared/types'

/** Quick open finds files by name; text search finds lines inside files. */
export type FilesSearchMode = 'files' | 'text'

export type FilesSearchOption = 'matchCase' | 'regex' | 'wholeWord'

export interface FilesSearchOptions {
  /** Off means smart case: case-sensitive only when the query has an uppercase letter. */
  matchCase: boolean
  regex: boolean
  wholeWord: boolean
}

export interface GrepGroup {
  path: string
  matches: FileGrepMatch[]
}

export const DEFAULT_TEXT_TIMEOUT_MS = 1_000
export const EXTENDED_TEXT_TIMEOUT_MS = 10_000
export const FILES_SEARCH_LIMIT = 50

/** What the last answer said besides its rows; the view turns it into notes. */
export interface FilesSearchMeta {
  fallbackReason?: FileSearchResponse['fallbackReason']
  /** The index hit its path cap (quick open) or a result limit cut the matches short (text). */
  truncated: boolean
  timedOut: boolean
  indexing: boolean
  regexError?: string
  skippedLongLines: number
  /** The time budget the answer ran under, text search only. */
  timeoutMs: number
  matchCount: number
  fileCount: number
}

export type FilesSearchStatus = 'idle' | 'loading' | 'indexing' | 'ready' | 'error' | 'needs-project'

export interface FilesSearchState {
  mode: FilesSearchMode
  query: string
  options: FilesSearchOptions
  /** Index of the selected row among `rows(state)`. */
  selected: number
  /** The id of the request whose answer is wanted; 0 when none is. Ids come from the caller and only grow. */
  request: number
  status: FilesSearchStatus
  /** The thread and project the rows belong to. */
  scopeKey: string
  /** The time budget the next text search runs under. */
  timeoutMs: number
  files: FileSearchResult[]
  groups: GrepGroup[]
  /** What the rows answer (`searchKey` at the time of the request); null while there are none. */
  resultsKey: string | null
  meta: FilesSearchMeta | null
  error: string | null
}

export function createFilesSearchState(mode: FilesSearchMode, scopeKey: string): FilesSearchState {
  return {
    mode,
    query: '',
    options: { matchCase: false, regex: false, wholeWord: false },
    selected: 0,
    request: 0,
    status: 'idle',
    scopeKey,
    timeoutMs: DEFAULT_TEXT_TIMEOUT_MS,
    files: [],
    groups: [],
    resultsKey: null,
    meta: null,
    error: null
  }
}

/** Identifies what a search asks, so rows can tell whether they still answer the box. */
export function searchKey(state: Pick<FilesSearchState, 'mode' | 'query' | 'options'>): string {
  if (state.mode === 'files') return `files\0${state.query}`
  const { matchCase, regex, wholeWord } = state.options
  return `text\0${state.query}\0${matchCase ? 1 : 0}${regex ? 1 : 0}${wholeWord ? 1 : 0}`
}

export type FilesSearchResult =
  | { mode: 'files'; response: FileSearchResponse }
  | { mode: 'text'; response: FileGrepResponse; timeoutMs: number }

export type FilesSearchAction =
  | { type: 'query'; query: string }
  | { type: 'mode'; mode: FilesSearchMode }
  | { type: 'toggle'; option: FilesSearchOption }
  | { type: 'select'; index: number }
  | { type: 'move'; key: string }
  | { type: 'request-started'; request: number; key: string }
  | { type: 'response'; request: number; scopeKey: string; key: string; result: FilesSearchResult }
  | { type: 'error'; request: number; scopeKey: string; message: string }
  | { type: 'needs-project' }
  | { type: 'keep-searching' }
  | { type: 'scope-changed'; scopeKey: string }

/** Matches grouped by file, files in path order and lines in line order. */
export function groupGrepMatches(matches: readonly FileGrepMatch[]): GrepGroup[] {
  const byPath = new Map<string, FileGrepMatch[]>()
  for (const match of matches) {
    const list = byPath.get(match.path)
    if (list) list.push(match)
    else byPath.set(match.path, [match])
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, list]) => ({
      path,
      matches: list.slice().sort((a, b) => a.line - b.line || a.column - b.column)
    }))
}

/** The selectable rows in display order. */
export function searchRows(state: Pick<FilesSearchState, 'mode' | 'files' | 'groups'>): Array<
  { kind: 'file'; result: FileSearchResult } | { kind: 'match'; match: FileGrepMatch }
> {
  if (state.mode === 'files') return state.files.map((result) => ({ kind: 'file' as const, result }))
  return state.groups.flatMap((group) => group.matches.map((match) => ({ kind: 'match' as const, match })))
}

function clearedRows(state: FilesSearchState): FilesSearchState {
  return { ...state, files: [], groups: [], resultsKey: null, meta: null, selected: 0 }
}

export function filesSearchReducer(state: FilesSearchState, action: FilesSearchAction): FilesSearchState {
  switch (action.type) {
    case 'query':
      // The rows stay until the answer arrives, but no longer answer the box (`rowsAreCurrent`).
      return action.query === state.query ? state : { ...state, query: action.query, selected: 0, error: null }
    case 'mode':
      if (action.mode === state.mode) return state
      return { ...clearedRows(state), mode: action.mode, request: 0, status: 'idle', error: null, timeoutMs: DEFAULT_TEXT_TIMEOUT_MS }
    case 'toggle':
      return { ...state, options: { ...state.options, [action.option]: !state.options[action.option] } }
    case 'select':
      return { ...state, selected: Math.max(0, Math.min(action.index, Math.max(0, searchRows(state).length - 1))) }
    case 'move':
      return { ...state, selected: moveSelection(state.selected, action.key, searchRows(state).length) }
    case 'request-started':
      return { ...state, request: action.request, status: 'loading', error: null }
    case 'response': {
      // An answer for an earlier request, another thread or another mode is not this box's.
      if (action.request !== state.request || action.scopeKey !== state.scopeKey || action.result.mode !== state.mode) return state
      const { result } = action
      if (result.mode === 'files') {
        const { response } = result
        return {
          ...state,
          files: response.results,
          groups: [],
          resultsKey: action.key,
          selected: 0,
          status: response.indexing ? 'indexing' : 'ready',
          error: null,
          meta: {
            fallbackReason: response.fallbackReason,
            truncated: response.truncated,
            timedOut: false,
            indexing: response.indexing,
            skippedLongLines: 0,
            timeoutMs: 0,
            matchCount: response.results.length,
            fileCount: response.results.length
          }
        }
      }
      const { response } = result
      return {
        ...state,
        files: [],
        groups: groupGrepMatches(response.matches),
        resultsKey: action.key,
        selected: 0,
        status: response.indexing ? 'indexing' : 'ready',
        error: null,
        meta: {
          fallbackReason: response.fallbackReason,
          truncated: response.truncated,
          timedOut: response.timedOut,
          indexing: response.indexing,
          regexError: response.regexError,
          skippedLongLines: response.skippedLongLines,
          timeoutMs: result.timeoutMs,
          matchCount: response.matches.length,
          fileCount: response.filesWithMatches
        }
      }
    }
    case 'error':
      if (action.request !== state.request || action.scopeKey !== state.scopeKey) return state
      return { ...clearedRows(state), status: 'error', error: action.message, request: 0 }
    case 'needs-project':
      return { ...clearedRows(state), status: 'needs-project', request: 0, error: null }
    case 'keep-searching':
      return { ...state, timeoutMs: EXTENDED_TEXT_TIMEOUT_MS }
    case 'scope-changed':
      if (action.scopeKey === state.scopeKey) return state
      return {
        ...clearedRows(state),
        scopeKey: action.scopeKey,
        request: 0,
        status: 'idle',
        error: null,
        timeoutMs: DEFAULT_TEXT_TIMEOUT_MS
      }
  }
}

/** Whether the rows answer what the box asks now. */
export function rowsAreCurrent(state: FilesSearchState): boolean {
  return state.resultsKey !== null && state.resultsKey === searchKey(state)
}

/**
 * What Enter does. Quick open opens the selected row only when the rows answer the box, so a row
 * from an earlier query is never opened. Text search runs the search, and opens a row once the
 * answer is in; while the index is still building, Enter searches again.
 */
export function enterAction(state: FilesSearchState): 'open' | 'search' | 'none' {
  const hasRow = rowsAreCurrent(state) && searchRows(state).length > 0
  if (state.mode === 'files') return hasRow && state.status !== 'error' ? 'open' : 'none'
  if (state.status === 'loading') return 'none'
  if (hasRow && state.status === 'ready') return 'open'
  return state.query === '' ? 'none' : 'search'
}

export type FilesSearchKeyAction =
  | { type: 'move'; key: string }
  | { type: 'enter' }
  | { type: 'close' }

const MOVE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'])

/** What a key in the search box does, or null to let the box have it. Home and End stay with the caret unless Ctrl/Cmd is held. */
export function filesSearchKeyAction(event: {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  keyCode?: number
}): FilesSearchKeyAction | null {
  if (isImeComposing(event)) return null
  const command = Boolean(event.ctrlKey || event.metaKey)
  if (event.key === 'Escape') return { type: 'close' }
  if (event.key === 'Enter') return event.shiftKey || event.altKey ? null : { type: 'enter' }
  if (event.altKey || event.shiftKey) return null
  if (MOVE_KEYS.has(event.key) && !command) return { type: 'move', key: event.key }
  if ((event.key === 'Home' || event.key === 'End') && command) return { type: 'move', key: event.key }
  return null
}

/** What the box asks of its owner: a reducer action, or a text search to run now. */
export type FilesSearchViewAction = FilesSearchAction | { type: 'submit' }

export interface FilesSearchHandlers {
  onAction: (action: FilesSearchViewAction) => void
  onOpenFile: (path: string) => void
  onOpenLine: (match: FileGrepMatch) => void
  onClose: () => void
}

/** Opens the row at `index`: a file for quick open, a file at the matched line for text search. */
export function openSearchRow(state: FilesSearchState, index: number, handlers: Pick<FilesSearchHandlers, 'onOpenFile' | 'onOpenLine'>): void {
  const row = searchRows(state)[index]
  if (!row) return
  if (row.kind === 'file') handlers.onOpenFile(row.result.path)
  else handlers.onOpenLine(row.match)
}

/** Carries out what a key in the box does. */
export function applySearchKey(action: FilesSearchKeyAction, state: FilesSearchState, handlers: FilesSearchHandlers): void {
  if (action.type === 'close') {
    handlers.onClose()
  } else if (action.type === 'move') {
    handlers.onAction({ type: 'move', key: action.key })
  } else {
    const what = enterAction(state)
    if (what === 'open') openSearchRow(state, state.selected, handlers)
    else if (what === 'search') handlers.onAction({ type: 'submit' })
  }
}

/** The `mousse:open-file` event detail that opens a match's file with the caret on its line and column (UTF-16, as Monaco counts). */
export function openLineDetail(
  match: Pick<FileGrepMatch, 'path' | 'line' | 'column'>,
  threadId: string | null
): { path: string; line: number; column: number; threadId: string | undefined } {
  return { path: match.path, line: match.line, column: match.column, threadId: threadId ?? undefined }
}

export interface SnippetParts {
  before: string
  match: string
  after: string
  /** The match length is unknown (a regular expression): mark the column instead of a range. */
  caret: boolean
}

const SNIPPET_LEAD = 48

/**
 * Splits a match's line into text before, the match and text after. `text` can be a window cut from a long
 * line, so the match starts at `column - 1 - snippetStart` in it. Indentation is dropped and a long lead is
 * cut to its last characters, so the match stays in view.
 */
export function snippetHighlight(match: Pick<FileGrepMatch, 'text' | 'column' | 'snippetStart' | 'matchLength'>): SnippetParts {
  const { text } = match
  const start = Math.max(0, Math.min(text.length, match.column - 1 - match.snippetStart))
  const length = match.matchLength
  const caret = length === null
  const end = length === null ? start : Math.min(text.length, start + Math.max(0, length))
  let before = text.slice(0, start).replace(/^\s+/, '')
  if (before.length > SNIPPET_LEAD) {
    let cut = before.length - SNIPPET_LEAD
    // Do not start on the second half of a surrogate pair.
    const unit = before.charCodeAt(cut)
    if (unit >= 0xdc00 && unit <= 0xdfff) cut += 1
    before = `…${before.slice(cut)}`
  }
  return { before, match: text.slice(start, end), after: text.slice(end), caret }
}

/** The path split into its folder (with the trailing slash) and file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf('/')
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}
