import { useCallback, useEffect, useReducer, useRef, type Ref } from 'react'
import { File, Search, X } from '../lib/icons'
import { ipcErrorLine } from '../lib/errorText'
import type { FileGrepMatch } from '../../shared/types'
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
// Notes: what the box says about the answer, in plain words
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

/** Every state the box can be in, as notes. Rows are drawn separately. */
export function searchNotes(state: FilesSearchState): SearchNote[] {
  if (state.status === 'needs-project') return [{ id: 'needs-project', tone: 'info', text: 'Search needs a project' }]
  if (state.status === 'error') return [{ id: 'error', tone: 'error', text: state.error ?? 'Search failed' }]
  const notes: SearchNote[] = []
  const rowCount = searchRows(state).length
  const current = rowsAreCurrent(state)
  if (rowCount === 0 && (state.status === 'idle' || (state.status === 'ready' && !current))) {
    notes.push({
      id: 'hint',
      tone: 'info',
      text: state.mode === 'files' ? 'Type to find a file by name' : 'Type a word or phrase, then press Enter'
    })
  }
  if (rowCount === 0 && state.status === 'loading') notes.push({ id: 'loading', tone: 'info', text: 'Searching…' })
  const meta = state.meta
  if (!meta || !current) return notes

  if (meta.indexing) {
    notes.push({
      id: 'indexing',
      tone: 'info',
      text: state.mode === 'files' ? 'Indexing… results so far' : 'Index still building — press Enter to search again'
    })
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
      text:
        state.mode === 'files'
          ? 'Large project: showing the first matches, keep typing'
          : `Showing the first ${meta.matchCount} matches`
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
  if (rowCount === 0 && !meta.indexing && !meta.timedOut && state.status === 'ready') {
    notes.push({ id: 'empty', tone: 'info', text: state.mode === 'files' ? 'No files match' : 'No matches' })
  }
  return notes
}

// ---------------------------------------------------------------------------------------------
// View: pure rendering of a state
// ---------------------------------------------------------------------------------------------

export interface FilesSearchViewProps extends FilesSearchHandlers {
  state: FilesSearchState
  inputRef?: Ref<HTMLInputElement>
}

const OPTION_LABELS: Array<{ option: FilesSearchOption; label: string; title: string }> = [
  { option: 'matchCase', label: 'Aa', title: 'Match case' },
  { option: 'regex', label: '.*', title: 'Regular expression' },
  { option: 'wholeWord', label: 'ab', title: 'Whole word' }
]

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

export function FilesSearchView({ state, onAction, onOpenFile, onOpenLine, onClose, inputRef }: FilesSearchViewProps) {
  const rows = searchRows(state)
  const notes = searchNotes(state)
  const stale = rows.length > 0 && !rowsAreCurrent(state)
  const rowId = (index: number) => `files-search-row-${index}`

  const handlers = { onAction, onOpenFile, onOpenLine, onClose }
  const openRow = (index: number) => openSearchRow(state, index, handlers)

  let rowIndex = -1
  return (
    <div className="files-search" role="search" data-mode={state.mode}>
      <div className="files-search-bar">
        <div className="files-search-modes" role="group" aria-label="Search mode">
          {(['files', 'text'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`btn btn-ghost btn-sm files-search-mode${state.mode === mode ? ' active' : ''}`}
              aria-pressed={state.mode === mode}
              onClick={() => onAction({ type: 'mode', mode })}
            >
              {mode === 'files' ? 'Files' : 'Text'}
            </button>
          ))}
          <button type="button" className="btn btn-ghost btn-sm files-search-close" aria-label="Close search" title="Close search" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="files-search-field">
          <Search size={14} className="files-search-field-icon" />
          <input
            ref={inputRef}
            className="files-search-input"
            type="text"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="files-search-results"
            aria-activedescendant={rows.length > 0 ? rowId(state.selected) : undefined}
            aria-label={state.mode === 'files' ? 'Find a file by name' : 'Search in files'}
            placeholder={state.mode === 'files' ? 'Find a file by name' : 'Search text in files'}
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
          {state.mode === 'text' ? (
            <div className="files-search-options" role="group" aria-label="Search options">
              {OPTION_LABELS.map(({ option, label, title }) => (
                <button
                  key={option}
                  type="button"
                  className={`files-search-option${state.options[option] ? ' active' : ''}`}
                  aria-pressed={state.options[option]}
                  aria-label={title}
                  title={title}
                  onClick={() => onAction({ type: 'toggle', option })}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
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
                  aria-selected={index === state.selected}
                  className={`files-search-row${index === state.selected ? ' selected' : ''}`}
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
                        aria-selected={index === state.selected}
                        className={`files-search-row files-search-match${index === state.selected ? ' selected' : ''}`}
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
// Stateful wrapper: the only place that calls the search methods
// ---------------------------------------------------------------------------------------------

const FILES_DEBOUNCE_MS = 120
const INDEXING_REQUERY_MS = 500
const TEXT_INDEXING_RETRY_MS = 1_000

export interface FilesSearchOpenRequest {
  mode: FilesSearchMode
  /** Changes each time the user asks to open the box, so asking again refocuses it. */
  nonce: number
}

export interface FilesSearchProps {
  openRequest: FilesSearchOpenRequest
  /** The thread and project the box searches; a change drops the rows of the old one. */
  scopeKey: string
  projectId: string | null
  threadId: string | null
  /** `closeAfter` is true for quick open, which is done once a file is picked. */
  onOpenFile: (path: string, closeAfter: boolean) => void
  onOpenLine: (match: FileGrepMatch) => void
  onClose: () => void
}

export function FilesSearch({ openRequest, scopeKey, projectId, threadId, onOpenFile, onOpenLine, onClose }: FilesSearchProps) {
  const [state, dispatch] = useReducer(filesSearchReducer, undefined, () => createFilesSearchState(openRequest.mode, scopeKey))
  const stateRef = useRef(state)
  stateRef.current = state
  const target = useRef({ scopeKey, projectId, threadId })
  target.current = { scopeKey, projectId, threadId }
  const requestSeq = useRef(0)
  const autoRetried = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const run = useCallback(async (snapshot: FilesSearchState) => {
    const { scopeKey: scope, projectId: project, threadId: thread } = target.current
    if (!project) {
      dispatch({ type: 'needs-project' })
      return
    }
    const request = ++requestSeq.current
    const key = searchKey(snapshot)
    dispatch({ type: 'request-started', request, key })
    try {
      if (snapshot.mode === 'files') {
        const response = await window.mousse.fs.search(
          snapshot.query,
          { limit: FILES_SEARCH_LIMIT, kinds: ['file'] },
          project,
          thread
        )
        dispatch({ type: 'response', request, scopeKey: scope, key, result: { mode: 'files', response } })
      } else {
        const { options, timeoutMs } = snapshot
        const response = await window.mousse.fs.grep(
          snapshot.query,
          {
            regex: options.regex,
            caseSensitive: options.matchCase ? true : undefined,
            wholeWord: options.wholeWord,
            timeoutMs
          },
          project,
          thread
        )
        dispatch({ type: 'response', request, scopeKey: scope, key, result: { mode: 'text', response, timeoutMs } })
      }
    } catch (error) {
      dispatch({ type: 'error', request, scopeKey: scope, message: ipcErrorLine(error) || 'Search failed' })
    }
  }, [])

  const onAction = useCallback(
    (action: FilesSearchViewAction) => {
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
    },
    [run]
  )

  // Opening the box, or asking for it again, picks the mode and focuses the input.
  useEffect(() => {
    dispatch({ type: 'mode', mode: openRequest.mode })
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [openRequest.mode, openRequest.nonce])

  // Another thread or project: the rows are not its rows.
  useEffect(() => {
    dispatch({ type: 'scope-changed', scopeKey })
  }, [scopeKey])

  // Quick open searches as you type, after a short pause.
  useEffect(() => {
    if (state.mode !== 'files' || state.scopeKey !== scopeKey) return
    const timer = window.setTimeout(() => void run(stateRef.current), FILES_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [state.mode, state.query, state.scopeKey, scopeKey, projectId, threadId, run])

  // While the index builds, ask again for a fuller answer.
  useEffect(() => {
    if (state.status !== 'indexing') return
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
  }, [state.status, state.request, state.mode, run])

  useEffect(() => {
    rootRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [state.selected, state.files, state.groups])

  return (
    <div ref={rootRef} className="files-search-host">
      <FilesSearchView
        state={state}
        onAction={onAction}
        onOpenFile={(path) => onOpenFile(path, state.mode === 'files')}
        onOpenLine={onOpenLine}
        onClose={onClose}
        inputRef={inputRef}
      />
    </div>
  )
}
