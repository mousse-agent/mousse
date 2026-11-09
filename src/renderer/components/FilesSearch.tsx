import { useCallback, useEffect, useReducer, useRef, type Ref, type RefObject } from 'react'
import { File, FileText, Search } from '../lib/icons'
import { ipcErrorLine } from '../lib/errorText'
import type { FileGrepMatch, FileSearchResponse } from '../../shared/types'
import { folderErrorText, pathInside } from '../utils/filesBrowse'
import { walkSearch, type WalkSearchProgress } from './filesWalkSearch'
import { MarkedText, splitMentionPath } from './ComposerSuggestionList'
import {
  FILES_SEARCH_LIMIT,
  EXTENDED_TEXT_TIMEOUT_MS,
  applySearchKey,
  createFilesSearchState,
  filesSearchKeyAction,
  filesSearchReducer,
  openSearchRow,
  rowsAreCurrent,
  searchKey,
  searchRows,
  snippetHighlight,
  splitPath,
  type FilesSearchHandlers,
  type FilesSearchMode,
  type FilesSearchOption,
  type FilesSearchState,
  type FilesSearchViewAction
} from './filesSearchState'

// ---------------------------------------------------------------------------------------------
// Notes: what the results say about the answer, in plain words
// ---------------------------------------------------------------------------------------------

export interface SearchNote {
  id: string
  tone: 'info' | 'warning' | 'error'
  text: string
  /** The daemon's own words, shown under the note. */
  detail?: string
  action?: 'keep-searching'
}

const GIT_REPOSITORY_NEEDED = /needs? a git repository/i

/** Every state of a search with text in it, as notes. Rows are drawn separately. */
export function searchNotes(state: FilesSearchState): SearchNote[] {
  if (state.status === 'needs-project') return [{ id: 'needs-project', tone: 'info', text: 'Text search needs a project folder' }]
  if (state.status === 'error') return [{ id: 'error', tone: 'error', text: state.error ?? 'Search failed' }]
  const notes: SearchNote[] = []
  const rowCount = searchRows(state).length
  const current = rowsAreCurrent(state)
  if (rowCount === 0 && state.mode === 'text' && state.query && (state.status === 'idle' || (state.status === 'ready' && !current))) {
    notes.push({ id: 'hint', tone: 'info', text: 'Press Enter to search' })
  }
  const meta = state.meta
  const searching = state.status === 'loading' || (current && Boolean(meta?.searching || (state.mode === 'files' && meta?.indexing)))
  if (searching && (rowCount === 0 || state.mode === 'files')) notes.push({ id: 'loading', tone: 'info', text: 'Searching…' })
  if (!meta || !current) return notes

  if (meta.indexing && state.mode === 'text') {
    notes.push({ id: 'indexing', tone: 'info', text: 'Index still building — press Enter to search again' })
  }
  if (meta.fallbackReason === 'git-missing') {
    notes.push({ id: 'git-missing', tone: 'warning', text: 'Git not found: ignore rules not applied' })
  } else if (meta.fallbackReason === 'git-too-old') {
    notes.push({ id: 'git-too-old', tone: 'warning', text: 'Git 2.19 or newer is needed for ignore rules' })
  }
  if (meta.regexError) {
    notes.push(
      GIT_REPOSITORY_NEEDED.test(meta.regexError)
        ? { id: 'regex', tone: 'warning', text: `${meta.regexError}. Searched literally.` }
        : { id: 'regex', tone: 'warning', text: 'Invalid pattern, searched literally', detail: meta.regexError }
    )
  }
  if (meta.truncated) {
    notes.push({
      id: 'truncated',
      tone: 'info',
      text: state.mode === 'files' ? `Showing first ${meta.matchCount}` : `Showing the first ${meta.matchCount} matches`
    })
  }
  if (meta.timedOut) {
    notes.push({
      id: 'timed-out',
      tone: 'warning',
      text: `Timed out after ${meta.timeoutMs / 1000} s`,
      action: meta.timeoutMs < EXTENDED_TEXT_TIMEOUT_MS ? 'keep-searching' : undefined
    })
  }
  if (meta.skippedLongLines > 0) {
    notes.push({
      id: 'long-lines',
      tone: 'info',
      text: meta.skippedLongLines === 1 ? '1 very long line was skipped' : `${meta.skippedLongLines} very long lines were skipped`
    })
  }
  if (rowCount === 0 && !meta.indexing && !meta.searching && !meta.timedOut && state.status === 'ready') {
    notes.push({ id: 'empty', tone: 'info', text: state.mode === 'files' ? 'No files match' : 'No matches' })
  }
  return notes
}

const rowId = (index: number) => `files-search-row-${index}`

// ---------------------------------------------------------------------------------------------
// The field: the header's search input
// ---------------------------------------------------------------------------------------------

const OPTION_LABELS: Array<{ option: FilesSearchOption; label: string; title: string }> = [
  { option: 'matchCase', label: 'Aa', title: 'Match case' },
  { option: 'regex', label: '.*', title: 'Regular expression' },
  { option: 'wholeWord', label: 'ab', title: 'Whole word' }
]

export interface FilesSearchFieldProps extends FilesSearchHandlers {
  state: FilesSearchState
  inputRef?: Ref<HTMLInputElement>
}

/** The search input that takes the header's title place: names as you type, or text in files on Enter. */
export function FilesSearchField({ state, onAction, onOpenFile, onOpenLine, onClose, inputRef }: FilesSearchFieldProps) {
  const rows = searchRows(state)
  const handlers = { onAction, onOpenFile, onOpenLine, onClose }
  const files = state.mode === 'files'
  return (
    <div className="files-search-field" role="search" data-mode={state.mode}>
      <button type="button" className="files-search-mode-toggle" tabIndex={-1}
        aria-label={files ? 'Search text in files instead' : 'Search file names instead'}
        title={files ? 'File names (Ctrl+P) · click for text in files (Ctrl+Shift+F)' : 'Text in files (Ctrl+Shift+F) · click for file names (Ctrl+P)'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onAction({ type: 'mode', mode: files ? 'text' : 'files' })}>
        {files ? <Search size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
      </button>
      <input
        ref={inputRef}
        className="files-search-input"
        type="text"
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls="files-search-results"
        aria-activedescendant={rows.length > 0 ? rowId(state.selected) : undefined}
        aria-label={files ? 'Find a file by name' : 'Search text in files'}
        placeholder={files ? 'Find a file' : 'Search in files'}
        spellCheck={false}
        autoComplete="off"
        value={state.query}
        onChange={(event) => onAction({ type: 'query', query: event.target.value })}
        onKeyDown={(event) => {
          const action = filesSearchKeyAction({
            key: event.key,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            isComposing: event.nativeEvent.isComposing,
            keyCode: event.keyCode
          })
          if (!action) return
          event.preventDefault()
          if (action.type === 'close') event.stopPropagation()
          applySearchKey(action, state, handlers)
        }}
      />
      {!files ? (
        <div className="files-search-options" role="group" aria-label="Search options">
          {OPTION_LABELS.map(({ option, label, title }) => (
            <button
              key={option}
              type="button"
              className={`files-search-option${state.options[option] ? ' active' : ''}`}
              aria-pressed={state.options[option]}
              aria-label={title}
              title={title}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onAction({ type: 'toggle', option })}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The results: drawn where the tree is
// ---------------------------------------------------------------------------------------------

export interface FilesSearchResultsProps extends Pick<FilesSearchHandlers, 'onAction' | 'onOpenFile' | 'onOpenLine'> {
  state: FilesSearchState
}

function SnippetText({ match }: { match: FileGrepMatch }) {
  const parts = snippetHighlight(match)
  return (
    <span className="files-search-snippet">
      {parts.before}
      {parts.caret ? <span className="files-search-caret" /> : <mark>{parts.match}</mark>}
      {parts.after}
    </span>
  )
}

/** Matching files listed flat (best first), or text matches grouped by file, with what the answer says. */
export function FilesSearchResults({ state, onAction, onOpenFile, onOpenLine }: FilesSearchResultsProps) {
  const rows = searchRows(state)
  const notes = searchNotes(state)
  const stale = rows.length > 0 && !rowsAreCurrent(state)
  const openRow = (index: number) => {
    onAction({ type: 'select', index })
    openSearchRow(state, index, { onOpenFile, onOpenLine })
  }
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [state.selected, state.files, state.groups])

  let rowIndex = -1
  return (
    <div className="files-search-results-host">
      {notes.length > 0 ? (
        <div className="files-search-notes" role="status">
          {notes.map((note) => (
            <div key={note.id} className={`files-search-note ${note.tone}`} data-note={note.id}>
              <span>{note.text}</span>
              {note.detail ? <span className="files-search-note-detail">{note.detail}</span> : null}
              {note.action === 'keep-searching' ? (
                <button type="button" className="btn btn-sm" onClick={() => onAction({ type: 'keep-searching' })}>
                  Keep searching
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div
        ref={listRef}
        id="files-search-results"
        className={`files-search-results scrollbar-ultra-thin${stale ? ' stale' : ''}`}
        role="listbox"
        aria-label={state.mode === 'files' ? 'Matching files' : 'Matching lines'}
      >
        {state.mode === 'files'
          ? state.files.map((result, index) => {
              const { name, dir } = splitMentionPath(result.path, result.positions)
              return (
                <button
                  key={result.path}
                  id={rowId(index)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === state.selected}
                  className={`files-search-row${index === state.selected ? ' selected' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => openRow(index)}
                  title={result.path}
                >
                  <File size={14} className="files-search-row-icon" />
                  <span className="files-search-row-name"><MarkedText segments={name} /></span>
                  {dir.length > 0 ? <span className="files-search-row-dir"><MarkedText segments={dir} /></span> : null}
                </button>
              )
            })
          : state.groups.map((group) => {
              const { dir, name } = splitPath(group.path)
              return (
                <div key={group.path} role="group" aria-label={group.path}>
                  <div className="files-search-group" title={group.path}>
                    <File size={14} className="files-search-row-icon" />
                    <span className="files-search-row-name">{name}</span>
                    {dir ? <span className="files-search-row-dir">{dir}</span> : null}
                    <span className="files-search-count">{group.matches.length}</span>
                  </div>
                  {group.matches.map((match) => {
                    rowIndex += 1
                    const index = rowIndex
                    return (
                      <button
                        key={`${match.line}:${match.column}`}
                        id={rowId(index)}
                        type="button"
                        role="option"
                        tabIndex={-1}
                        aria-selected={index === state.selected}
                        className={`files-search-row files-search-match${index === state.selected ? ' selected' : ''}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => openRow(index)}
                        title={`${group.path}:${match.line}:${match.column}`}
                      >
                        <span className="files-search-line">{match.line}</span>
                        <SnippetText match={match} />
                      </button>
                    )
                  })}
                </div>
              )
            })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The search's state and requests: the only place that calls the search methods
// ---------------------------------------------------------------------------------------------

const FILES_DEBOUNCE_MS = 120
const INDEXING_REQUERY_MS = 500
const TEXT_INDEXING_RETRY_MS = 1_000

export interface FilesSearchOpenRequest {
  mode: FilesSearchMode
  /** Changes each time the user asks for search, so asking again refocuses the field. */
  nonce: number
}

export interface UseFilesSearchOptions {
  open: boolean
  openRequest: FilesSearchOpenRequest
  /** The thread and project searched; a change drops the rows of the old one. */
  scopeKey: string
  projectId: string | null
  threadId: string | null
  /** The folder the path bar shows, which is the folder searched. */
  browseRoot: string
  /** Sent with each listing when that folder is not the thread's own (as the tree does). */
  listRoot?: string
  /** The folder the project's search index covers (the thread's folder), or null without a project. */
  indexRoot: string | null
}

/** The `files.search` answer for a folder inside the indexed one: only its files, still named from the index's root. */
function withinFolder(response: FileSearchResponse, prefix: string): FileSearchResponse {
  if (!prefix) return response
  const start = `${prefix}/`
  return { ...response, results: response.results.filter((result) => result.path.startsWith(start)) }
}

export interface FilesSearchController {
  state: FilesSearchState
  onAction: (action: FilesSearchViewAction) => void
  inputRef: RefObject<HTMLInputElement | null>
}

/** File names are searched as you type (after a short pause); text in files when Enter is pressed. */
export function useFilesSearch(options: UseFilesSearchOptions): FilesSearchController {
  const { open, openRequest, projectId, threadId, browseRoot, listRoot, indexRoot } = options
  // Rows belong to the thread and to the folder searched: another folder drops them.
  const scopeKey = `${options.scopeKey}|${browseRoot}`
  const [state, dispatch] = useReducer(filesSearchReducer, undefined, () => createFilesSearchState(openRequest.mode, scopeKey))
  const stateRef = useRef(state)
  stateRef.current = state
  const target = useRef({ scopeKey, projectId, threadId, browseRoot, listRoot, indexRoot })
  target.current = { scopeKey, projectId, threadId, browseRoot, listRoot, indexRoot }
  const requestSeq = useRef(0)
  const autoRetried = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const walk = useRef<AbortController | null>(null)

  const run = useCallback(async (snapshot: FilesSearchState) => {
    const { scopeKey: scope, projectId: project, threadId: thread, browseRoot: folder, listRoot: listFolder, indexRoot: indexed } = target.current
    walk.current?.abort()
    walk.current = null
    // The project's index covers the folder when it is the thread's folder or inside it; any other folder is walked.
    const prefix = project && indexed && folder ? pathInside(folder, indexed) : null
    if (snapshot.mode === 'text' && prefix === null) {
      dispatch({ type: 'needs-project' })
      return
    }
    const request = ++requestSeq.current
    const key = searchKey(snapshot)
    dispatch({ type: 'request-started', request, key })
    try {
      if (snapshot.mode === 'files' && prefix !== null) {
        const response = await window.mousse.fs.search(snapshot.query, { limit: FILES_SEARCH_LIMIT, kinds: ['file'] }, project!, thread)
        dispatch({ type: 'response', request, scopeKey: scope, key, result: { mode: 'files', response: withinFolder(response, prefix) } })
      } else if (snapshot.mode === 'files') {
        const controller = new AbortController()
        walk.current = controller
        const answer = (progress: WalkSearchProgress) => dispatch({
          type: 'response', request, scopeKey: scope, key,
          result: {
            mode: 'files',
            partial: !progress.done,
            response: {
              root: folder, source: null, results: progress.results, indexed: progress.results.length, indexedAt: null,
              truncated: progress.capped, indexing: false, complete: progress.done && !progress.capped
            }
          }
        })
        await walkSearch({
          query: snapshot.query,
          list: (dir) => window.mousse.fs.listDir(dir, undefined, thread, listFolder),
          signal: controller.signal,
          onProgress: answer
        })
        if (walk.current === controller) walk.current = null
      } else {
        const { options, timeoutMs } = snapshot
        const response = await window.mousse.fs.grep(
          snapshot.query,
          { regex: options.regex, caseSensitive: options.matchCase ? true : undefined, wholeWord: options.wholeWord, timeoutMs },
          project!,
          thread
        )
        dispatch({ type: 'response', request, scopeKey: scope, key, result: { mode: 'text', response, timeoutMs } })
      }
    } catch (error) {
      const line = ipcErrorLine(error) || 'Search failed'
      // A walked folder that cannot be read says why in a few words (a drive that does not answer, no access).
      dispatch({ type: 'error', request, scopeKey: scope, message: snapshot.mode === 'files' && prefix === null ? folderErrorText(line).text : line })
    }
  }, [])

  // A walk stops when search closes or the panel goes away.
  useEffect(() => () => walk.current?.abort(), [])

  const onAction = useCallback((action: FilesSearchViewAction) => {
    if (action.type === 'submit') {
      autoRetried.current = false
      void run(stateRef.current)
      return
    }
    if (action.type === 'keep-searching') {
      const next = filesSearchReducer(stateRef.current, action)
      dispatch(action)
      void run(next)
      return
    }
    dispatch(action)
    if (action.type === 'mode') inputRef.current?.focus()
  }, [run])

  // Asking for search, or asking again, picks the mode and focuses the field.
  useEffect(() => {
    if (!open) return
    dispatch({ type: 'mode', mode: openRequest.mode })
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, openRequest.mode, openRequest.nonce])

  // Leaving search empties it, so it starts afresh next time.
  useEffect(() => {
    if (!open) dispatch({ type: 'query', query: '' })
  }, [open])

  // Another thread or project: the rows are not its rows.
  useEffect(() => {
    dispatch({ type: 'scope-changed', scopeKey })
  }, [scopeKey])

  // File names are searched as you type, after a short pause; an empty field shows the tree instead.
  useEffect(() => {
    if (!open || state.mode !== 'files' || state.scopeKey !== scopeKey || !state.query.trim()) {
      walk.current?.abort()
      return
    }
    const timer = window.setTimeout(() => void run(stateRef.current), FILES_DEBOUNCE_MS)
    // A changed query stops the walk for the old one at once.
    return () => { window.clearTimeout(timer); walk.current?.abort() }
  }, [open, state.mode, state.query, state.scopeKey, scopeKey, projectId, threadId, listRoot, indexRoot, run])

  // While the index builds, ask again for a fuller answer.
  useEffect(() => {
    if (state.status !== 'indexing' || !state.query.trim()) return
    if (state.mode === 'text') {
      if (autoRetried.current) return
      const timer = window.setTimeout(() => {
        autoRetried.current = true
        void run(stateRef.current)
      }, TEXT_INDEXING_RETRY_MS)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => void run(stateRef.current), INDEXING_REQUERY_MS)
    return () => window.clearTimeout(timer)
  }, [state.status, state.request, state.mode, state.query, run])

  return { state, onAction, inputRef }
}
